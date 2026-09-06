# WIP — after E7: extraction is real, and unmeasured

**Status:** E7 done and committed. The `Extractor` port has a real, non-fixture adapter (`AnthropicExtractor`); nothing has run it live.
**Companions:** reference spec v0.8.0 · v1 implementation plan 1.6

---

## What E7 built

- `JobNotRequeueableError` and `GraphStore.requeueJob` — a public way to un-park a job the drain gave up on, landed *before* the retry cap so the cap has a recovery path from day one.
- The drain's retry cap: five attempts (`MAX_ATTEMPTS` in `/home/kiel/dev/bayesian-knowledge-graph/src/extract/extraction.ts`), then the job parks with a `last_error` naming the cap and `store.requeueJob` as the way back. Before this, a down extractor re-derived a document's whole chunking on every attempt, forever.
- `AnthropicExtractor` (`/home/kiel/dev/bayesian-knowledge-graph/src/extract/adapters/anthropic-extractor.ts`) — one POST to Anthropic's Messages API per chunk, a forced `record_claims` tool, and `EXTRACTION_PROMPT` as the reviewable artefact. Covered across 50 tests, all against an injected `fetch`.
- A guard against the one unreadable answer that doesn't look unreadable: a tool call cut off by `max_tokens` mid-write still parses as a shorter, well-formed claim list. Caught by checking `stop_reason` before `ToolInput.safeParse`, not after.
- `kgmem reflect` exercised end-to-end against the real adapter, offline (fixture request/response pairs, no network).

Read `anthropic-extractor.ts`'s head docblock and §5.10/§5.11 of the reference spec for the design reasoning; it isn't repeated here.

---

## What's still open, in priority order

### 1. E7d — the live call. Never run.

One small authored document, one `kgmem reflect`, then `readExtractionRejections(documentId)`. This is the first real measurement of whether the model can quote verbatim — everything E7 built has only ever been tested against a scripted `fetch`. It costs money (a real Anthropic API call), so it waits on the user's explicit word before it runs.

### 2. S1 labelling — independent of E7, gates P3.

`/home/kiel/dev/bayesian-knowledge-graph/fixtures/adjudicator-eval/s1-pairs.json` — 60 pairs, 30 polarity-critical, **all 60 `label` fields still empty** (verified directly, not assumed). Human work. Needs labelling, then a measured run against the ≥90% polarity gate before Phase 3 builds on the adjudicator.

### 3. Prompt caching — deferred, RED-first.

`EXTRACTION_PROMPT` (roughly 1.2k tokens) ships as the `system` string on every chunk. A 200-chunk document pays full input price 200 times instead of once at Anthropic's 1.25× cache-write rate plus 199 reads at ~10% of that. E7b's VERIFY pass pinned the `system` *parameter's value* but not its *shape* — today it's a plain string — so switching it to the `{ type: 'text', text: ..., cache_control: {...} }` array form is a RED that can be written before any implementation, at zero test churn against what exists.

**Caveat worth recording:** Claude Haiku's minimum cacheable prefix is 1024 tokens, and at roughly 1.2k tokens the prompt only just clears it. Trimming the prompt in a later pass could push it back under that floor and silently stop caching from applying at all — no error, just full price again.

### 4. `temperature` is unset (defaults to 1.0).

Judged a behaviour change, not a refactor, so E7 left it alone. The call site's own comment (`anthropic-extractor.ts`, in `extract()`) argues for leaving it at the API default: the verbatim gate grades output byte-for-byte, so sampling noise lands squarely on `quote` — a coin flip on whether a claim survives — and picking a value with no replay data behind it would not be a considered choice, just a different guess. The obvious counter-argument — a near-zero temperature would reduce exactly that sampling noise — is precisely the guess the comment declines to make blind. §13's replay audit is named as the tool meant to settle it once there's data to replay against.

### 5. A distinct truncation error subclass.

Today an HTTP failure, an unparseable body, an unreadable tool call, and a `max_tokens` mid-write truncation are all the same `AnthropicExtractorError` class — different message text, same type. A job parked with "raise the output budget above 4096" is indistinguishable, to anything that groups `last_error` mechanically, from a job parked on a bad key. "Raise the budget" is a tuning signal about chunk size and `MAX_TOKENS`; it deserves its own arm in §13's audit rather than living only in prose an operator has to read.

### 6. Three older defects, carried forward (checked still real)

1. **The drain matches a job to a chunk by ordinal, not hash** (`/home/kiel/dev/bayesian-knowledge-graph/src/extract/extraction.ts`, the `chunksOf(documentId).find((view) => view.ordinal === ordinal)` line in `workChunk`). After a revision that deletes a paragraph *above* others, a job parked for `(ordinal 5, hash X)` is worked against whatever paragraph now sits at ordinal 5 — right job, wrong span, silently. Same family as the two E6 closed.
2. **`appendStageLog` is two statements under `#write`**, not `#transaction` — confirmed still true: it calls `s.ensureEpisode.run(...)` then `s.insertStageLog.run(...)` inside `#write`, which only translates SQLite busy errors and does not wrap the pair atomically the way `#transaction` (a separate method, `#write(what, this.#db.transaction(body))`) does. E6's ingest path is covered; every other caller is not.
3. **Databases damaged by the pre-E6 partial write cannot be repaired** by any hash-keyed predicate — a chunk stored with no job is invisible to the enqueue rule. Still no `kgmem doctor` command and no `json_extract` scan over `jobs.payload` anywhere in `src/`. Wants exactly that scan over the write path's own data, which is a fair price once, on demand.

### 7. An extraction-quality eval does not exist.

The adjudicator has S1 for exactly this reason (item 2 above); extraction has no equivalent. What it would measure: rejection rate (item 1 gives the first real number once E7d runs), tier accuracy against hand-labelled chunks, and mention quality. `/home/kiel/dev/bayesian-knowledge-graph/scripts/spike-s2-embeddings.ts` with its data under `/home/kiel/dev/bayesian-knowledge-graph/fixtures/embedding-eval/` is the precedent for both the script shape and the fixture layout.

---

## First moves

1. Label S1 (item 2) and run it against the ≥90% gate — independent of everything else here, and it gates P3.
2. RED the prompt-caching shape change (item 3) — the `system` parameter's array form, zero behavioural churn.
3. Get an explicit go-ahead, then run E7d (item 1) on one small document and read `extraction_rejections` back. That number should decide whether items 4 and 5 are worth doing before a second live run or after.
