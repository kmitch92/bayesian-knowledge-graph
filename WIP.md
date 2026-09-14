# WIP — after E10: the write path runs from a clean checkout; the read path is next

**Status:** E7d–E9b as below, plus E10 (2026-09-13/14): `kgmem init` exists, and `kgmem reflect` exits 4 on an extraction outage. Nothing can read the graph yet — `kgmem mcp` is next.
**Companions:** reference spec v0.9.3 · v1 implementation plan 1.9

---

## E10 — a workspace from a clean checkout, and an outage that exits non-zero

- **`kgmem init [path]`** creates `.kgmem/` with a migrated empty store and `{"models":{}}` in the given directory (default: the working directory). It never reads the directory's content. Re-running over a complete workspace, or inside a directory that already belongs to one, reports that workspace and changes nothing; over a half-made `.kgmem/` it creates only the missing store or configuration. A missing path, a file path, or a file named `.kgmem` in the way exits 1. Before this, `kgmem ingest` failed on every fresh directory because nothing created `.kgmem/`.
- **`kgmem reflect`** exits 4 when at least one model call failed and none succeeded (spec §14.15, resolved). The tally line always ends with a failure count, e.g. `2 failed (2 will retry, 0 parked)`, and an exit-4 run adds a line quoting the last model error. A job parked before the model was asked counts as neither success nor failure.

---

## What E7d found, and what E8a–E8c fixed

E7d (2026-09-06) was the first live call against `AnthropicExtractor`: one authored document, 23 chunks, 37 API calls, $0.1767. It found three defects, fixed across three phases, then re-verified by a second live run, E8d, against the same 23 chunks:

- **E8a — embedding width.** `NomicEmbeddingProvider` defaulted to `PINNED_DIMENSIONS` (512, the ANN *index* width) while the store persists at `STORED_VECTOR_DIMENSIONS` (768) and derives the narrower copy itself. `kgmem ingest` failed on every fresh install. Fixed by defaulting the provider to `RERANK_DIMENSIONS` (`src/store/adapters/nomic-embedding-provider.ts`). The defect escaped because `embedBatch`'s actual output width — as opposed to the width the constructor *declares* — had no test at all; `emitted-embedding-width.test.ts` is what stands in front of that class of hole now, and its own docblock is the sharpest account of the gap.
- **E8b — the door-refusal cluster.** `EXTRACTION_PROMPT` told the model an empty `mentions` list was honest; `ClaimMessage.mentions` is `.min(1)` and threw. The throw aborted the proposal loop mid-batch, so later proposals in the same call were never gated (E7d's rejection log held zero rows despite a genuine verbatim failure sitting right beside the throw) and claims already committed earlier in the batch were re-submitted on retry (8 duplicate member rows). Fixed with a fourth rejection reason, `mentionsAbsent`; a `doorRefusalFor` predicate (`src/extract/extraction.ts`) that runs `ClaimMessage.safeParse` *before* any I/O, so a `StoreBusyError` still propagates as transient rather than being swallowed as a door refusal; and a prompt rewrite that demands at least one mention, shows what looking harder finds, and only then allows the empty-list escape hatch for a claim that truly names nothing.
- **E8c — tier inflation.** 35 of 225 proposals came back `observed` from a document containing no tool output anywhere. `ClaimMessage.tier` and `ContainmentMessage.tier` now default `inferred`; `AttestationMessage.tier` stays `verified` because its `source` is required, so the type itself is §3.1's act of attesting. The prompt's tier section was rewritten around *what produced the characters in the quote* — provenance of text — rather than *what the claim rests on*, which is a question a model answers by introspecting on its own grounds and always answers generously.

**E8d (same 23 chunks, 23 calls, $0.1130) confirms the fix, not just the intent:** zero proposals tiered `observed`, zero duplicate rows, 23/23 chunks completed against E7d's 19/23, zero retries. One verbatim rejection survived — a one-character sentence-case change at a span boundary, a different failure mode from E7d's single rejection (a resolved pronoun), and recorded in the spec (§14.16) as a measured cost of the gate's byte-exact reading, not a new defect. Full numbers, and the reference spec's back-annotation of them, are in v0.9.0 (§5.10, §5.11, §14).

**Where the evidence lives** (§8 below has the exact re-read commands): both workspaces — `/home/kiel/kgmem-live-e7d/` and `/home/kiel/kgmem-live-e8d/` — hold a `transcript.jsonl` of every request/response pair and a set of read-only Node scripts (`analyse.mjs`, `forensics.mjs`, `inspect.ts`, `sql.mjs`, and E8d additionally `cost.mjs`, `retries.mjs`, `spine.mjs`, `mentions.mjs`, `verbatim.mjs`) that re-derive every number above from the transcript and the committed `.kgmem/graph.db`, with no model and no key.

---

## What's still open, in priority order

### 1. Closed the crash (E9a); left a harder, silent problem open

E9a (2026-09-12, `0a7ae2d`/`040fd0f`) closed the bug this item used to describe: `refusingAdjudicator` (`src/adapters/cli/config.ts`) rejected with `UnconfiguredPortError` on the first mention that reached rung 4 on a fresh install — a plurality neither the mention index nor the gloss embedding could narrow — aborting `ingest.submit()` mid-write; because `submit` is not transactional, an ambiguity on a claim's second mention left the first mention's referent, naming claim and mention row committed with no claim row to show for them. `kgmem reflect`'s drain classified the rejection as transient, so every chunk burned a retry per run under an exit code of 0 until the retry cap parked it for good — a default install silently mining nothing. Renamed `decliningAdjudicator`, the stub now resolves `{ outcome: 'unresolved' }` — §5.2's own ruling for a rung with nobody to ask, back-annotated into the reference spec at v0.9.1 (§5.2, §14.19). Two wrong fixes are fenced by the tests that pin this: a `catch` at the ladder (mints a permanent duplicate referent on a *configured* adjudicator's mere timeout, needing §8.4's split to undo by hand) and a pre-flight `requirePort` for the adjudicator (refuses on every fresh install, reproducing E8a's own breakage). A mutation pass also found every pre-existing fixture adjudicator declines by default — bit-for-bit the unconfigured stub's own verdict — so a mutant discarding a configured `models.adjudicator` outright survived all 93 tests across eight files; closed with `resolving-adjudicator-module.ts`, a new fixture that resolves instead.

**What's open now is harder than the crash was, because the fix is silent by design.** Rung 4's outcome carries only the rung reached and the referent it produced — nothing marks *why* the tiebreak declined. An unconfigured stub and a configured model that looked at the same candidates and genuinely could not choose both mint an indistinguishable referent; closing the mutation-coverage gap above only worked because a *third*, resolving fixture had to be invented, which is itself evidence that no observation available at rung 4 tells the two apart. A default install therefore quietly accumulates provisional referents a configured adjudicator would have merged, with nothing recorded to say that absence is why, and the fact cannot be reconstructed from the ledger after the write — any future report of how many referents were minted for want of an adjudicator has to be captured at the write-time seam. Recorded as reference spec §14.19; no fix designed yet.

### 2. Prompt caching — landed and inert (E9b); the floor decision and `onUsage`'s production wiring are open

E9b (2026-09-13, `3d53b32` test / `2e6eadf` impl) shipped the shape change this item used to defer: `system` is now a one-block content list carrying `cache_control: { type: 'ephemeral' }` on that block, and the constructor gained an `onUsage` callback that Zod-parses the response's `usage` block and hands it over camelCased, with an absent field left absent rather than defaulted to `0` — an absent `cache_read_input_tokens` and a reported zero are different observations, and conflating them is how E7d and E8d's sixty calls between them went by at zero unnoticed. The chunk and drain context stay in `messages`, after the breakpoint, so the cached bytes are byte-identical across every chunk of every document. Neither change buys anything yet.

**The floor is 4,096 tokens, not the 1,024 this item previously recorded here — that figure was wrong.** `claude-haiku-4-5`'s minimum cacheable prefix is 4,096 tokens. `EXTRACTION_PROMPT` plus the tool schema measure about 2,798 tokens — a least-squares fit of `input_tokens` against user-message length across all 23 calls in the E8d transcript, cross-checked against the smallest observed call and the serialised request's byte length — roughly 1,300 short of the floor. Below it, Anthropic serves the request exactly as if unmarked and reports no error, so today's marker changes nothing about the bill. Recorded in the spec at §14.20. Two things follow, neither decided:

1. **Whether to close the gap, and how.** Padding the prompt past 4,096 tokens grows this system's one reviewable artefact for a purpose unrelated to extraction quality; batching several chunks per call bills the fixed prefix fewer times rather than more cheaply per call; a lower-floor model is blocked today by spec §14.12 (model choice is not reachable from `.kgmem/config.json`); leaving the marker inert and paying the full prefix on every call is the default until one of the other three is chosen.
2. **`onUsage` is unwired in production.** `scripts/live-anthropic-reflect.sh`'s `--print-extractor-module` mode (line 334) still emits `export default () => new AnthropicExtractor();` — no options, so no callback — so the next paid run through this script would report exactly as little about its own billing as E7d and E8d did. The figures E9b makes reachable are not yet observed anywhere a live run would produce them.

### 3. `temperature` is unset (defaults to 1.0)

Unchanged since E7 and untouched by E8a–E8c. The call site's own comment (`anthropic-extractor.ts`, in `extract()`) argues for leaving it at the API default: the verbatim gate grades output byte-for-byte, so sampling noise lands on `quote` — a coin flip on whether a claim survives — and picking a value with no replay data behind it would not be a considered choice, just a different guess. Two live runs now exist and both landed at most one verbatim rejection; whether that is temperature-insensitive luck or the first real data point for §13's replay audit to settle this on is exactly what a third run at a different temperature would tell you. Summarised here, not duplicated — the argument lives at the call site.

### 4. A distinct truncation error subclass

Unchanged. An HTTP failure, an unparseable body, an unreadable tool call, and a `max_tokens` mid-write truncation are all `AnthropicExtractorError`, same type, different message text. A job parked with "raise the output budget above 4096" is indistinguishable, to anything that groups `last_error` mechanically, from a job parked on a bad key. §13's audit wants its own arm for the tuning signal, not prose an operator has to read.

### 5. S1 labelling — independent of extraction, gates P3

`/home/kiel/dev/bayesian-knowledge-graph/fixtures/adjudicator-eval/s1-pairs.json` — 60 pairs, **all 60 `label` fields still empty** (checked directly against the file, not assumed). Human work. Needs labelling, then a measured run against the ≥90% polarity gate before Phase 3 builds on the adjudicator. Note item 1 above: the crash is fixed (E9a), but the silent-mint indistinguishability it left open means this labelling work and item 1's still-open question are on the same critical path to trusting rung 4 in production.

### 6. An extraction-quality corpus does not exist yet

The adjudicator has S1 for exactly this reason; extraction still has no equivalent regression baseline. E8c's RED for the tier-default fix proposed copying E7d/E8d's proposals and their source chunk texts into `/home/kiel/dev/bayesian-knowledge-graph/fixtures/extraction-eval/`, beside the existing `adjudicator-eval/` and `embedding-eval/` — a labelled baseline so the next run's inflation rate, mention-grounding rate, and rejection rate are a diff against a number rather than an impression. `/home/kiel/dev/bayesian-knowledge-graph/scripts/spike-s2-embeddings.ts` is the precedent for the script shape and fixture layout. Both live transcripts now exist to build it from — E8d's clean run makes a better baseline than E7d's, since it has no known defect polluting the numbers. Recording the proposal here; not building it.

### 7. Three older defects, carried forward — checked still real

1. **The drain matches a job to a chunk by ordinal, not hash.** `text.chunksOf(documentId).find((view) => view.ordinal === ordinal)` in `workChunk` (`src/extract/extraction.ts`) — the job's own payload (`ExtractJobPayload`) carries a `hash` field alongside `ordinal`, and `workChunk` destructures `{ documentId, ordinal, episodeId }`, silently dropping it. After a revision that deletes a paragraph *above* others, a job parked for `(ordinal 5, hash X)` is worked against whatever paragraph now sits at ordinal 5 — right job, wrong span, silently. Same family as the two E6 closed.
2. **`appendStageLog` is two statements under `#write`, not `#transaction`.** Confirmed still true, unchanged by E8: `s.ensureEpisode.run(entry.episodeId)` then `s.insertStageLog.run(...)`, both inside `this.#write('appendStageLog', () => {...})` — `#write` only translates SQLite busy errors, it does not wrap the pair atomically the way `#transaction` (`#write(what, this.#db.transaction(body))`, used by `putClaim`, `putEntity`, `putContainment`, and others) does. E6's ingest path is covered; every other caller is not.
3. **No `kgmem doctor`.** Still no command and no `json_extract` scan over `jobs.payload` anywhere in `src/` to repair a database damaged by the pre-E6 partial write. A chunk stored with no job is invisible to the enqueue rule, and no hash-keyed predicate finds it. Wants exactly that scan over the write path's own data, a fair price once, on demand.

### 8. Where the evidence lives, and how to re-read it

Both live workspaces are preserved outside this repo:

- **E7d** — `/home/kiel/kgmem-live-e7d/` (the defect-finding run: 23 chunks, 37 calls, $0.1767)
- **E8d** — `/home/kiel/kgmem-live-e8d/` (the confirming run: 23 chunks, 23 calls, $0.1130)

Each holds `transcript.jsonl` (every request/response pair, including `usage` blocks) and a `.kgmem/graph.db` this repo's own `openGraphStore` can open read-only. No API key and no network call is needed to re-derive any number in this file or in the spec's v0.9.0 entry — for example:

```
LOADER=$(cd /home/kiel/dev/bayesian-knowledge-graph && node -e '
  const {createRequire}=require("node:module");
  const {pathToFileURL}=require("node:url");
  process.stdout.write(pathToFileURL(createRequire(process.cwd()+"/").resolve("tsx")).href)')
node --import "$LOADER" /home/kiel/kgmem-live-e8d/inspect.ts   # rejection log, chunk count, queue state
node /home/kiel/kgmem-live-e8d/spine.mjs /home/kiel/kgmem-live-e8d/.kgmem/graph.db   # tier/duplicate breakdown
node /home/kiel/kgmem-live-e8d/cost.mjs /home/kiel/kgmem-live-e7d/transcript.jsonl   # cost against either transcript
```

`spine.mjs`, `cost.mjs`, and `retries.mjs` (E8d) take a path argument and work against either workspace's database or transcript; `analyse.mjs`, `forensics.mjs`, and `sql.mjs` (E7d) are hard-wired to their own workspace but the pattern is copy-and-repoint.

---

## First moves

1. Build `kgmem mcp` with `query` (spec §7): anchor resolution, claims at the anchor and its ancestors, ANN fallback, scoring, packing to a token budget, rivals served together, taint recorded at serve time.
2. Add `observe` to the same server, then run a live trial: Claude Code registered against a real workspace, asking questions and recording observations.
3. Still open from below: how rung 4 records why it declined (item 1), S1 labelling (item 5), the cache-floor decision and `onUsage` observed in a live run (item 2).
