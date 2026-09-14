# kg-mcp — v1 implementation plan

**Plan version:** 1.9 · **Date:** 2026-09-14 · **Companion to:** reference spec v0.9.3 (`kgmem init` creates a workspace and never reads content; `kgmem reflect` exits 4 on an extraction outage (§14.15 resolved))
**Convention:** every module and phase cites the spec sections it implements. Where this plan makes a call the spec left open, the call is marked **[commit]** with rationale and, where cheap, a port boundary so it can be reversed.

## 1. v1 scope and non-goals

**v1 is the walking skeleton, daily-drivable:** referent index + ingest port + full write path + Mode A/B retrieval + taint + MCP tools + ambient hooks + commit-clock decay + reflector + eval harness. This is exactly the slice the spec's own gating implies, and A11 (§8.9) is the license to ship it without the consolidator: cluster-and-link is the *natural* young-graph state, so v1 running consolidator-less is spec-correct behavior, not a cut-down.

**Explicit non-goals for v1** (built behind seams, §7 of this plan): consolidator and identity claims (§8.2–8.4), documents (A9), grouping claims / concept vertical (A10), Mode C traversal (§7.3), batch-separation sweep (§8.4 L2). Day-one obligations that do NOT defer: the taint set (§4.3 — "cannot be retrofitted"), stage-0 dedupe, atomic evidence increments, full pipeline logging (§5.8), facet-centroid maintenance (§3.1 — O(1) writes now, traversal later), and the A14/A15 plumbing — widened adjudicator output (distribution + overlap bucket + decomposable flag; argmax applied), `channel`/`agent` provenance fields, and the claim×cluster counter table with flat gains behind flags (§4.6–4.7: retrofit the rule later, not the data).

**Correction:** "documents (A9)" is only partly deferred. Its ingest-and-extraction half landed as an unnumbered phase (E1–E7, §5) ahead of this list — chunking, the extraction drain, and a real `Extractor` all exist and run through P2's ingest port. What remains a seam-only non-goal is document *serving*: doc health, the revision queue, propose-diff, and the `STATED_IN` edge (§7.7) — none of which are wired.

## 2. Stack commitments

| Decision | [commit] | Rationale / port |
|---|---|---|
| Language / runtime | TypeScript, Node ≥ 22, ESM, strict tsconfig | schema-first Zod workflow; spec §3.5/§10 compile nearly verbatim |
| Store | **v1 local recipe, potentially temporary:** SQLite via `better-sqlite3` + `sqlite-vec`, WAL mode | chosen on what is known (embedded, transactional, atomic α/β increments, multi-process via WAL, in-process vectors) — not on workload, which is unmeasured. Entities/CONTAINS tables are materialized referent indexes with `rebuild-index`; the store never parses or queries `locator`. **Port:** `GraphStore` — nothing above it may assume SQLite. Final system must support hosted/enterprise recipes and billions of claims; migration = ledger export → import → rebuild (§11) |
| Process model | **No daemon in v1.** MCP server runs as a stdio process per session (Claude Code spawns it); hooks shell out to the same binary; all processes share the SQLite file under WAL | defers the daemon (§11) without violating it — the "internal serving/ingest API" is a library both adapters import; a long-lived daemon becomes a v1.x wrapper, not a redesign. Calendar clock runs as `kgmem jobs run` under cron/launchd |
| MCP | official `@modelcontextprotocol/sdk`, stdio transport | tools per §10: `query`, `observe`, `contradict`, `drill_down` |
| Adjudicator | Anthropic API, small fast model (configurable model string), structured output via tool-use against Zod schemas | **Port:** `Adjudicator` interface with a replay/fixture implementation for tests — no live API in the test suite |
| Embeddings | **Port:** `EmbeddingProvider`. Default: local ONNX via transformers.js, `nomic-embed-text-v1.5` at 512d (Matryoshka — spike S2 pinned this, not the 256d assumed here originally; see §4), int8-quantized in-store, f32 retained at native 768d for rerank (§11) | zero per-write network dependency; spike S2 done. API provider (e.g. a code-tuned embedder) as config alternative |
| Noun-source emitter | **separate package, outside core:** web-tree-sitter over TS/TSX emitting existence/containment/structural claims through the ingest port; a git change-feed emitter alongside | core contains no parser or grammar; one language is enough to drive v1 trials on real repos **[Rejected 2026-09-13: no codebase parser or emitter package is planned. Ingestion is substrate agnostic — content enters through `kgmem ingest`, whatever its kind.]** |
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
  referents/     §3.1, §5.2  resolution ladder, coreference + mention index, provisional
                             referents, facet centroid maintenance (no parser here)
  ingest/        §5, §4.5    ingest port: claims + change-feed events from external emitters
  extract/       §5.10,      chunk/embed/anchor/enqueue, the extraction drain +
                 §5.11, §9   verbatim gate, `Extractor` port + `AnthropicExtractor`
                             adapter (E1–E7, done — no numbered phase; see §5)
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

- **S1 — adjudicator accuracy [the big one]. Open — the gate on P3.** Hand-label ~60 claim pairs from a real repo (duplicates, supports, contradicts incl. hard polarity flips, refines, kind-compatibility traps from §5.4). Measure verdict accuracy of the small model with the v1 prompt. **Gate:** ≥90% on polarity-critical pairs before Phase 3 builds on it; below that, iterate prompt / escalate model tier before proceeding. The worksheet of 60 hand-labelled pairs is harvested and awaits labelling (still all 60 empty as of E9a). S2's finding raises the stakes on this gate: cosine distance cannot tell a claim from its negation at all, so the adjudicator is the only thing standing between the pipeline and that failure — S1 measures whether it can. E9a (§5 below) raises a second stake on the same gate: an unconfigured rung 4 and a genuinely undecided configured adjudicator mint an indistinguishable referent today, so trusting rung 4's tiebreak population is a second, currently-unanswered question P3 inherits alongside verdict accuracy.
- **S2 — embedding provider. Done.** nomic at 768d/512d/256d/128d/64d on real fixtures: the rate at which unrelated same-repo text clears the §5.3 0.70 candidate floor — 7.1% / 8.3% / 12.3% / 24.4% / 40.4% respectively — plus §5.2 gloss-resolution MRR. Pinned **512d**, not the 256d this plan assumed: indistinguishable from full width on the distractor rate and marginally better on gloss resolution (MRR 0.968 vs 256d's 0.963), where 256d admits roughly 50% more junk for a storage saving irrelevant at this corpus size. Polarity-flip separation measured **0.000 AUC** — cosine distance cannot separate a claim from its negation at any width; that finding is now S1's problem, not this spike's. **Correction:** dimensionality does not pin store migration 0 as final, as this plan assumed. The store keeps a native-768d f32 rerank copy per claim (§11); narrowing the ANN index later is a slice-and-renormalize index rebuild off that copy, verified exact to float32 epsilon — only *widening* the ANN width needs the model.
- **S3 — sqlite-vec at scale. Open.** Synthetic 100k claims: ANN latency (scoped and global); SessionStart locator-map build on a large repo — **gate: ≤200 ms ⚙** — with per-call lookups trivially sub-ms in-process (§7.6).

## 5. Phases

Sizing: S ≈ a session, M ≈ a few, L ≈ many. Each phase ends green: typecheck, tests, and the exit criterion demonstrably true.

**P0 — scaffold (S).** pnpm, strict tsconfig, vitest, tsup, CI. `schema/` compiled from spec §3.5/§10 with round-trip fixture tests. *Exit: schemas parse the spec's own examples.*

**P1 — store (M).** Migrations for entities/claims/edges/provenance/episodes/events/taint/jobs/adjudication-log/pathway-counters + vec virtual table; A16 naming from migration 0 (`locator` nullable opaque text — never indexed or queried by the store; levels validated as data; `artifacts`/`changeEvents`); `GraphStore` port; atomic evidence ops; WAL + busy-timeout; multi-process concurrency test (two processes hammering one claim's α — zero lost updates, §5.7). *Exit: concurrency test passes; store API is the only SQL in the codebase.*

**P2 — referents + ingest port (M). Status: core done.** The ingest port (claims and change-feed events in); resolution ladder as coreference candidate retrieval; unresolved mentions mint provisional existence claims (invisible until corroborated); coreference + mention indexes materialized from existence/identity claims, `rebuild-index` proving derivability; deterministic content-hash ids for attested claims; `claims.scope` FK dropped, existence claims self-anchored, `level` nullable; three store methods: findEntitiesByName, searchEntitiesByGloss, updateEntityFacets; facet O(1) updates; tsup copy step for migration SQL; PreToolUse = SessionStart-built in-memory locator map in the hook adapter. **Primary exit test:** `noun-emergent.test.ts` — a referent layer grown purely from claim usage, no emitter, loads, resolves and serves. **`kgmem init [path]` shipped 2026-09-13:** it creates `.kgmem/` with a migrated empty store and an empty configuration, and never reads the directory's content — content enters only through `kgmem ingest` (and, for claims, `reflect`). No parser or emitter package is planned: ingestion is substrate agnostic, so a directory of notes and a code directory enter by the same door. *Exit: met for the write path — `kgmem init` then `kgmem ingest` on a real directory yields a referent index from claim usage alone.*

**Post-review fixes (F1–F9). Done.** Nine fixes, closing defects review surfaced in the P1/P2 work above, across `store`, `referents`, and `ingest` — 285 tests green on `referents`+`ingest`, 760 on `store`. **F1** replaced the ANN-KNN probe behind `listClaimIds`/`listEntityIds` — capped at 4096 and silently truncating past it, so referents began vanishing at roughly 2,048 and `rebuild-index` rebuilt an arbitrary subset — with a real keyset-paginated scan that drains to exhaustion. **F2** made naming itself a claim: content-addressed, one per `(referent, surface form)`, corroborated as ordinary evidence under §4.2's episode cap; the mention index's `mentions` column became a `weight`. F1 and F2 were prerequisites for the noun-source emitter — both changed what the ledger records, and both would have been far more expensive to change once a real repository's claims existed under the old shape. That gate has now lifted. **F3** refuses an A15 pathway signature no provenance axis can carry. **F4** escalates the resolution ladder on plurality at the same strength instead of taking the first candidate. **F5/F6** made retraction reach every referent a form names, and seed its successor from the retired evidence claim behind it rather than the bare prior. **F7** wired §3.1's O(1) facet maintenance into the write path — it had store operations but no caller. **F8** renamed taint's key from session to episode, ratifying what the SQL already did. **F9** stopped a null containment level from unplacing a child, and made a retired containment claim take its edge with it.

**Text ingest and extraction (E1–E7). Done — no numbered phase.** §5.10's universal ingress arrived early and out of the P-sequence, on its own track: paragraph-bounded chunking, `submitText` (chunk, embed, anchor, one job enqueued per chunk, `documents`/`document_chunks` and their jobs written atomically), the extraction drain (`openExtraction`, byte-exact claim-with-quote — no trim, case fold, or whitespace normalization), two `TextSource` adapters (`documentSource` for files, `transcriptSource` for sessions — the half of §5.11 shared with backfill), and `kgmem ingest`/`kgmem reflect` CLI wiring. **E7** supplied the first real `Extractor`, `AnthropicExtractor` — one Messages-API call per chunk forcing `record_claims` — plus what capping the drain's retries safely required: `MAX_ATTEMPTS = 5` and `GraphStore.requeueJob`/`JobNotRequeueableError` to revive a parked job, since `claimJob` only ever selects `state = 'pending'` and parking was otherwise terminal. A truncation guard refuses a tool call `stop_reason: 'max_tokens'` cut off mid-write, because a partial `input` can still parse as a valid, shorter claims array. This is only the ingest-and-extraction half of A9/A17: extracted claims are submitted through P2's ingest port with no adjudication — they land `provisional`, same as any other claim, and wait on P3 for verdicts — and `STATED_IN`, doc health, and the revision queue (§7.7) are still unbuilt. Extraction quality was unmeasured when this phase closed — every test injected `fetch`, and no chunk had reached the live API. E8, below, closes that gap.

**Live extraction runs (E8). Done — no numbered phase.** E7d (2026-09-06) was the first live call against `AnthropicExtractor`: one authored document, 23 chunks, 37 API calls, $0.1767, and it found what three fix cycles closed. **E8a** — `NomicEmbeddingProvider` defaulted to the ANN index's 512d width rather than the store's persisted 768d width, failing `kgmem ingest` on every fresh install; fixed by defaulting to the stored width. **E8b** — the prompt sanctioned an empty `mentions` list that `ClaimMessage`'s `.min(1)` then rejected; the throw aborted the proposal loop mid-batch, starving the rejection log of a genuine verbatim failure sitting beside it and duplicating eight already-committed member rows on retry; fixed with a `mentionsAbsent` rejection reason, a `doorRefusalFor` predicate that gates a proposal before any I/O, and a prompt rewrite. **E8c** — 35 of 225 proposals came back tiered `observed` from a document with no tool output anywhere, because `inferred` was defined by the *shape* of the writing ("an argument, a conclusion, an explanation") rather than by what produced the quoted text, leaving a flat declarative sentence — most of a document — belonging to no rung and resolving upward toward the rung whose name also means *I can see it*; fixed by defaulting both message tiers to `inferred` and rewriting the tier section around provenance of text, not grounds. E8d re-ran the identical 23 chunks after all three fixes: 23/23 chunks completed (was 19/23), zero mistiered proposals (was 35/225), zero duplicate rows (was 8), zero retries, $0.1130 (was $0.1767) — fewer unique proposals landed (101 vs. 167) but more distinct member claims survived (100 vs. 92). **Extraction quality is measured for document-chunk extraction now**; the gate itself still cost one verbatim rejection per run — a resolved pronoun in E7d, a one-character sentence-case change at a span boundary in E8d (§14.16, a recorded cost of the byte-exact ruling, not a new defect). The transcript-chunk side of the tier rubric (§5.11) has no live run yet.

**Silent-mint fix (E9a). Done — no numbered phase.** On a fresh install with no `models.adjudicator` configured, §5.2's rung 4 — reached only on a genuine plurality of equal-strength candidates — was handed a stub whose `tiebreakReferent` *rejected* with `UnconfiguredPortError`. `ladder.ts` awaits that call with no surrounding `catch`, so the rejection propagated out of `ingest.submit()` mid-write; because `submit` is not transactional, an ambiguous second mention left its referent and naming claim committed with no claim row to show for them. `kgmem reflect`'s drain classified the rejection as transient, so a default install burned a retry per chunk per run under exit code 0 until the retry cap parked every chunk for good — silently mining nothing. Renamed `decliningAdjudicator`, the stub now resolves `{ outcome: 'unresolved' }` instead — §5.2's own ruling for a rung with nobody to ask, which the code had been contradicting rather than leaving open. A mutation pass found every pre-existing fixture adjudicator declines by default, bit-for-bit the unconfigured stub's own verdict, so a mutant discarding a configured `models.adjudicator` outright had survived all 93 tests across eight files; closed with a new resolving fixture. **Left open, and harder than the crash (§14.19):** rung 4's outcome records only the rung reached and the referent minted, nothing marking *why* the tiebreak declined — an unconfigured stub and a configured model that genuinely could not choose are indistinguishable after the write. This sits on the same critical path as S1 above: neither the adjudicator's measured accuracy nor rung 4's honesty about *why* it minted is settled before P3 builds on the referent population both produce.

**P3 — write path (L, the heart).** Stages 0–7 as a pure decision core (state in, mutations out) with an effects layer; replay-fixture adjudicator; evidence weights incl. taint + A1 exemption; dispute check incl. A2; **§6.2 matrix as the table-driven test suite** — every cell a case; property tests on evidence math (posterior bounds, cap idempotence, decay-toward-prior). Full stage logging from the first commit of this phase. *Exit: matrix suite green; S1 gate passed; a hand-fed episode produces correct graph mutations end-to-end.*

**P3 also inherits three open items from spec §14**, left unresolved by F1–F9 and due a verdict from the matrix rather than a standalone fix: a deprecated containment claim that was the only thing placing a usage-born child leaves the live view holding a level a rebuild reads as `null`; `setClaimStatus` is public on the port and a direct `deprecated`/`archived` transition bypasses containment cleanup — nothing does this today, but §6.1's archive is a concept P3 needs, and archiving a containment claim would reproduce the drift F9 fixed; and containment retirement costs O(ledger) — 697 ms against a 100k-claim ledger after optimisation, down from 4,900 ms — unpaid, since no v1 production path retires a containment claim.

**P4 — retrieval + MCP (M).** Anchor → three bands → score → pack; rivals-together; disputed-served-flagged; taint recording at serve time; posterior width in every served claim; band shares (containment only); the four MCP tools; wire into Claude Code. *Exit: in a live Claude Code session, `query` about your repo returns claims you recognize as true, with sane confidence annotations.*

**P5 — harness (M).** Replay runner over the P3 logs (threshold tuning per §5.8/§15); A/B task runner: seeded tasks on a fixture repo, memory-on vs memory-off, success + time; adjudicator drift audit script. *Exit: first A/B numbers recorded — even if they're humbling; that's the point.*

**P6 — ambient transports (M).** `kgmem hook serve` (SessionStart / UserPromptSubmit / PreToolUse) + `hook capture` (PostToolUse / Stop) with shared session identity → taint (§7.5-as-amended); push budget + canonical-only defaults (canonical = every active claim for now, honestly labeled); verification-task routing from captured test runs (§5.9); Claude Code hooks config committed as a template. *Exit: a session with zero explicit tool calls still receives relevant claims and still logs a complete episode.*

**P7 — commit clock (S).** `kgmem githook` post-commit: churn decay toward prior, neighbour expansion on verified contradictions (A3), decay-then-refine flow verified by test. *Exit: committing a change to a provenance file measurably widens the affected posterior.*

**P8 — reflector (M). Status: extraction half done and measured against a document (E1–E8); episode-log half open** — `kgmem reflect` today drains parked chunks through `AnthropicExtractor`; nothing yet turns a live session's episode log into a `transcriptSource` of its own accord. Episode log → candidate claims through the normal pipeline; prompt as a versioned artifact with its own fixture suite (episodes in, expected claims out) — `EXTRACTION_PROMPT` exists, is reviewable, and has two live runs behind it (E8), but only against an authored document's chunks, not yet a transcript's own; taint-zeroing of restatements verified. *Exit: end an actual work session, run `kgmem reflect`, and at least one extracted claim is something you'd have written yourself — and nothing extracted is an echo.*

**v1 done = P0–P8 + §8 below.** Suggested first live subject: run it against one of your own active repos from day P2, so every phase's exit criterion is checked against reality rather than fixtures alone.

## 6. Testing strategy

TDD throughout; the spec supplies the tables. Priorities in order: (1) §6.2 matrix — table-driven, exhaustive; (2) evidence math property tests (fast-check): posteriors ∈ (0,1), decay monotone toward prior, caps idempotent, taint exemption only fires on fresh verified provenance; (3) pipeline decision core tested pure (no store, no network); (4) store concurrency test as a permanent fixture; (5) replay fixtures: every S1 labeled pair becomes a regression test; (6) no mocks of the store — real SQLite `:memory:`; the only faked boundary is the two ports (Adjudicator, EmbeddingProvider).

Known gap: `ledger-scan.test.ts` intermittently skips 4 tests on a full-store run — its ~5.2s `beforeAll` fixture loses against vitest's default 10s `hookTimeout` under worker contention. A config fix, not yet made.

## 7. Deferred features and their seams (so v1.x slots in, not bolts on)

| Deferred | Seam that exists in v1 |
|---|---|
| Consolidator + identity claims (§8.2–8.4) | `jobs/` slot; `MERGES`/identity tables in migration 0 (empty); serving already reads "canonical" as a flag |
| Documents (A9) | ingest + extraction real and wired (E1–E7: chunking, drain, `AnthropicExtractor`); `STATED_IN` edge type still reserved and unwritten; the store's actual document row (`DocumentRecord`) diverges from the compiled `DocumentNode` schema in two unresolved ways (`docKind`, `title`); doc health, revision queue, and propose-diff (§7.7) unbuilt |
| Concepts (A10) | `INSTANCE_OF`/`SPECIALIZE` reserved; concept band share exists in config, weight 0 |
| Mode C traversal (§7.3) | facet centroids already maintained; `modes:["traverse"]` returns NOT_IMPLEMENTED cleanly |
| Soft updates (A14, §4.6) | distributions + buckets logged from P3; rule behind `soft_updates` flag, harness-validated |
| Pathway saturation (A15, §4.7) | provenance fields + counter table live from P1; gains flat behind `pathway_saturation` |
| Backfill (A17, §5.11) | channel enum reserved; `kgmem backfill` CLI slot; ships post-v1 as the onboarding feature |
| Store recipes + migration (§11) | `GraphStore` port; ledger export/import at raw fidelity; `rebuild-index`; query-shape logging (hop depth, fan-out, latency per query class) from P4 — the swap trigger to Kùzu or a hosted store |
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
