# kg-mcp — v1 implementation plan

**Plan version:** 1.0 · **Date:** 2026-08-22 · **Companion to:** reference spec v0.2.1
**Convention:** every module and phase cites the spec sections it implements. Where this plan makes a call the spec left open, the call is marked **[commit]** with rationale and, where cheap, a port boundary so it can be reversed.

## 1. v1 scope and non-goals

**v1 is the walking skeleton, daily-drivable:** parsed spine + full write path + Mode A/B retrieval + taint + MCP tools + ambient hooks + commit-clock decay + reflector + eval harness. This is exactly the slice the spec's own gating implies, and A11 (§8.9) is the license to ship it without the consolidator: cluster-and-link is the *natural* young-graph state, so v1 running consolidator-less is spec-correct behavior, not a cut-down.

**Explicit non-goals for v1** (built behind seams, §7 of this plan): consolidator and identity claims (§8.2–8.4), documents (A9), grouping claims / concept vertical (A10), Mode C traversal (§7.3), batch-separation sweep (§8.4 L2). Day-one obligations that do NOT defer: the taint set (§4.3 — "cannot be retrofitted"), stage-0 dedupe, atomic evidence increments, full pipeline logging (§5.8), and facet-centroid maintenance (§3.1 — O(1) writes now, traversal later).

## 2. Stack commitments

| Decision | [commit] | Rationale / port |
|---|---|---|
| Language / runtime | TypeScript, Node ≥ 22, ESM, strict tsconfig | schema-first Zod workflow; spec §3.5/§10 compile nearly verbatim |
| Store | SQLite via `better-sqlite3` + `sqlite-vec` for ANN, WAL mode | embedded (§11); synchronous API matches the sync write path; atomic increments are single `UPDATE … SET alpha = alpha + ?` statements (§5.7); WAL gives multi-process sharing. **Port:** `GraphStore` interface — Kùzu stays a swap, not a rewrite |
| Process model | **No daemon in v1.** MCP server runs as a stdio process per session (Claude Code spawns it); hooks shell out to the same binary; all processes share the SQLite file under WAL | defers the daemon (§11) without violating it — the "internal serving/ingest API" is a library both adapters import; a long-lived daemon becomes a v1.x wrapper, not a redesign. Calendar clock runs as `kgmem jobs run` under cron/launchd |
| MCP | official `@modelcontextprotocol/sdk`, stdio transport | tools per §10: `query`, `observe`, `contradict`, `drill_down` |
| Adjudicator | Anthropic API, small fast model (configurable model string), structured output via tool-use against Zod schemas | **Port:** `Adjudicator` interface with a replay/fixture implementation for tests — no live API in the test suite |
| Embeddings | **Port:** `EmbeddingProvider`. Default: local ONNX via transformers.js, `nomic-embed-text-v1.5` truncated to 256d (Matryoshka), int8-quantized in-store, f32 retained for rerank (§11) | zero per-write network dependency; spike S2 validates. API provider (e.g. a code-tuned embedder) as config alternative |
| Parser | `tree-sitter` native bindings; TypeScript/TSX grammars first | spine levels `module`/`symbol` (§3.1); one language is enough to drive v1 on real repos |
| Jobs / calendar clock | SQLite-backed `jobs` table + `croner` in-process scheduler inside `kgmem jobs run` | no external infra; jobs are idempotent rows, matching §9 |
| Episode log | SQLite tables (`episodes`, `episode_events`), not JSONL | transactional with taint and evidence; the reflector and replay harness read the same source of truth (§5.9, §13) |
| Testing | vitest + fast-check; real in-memory SQLite in tests (no store mocks) | §6.2 matrix as a table-driven test; property tests for evidence math |
| Repo | single package, pnpm, `tsup` build, one `kgmem` bin with subcommands (`init`, `mcp`, `hook serve`, `hook capture`, `githook`, `jobs run`, `reflect`, `harness`) | monorepo split is a later refactor if ever needed |

## 3. Repository layout → spec map

```
src/
  schema/        §3.5, §10   Zod: Entity, Claim, edges, tool i/o — the spec compiled
  store/         §11, §5.7   GraphStore port + sqlite adapter, migrations, vec index
  evidence/      §4          Beta math, weights, taint, churn decay, caps
  spine/         §3.1, §5.2  tree-sitter ingest, file→entity map, resolution ladder,
                             alias feeding, facet centroid maintenance
  pipeline/      §5          stages 0–7 as a pure state machine + effects layer;
                             adjudicator port; verdict application; dispute check
  lifecycle/     §6          status transitions (the §6.2 matrix, one module)
  retrieval/     §7.1–7.2,   anchor, three-band gather, scoring, packing,
                 §7.4–7.5,   rivals-together, serve-once dedup, taint recording,
                 §7.8        band shares (containment bands only in v1)
  serving/       §7.6, A8    shared serve layer both MCP and hook adapters call
  adapters/
    mcp/         §10         stdio server, four tools
    cli/         §7.6, §5.9  hook serve (SessionStart/UserPromptSubmit/PreToolUse),
                             hook capture (PostToolUse/Stop), githook (§4.5)
  jobs/          §9          scheduler, TTL sweep, re-verification sampler,
                             facet re-cluster; (consolidator slots here later)
  reflector/     §5.9, §14.5 episode-log → candidate claims; prompt as versioned artifact
  harness/       §13         replay runner, A/B task runner, drift audit
  observability/ §5.8        stage logging, adjudication log
```

Every exported function carries a `@spec §x.y` docblock tag; drift between code and spec is a lint error waiting to be written (later).

## 4. De-risking spikes (before Phase 3 completes)

The spec's riskiest assumptions are empirical (plan follows its own advice: front-load them).

- **S1 — adjudicator accuracy [the big one].** Hand-label ~60 claim pairs from a real repo (duplicates, supports, contradicts incl. hard polarity flips, refines, kind-compatibility traps from §5.4). Measure verdict accuracy of the small model with the v1 prompt. **Gate:** ≥90% on polarity-critical pairs before Phase 3 builds on it; below that, iterate prompt / escalate model tier before proceeding.
- **S2 — embedding provider.** nomic-256d-int8 vs one API alternative on the same repo: dedupe-candidate recall@15 (§5.3) and gloss-resolution accuracy (§5.2). Pins dimensionality → store migration 0 is final.
- **S3 — sqlite-vec at scale.** Synthetic 100k claims: ANN latency (scoped and global), and the PreToolUse pure-lookup path p95 — **gate: <15 ms** or the ambient hook design (§7.6) needs a cache layer earlier than planned.

## 5. Phases

Sizing: S ≈ a session, M ≈ a few, L ≈ many. Each phase ends green: typecheck, tests, and the exit criterion demonstrably true.

**P0 — scaffold (S).** pnpm, strict tsconfig, vitest, tsup, CI. `schema/` compiled from spec §3.5/§10 with round-trip fixture tests. *Exit: schemas parse the spec's own examples.*

**P1 — store (M).** Migrations for entities/claims/edges/provenance/episodes/events/taint/jobs/adjudication-log + vec virtual table; `GraphStore` port; atomic evidence ops; WAL + busy-timeout; multi-process concurrency test (two processes hammering one claim's α — zero lost updates, §5.7). *Exit: concurrency test passes; store API is the only SQL in the codebase.*

**P2 — spine (M).** tree-sitter ingest for TS; deterministic file→entity map; `CONTAINS` + structural edges; gloss embeddings; resolution ladder with triage table; facet centroid O(1) updates. `kgmem init` on a real repo. *Exit: `kgmem init` on one of your repos produces a browsable spine; PreToolUse lookup path returns in <15 ms (S3 gate).*

**P3 — write path (L, the heart).** Stages 0–7 as a pure decision core (state in, mutations out) with an effects layer; replay-fixture adjudicator; evidence weights incl. taint + A1 exemption; dispute check incl. A2; **§6.2 matrix as the table-driven test suite** — every cell a case; property tests on evidence math (posterior bounds, cap idempotence, decay-toward-prior). Full stage logging from the first commit of this phase. *Exit: matrix suite green; S1 gate passed; a hand-fed episode produces correct graph mutations end-to-end.*

**P4 — retrieval + MCP (M).** Anchor → three bands → score → pack; rivals-together; disputed-served-flagged; taint recording at serve time; posterior width in every served claim; band shares (containment only); the four MCP tools; wire into Claude Code. *Exit: in a live Claude Code session, `query` about your repo returns claims you recognize as true, with sane confidence annotations.*

**P5 — harness (M).** Replay runner over the P3 logs (threshold tuning per §5.8/§15); A/B task runner: seeded tasks on a fixture repo, memory-on vs memory-off, success + time; adjudicator drift audit script. *Exit: first A/B numbers recorded — even if they're humbling; that's the point.*

**P6 — ambient transports (M).** `kgmem hook serve` (SessionStart / UserPromptSubmit / PreToolUse) + `hook capture` (PostToolUse / Stop) with shared session identity → taint (§7.5-as-amended); push budget + canonical-only defaults (canonical = every active claim for now, honestly labeled); verification-task routing from captured test runs (§5.9); Claude Code hooks config committed as a template. *Exit: a session with zero explicit tool calls still receives relevant claims and still logs a complete episode.*

**P7 — commit clock (S).** `kgmem githook` post-commit: churn decay toward prior, neighbour expansion on verified contradictions (A3), decay-then-refine flow verified by test. *Exit: committing a change to a provenance file measurably widens the affected posterior.*

**P8 — reflector (M).** Episode log → candidate claims through the normal pipeline; prompt as a versioned artifact with its own fixture suite (episodes in, expected claims out); taint-zeroing of restatements verified. *Exit: end an actual work session, run `kgmem reflect`, and at least one extracted claim is something you'd have written yourself — and nothing extracted is an echo.*

**v1 done = P0–P8 + §8 below.** Suggested first live subject: run it against one of your own active repos from day P2, so every phase's exit criterion is checked against reality rather than fixtures alone.

## 6. Testing strategy

TDD throughout; the spec supplies the tables. Priorities in order: (1) §6.2 matrix — table-driven, exhaustive; (2) evidence math property tests (fast-check): posteriors ∈ (0,1), decay monotone toward prior, caps idempotent, taint exemption only fires on fresh verified provenance; (3) pipeline decision core tested pure (no store, no network); (4) store concurrency test as a permanent fixture; (5) replay fixtures: every S1 labeled pair becomes a regression test; (6) no mocks of the store — real SQLite `:memory:`; the only faked boundary is the two ports (Adjudicator, EmbeddingProvider).

## 7. Deferred features and their seams (so v1.x slots in, not bolts on)

| Deferred | Seam that exists in v1 |
|---|---|
| Consolidator + identity claims (§8.2–8.4) | `jobs/` slot; `MERGES`/identity tables in migration 0 (empty); serving already reads "canonical" as a flag |
| Documents (A9) | `STATED_IN` edge type reserved; `DocumentNode` schema compiled but unwired |
| Concepts (A10) | `INSTANCE_OF`/`SPECIALIZE` reserved; concept band share exists in config, weight 0 |
| Mode C traversal (§7.3) | facet centroids already maintained; `modes:["traverse"]` returns NOT_IMPLEMENTED cleanly |
| Batch separation (§8.4 L2) | differential-verdict β (L1) ships in P3 — it's write-path logic; only the calendar sweep defers |

## 8. Definition of done for v1

1. Daily-drivable: your default Claude Code sessions on a real repo run with hooks + MCP enabled, and you *keep them enabled* after a week.
2. First A/B numbers exist and are written down, whatever they say.
3. Every §12 day-one mitigation is live and tested: taint, dedupe, atomic increments, rivals-together, unconditional verified dispute.
4. All thresholds read from config with spec-§15 defaults; every pipeline decision logged replay-ready.
5. Spec back-annotation pass done: anything implementation contradicted or refined becomes a spec amendment (A14+), not silent drift.

## 9. First-session checklist

1. `pnpm init` scaffold, strict tsconfig, vitest, tsup, `kgmem` bin stub.
2. Port §3.5 + §10 Zod blocks into `src/schema/` verbatim; fix what doesn't compile — first spec back-annotations usually appear here.
3. Write the §6.2 matrix as a typed test table with every case `todo`-marked — the empty suite *is* the P3 backlog.
4. Start S1: pull ~60 real claim pairs from a repo you know and start labeling — it parallelizes with everything else and gates the most.
