# WIP — the extraction adapter (E7)

**Status:** not started. Everything it plugs into is built, tested and committed.
**Companions:** reference spec v0.7.0 · v1 implementation plan 1.6

---

## Why this is its own phase

Text extraction is the system's universal ingress. E1–E6 built all of it except the model:

```
documentSource(path) / transcriptSource(session)  → a TextSource
submitText(source) → chunk + embed + anchor → enqueue one job per chunk
drainOnce()        → Extractor → verbatim gate → ingest.submit() → claims
                                ↘ refused → extraction_rejections
```

The `Extractor` port has **only fakes**. `kgmem reflect` is wired and refuses cleanly until one is configured. E7 supplies the real one.

It was deliberately not folded into E5's CLI wiring, because **the extraction prompt is this system's precision ceiling** — above the adjudicator, above retrieval. Everything downstream inherits whatever this produces, and a prompt decided as a side effect of routing work is a prompt nobody argued about.

---

## The contract

Already defined in `/home/kiel/dev/bayesian-knowledge-graph/src/extract/extraction.ts`:

```ts
interface ExtractedClaim {
  readonly text: string;                    // the claim, normalized
  readonly quote: string;                   // verbatim span from the chunk
  readonly kind: ClaimKind;                 // fact | convention | rationale | risk | intent | coupling
  readonly tier: ClaimTier;                 // verified | observed | inferred
  readonly mentions: readonly string[];     // the nouns this claim is about
}

interface Extractor {
  readonly modelId: string;                 // §13's grouping key — off the port, not the caller
  extract(request: { chunkText: string; context?: string }): Promise<readonly ExtractedClaim[]>;
}
```

A module default-exporting a factory that returns this. Named in `<root>/.kgmem/config.json`:

```json
{ "models": { "extractor": "@kgmem/anthropic-extractor" } }
```

`config.ts` resolves absolute and `./`-relative specifiers against `.kgmem/`, passes bare specifiers through, and checks the product actually carries `extract` — so a wrong module fails at load naming the config path, not at the call site with a bare `TypeError`.

---

## What the adapter must get right

### The quote is byte-exact or the claim is discarded

`refusalFor` admits a claim only if `chunkText.includes(quote)` and the quote is non-blank. **No trim, no case fold, no smart-quote folding.** A model that helpfully straightens a curly apostrophe, strips indentation, or paraphrases its own citation loses that claim to `extraction_rejections`.

This is the single largest practical risk in the adapter. The prompt must demand the span be copied character for character, and the adapter should not post-process quotes on the way out. If a model cannot do this reliably, that shows up as a rejection rate — which is exactly what the log is for.

Rejections are recorded with `claimText`, `quote`, `reason` (`quoteAbsent` | `quoteNotVerbatim` | `entailmentBelowFloor`), `modelId` and the chunk — enough to judge whether a given model is safe to extract with. Read them with `readExtractionRejections(documentId, ordinal?)`.

### Tier faithfulness (§5.10)

The extractor assigns tier; nothing downstream second-guesses it. The rule:

| Source of the claim | Tier |
|---|---|
| Reasoning only — the model's or the transcript's inference | `inferred` |
| Grounded in tool output visible in the chunk | `observed`, quoted **from the tool result** |
| A recorded test execution | `verified` |

This is why `transcriptSource` renders tool results as their own chunks carrying their speaker (`tool: exit status 0`). A chunk is all the extractor gets — `extract({ chunkText })` — so if the evidence is not in the chunk, no honest `observed` is possible from it.

**Getting this wrong inflates confidence system-wide.** A model that calls everything `observed` makes inference indistinguishable from measurement, and §4's whole apparatus is downstream of the distinction.

### Mentions decide referent resolution

Each string in `mentions` goes through §5.2's ladder — exact name, mention index, gloss embedding, LLM tiebreak — and a miss mints a provisional referent, invisible to gather until corroborated. So a bad mention costs storage, not a wrong answer. But mentions that are too generic ("the system", "it") will fragment or over-merge, and mentions that are too specific will never resolve.

### Model choice is the user's

Not hard-coded. Config carries the specifier; the adapter should take the model id from its own options so a user can point it at a different Anthropic model without editing code. `modelId` must reflect what actually ran — §13 groups drift audits by it.

---

## Cost

This is the dominant recurring spend in the system — one call per chunk, far above the adjudicator, which only fires on genuine ambiguity.

What already contains it:

- **Extraction is queued, never on the write path.** `submitText` chunks and returns; the model is only called when `kgmem reflect` drains. Drain on your schedule.
- **A revision re-mines only what changed** — measured: unchanged re-ingest parks 0 jobs, a one-paragraph edit parks 1.
- **Materialized documents are never mined**, at both the enqueue and the drain.

What does not exist yet and should be measured before any automatic scheduler: **cost per drain**, and a per-invocation batch ceiling. §15 has no retry or backoff constant at all.

---

## Retry has no cap — decide before running this at scale

A thrown extractor is treated as transient: the job returns to `pending` with `retryAt` 60 s out, `attempts` incremented, the graph untouched. Right for a brief API outage. Wrong for a bad key or a retired model, which retries every job forever.

The real cost is not the failed call — it is that `chunksOf` re-derives the whole document's chunking on **every** attempt, so a 40-chunk document pays 40 full re-chunks per minute indefinitely, while `attempts` climbs with nothing reading it (`job.attempts` has no reader outside the row mapper).

`port.ts`'s own `JobFailure` docblock says the store supplies the mechanism and **the caller supplies the policy**. The drain currently supplies a backoff and no budget — half a policy. A cap needs a §15 constant, and because `park` is terminal it must arrive either generous or alongside a public requeue, or a transient outage becomes permanent work loss.

---

## Measuring it — do not skip

Extraction quality is untested by construction: every test fakes the port. The adjudicator has S1 for exactly this reason, and extraction needs its own equivalent.

- **S1, for the adjudicator**, is harvested and waiting: `/home/kiel/dev/bayesian-knowledge-graph/fixtures/adjudicator-eval/s1-pairs.json` — 60 pairs, 30 polarity-critical, all 60 `label` fields empty. Needs a human labelling pass, then a measured run against the ≥90% polarity gate. It gates P3.
- **An extraction equivalent does not exist.** What it would measure: rejection rate (how often the model cannot quote verbatim), tier accuracy against hand-labelled chunks, and mention quality. The rejection log gives the first for free once anything real has run.

S2's precedent for both: `/home/kiel/dev/bayesian-knowledge-graph/scripts/spike-s2-embeddings.ts` with its data under `/home/kiel/dev/bayesian-knowledge-graph/fixtures/embedding-eval/`.

---

## Where the code goes

The embedding provider is the shape to copy: `/home/kiel/dev/bayesian-knowledge-graph/src/store/adapters/nomic-embedding-provider.ts`, behind a dynamic import so a run that does not need it never loads it. `dist/kgmem.js` has zero static references to `@huggingface/transformers`, and the extractor adapter should stay similarly split — a `kgmem ingest` needs no extractor at all.

Whether the adapter lives in-repo under `src/extract/adapters/` or as a separate package is open. In-repo is simpler and matches the embedding precedent; separate keeps the `@anthropic-ai/sdk` dependency off the core, which matters more here than it did for a local model.

---

## Known defects it will meet

Three are recorded and deliberately unfixed:

1. **The drain matches a job to a chunk by ordinal, not hash** (`/home/kiel/dev/bayesian-knowledge-graph/src/extract/extraction.ts:373`). After a revision that deletes a paragraph *above* others, a job parked for `(ordinal 5, hash X)` is worked against whatever paragraph now sits at ordinal 5 — right job, wrong span, silently. Same family as the two E6 closed.
2. **`appendStageLog` is two statements under `#write`**, not one transaction. E6's ingest path is covered; every other caller is not.
3. **Databases damaged by the pre-E6 partial write cannot be repaired** by any hash-keyed predicate — a chunk stored with no job is invisible to the enqueue rule. Wants a `kgmem doctor` doing the `json_extract` scan over `jobs.payload` that was rejected for the write path, which is a fair price once on demand.

---

## Sequencing note

**Taint enforcement must land before serving (P4/P6), not before extraction.** §4.3 names the echo loop the single most important rule in the system: episode retrieves claim E → agent restates E → post-episode extraction writes it back → α climbs. Mining LLM transcripts is precisely that vector.

It is safe today only because **nothing serves** — the graph tells the agent nothing, so there is nothing to echo. `observationWeight` already takes a `tainted` flag, but **nothing calls `store.isTainted`**; `submitClaim` passes the stage-0 `duplicate` flag, which is §5.1 replay, not §4.3 echo. The moment ambient injection exists, transcript extraction becomes an echo amplifier unless `isTainted` gates the weight.

---

## First moves

1. Label `/home/kiel/dev/bayesian-knowledge-graph/fixtures/adjudicator-eval/s1-pairs.json` (human, ~60 pairs) and run S1 against the ≥90% gate. Independent of E7 and it gates P3.
2. Decide in-repo versus separate package for the adapter.
3. RED against a recorded-response fake before any live call — the port's shape is already pinned by `/home/kiel/dev/bayesian-knowledge-graph/src/extract/__tests__/extraction-drain.test.ts`; what needs pinning is the adapter's own translation of a model response into `ExtractedClaim[]`, including what it does with a malformed one.
4. Only then a live call, on one small document, with the rejection log read afterwards.
