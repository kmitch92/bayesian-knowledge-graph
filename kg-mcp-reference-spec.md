# Knowledge-graph memory MCP for coding agents — reference specification

**Version:** 0.9.1
**Date:** 2026-09-12 (baseline v0.1.0 frozen 2026-08-04)
**Status:** design-complete, pre-implementation

**Conventions.** Values marked ⚙ are initial guesses, to be tuned offline against replay logs (§13) — not commitments. Section cross-references are stable anchors for future amendments; changes land in the amendment log (§16) and bump the version.

---

## 1. Purpose and value target

A persistent, self-correcting memory layer for coding agents, exposed over MCP. The graph stores *claims* — hypotheses about a codebase and the intent behind it — with Bayesian evidence, explicit lifecycle, and provenance, anchored to a containment spine of code entities.

The graph does not answer questions. It **collapses search space**: a debugging agent arriving cold should receive the disputed hypothesis, the governing convention, and the verified mechanism that together reduce "the whole repo" to "check this one interaction." Success is measured by task-level A/B improvement (§13), never by the number of triples accumulated.

## 2. Design principles

1. **Entities are identity; claims are knowledge.** Entities stay thin; claims carry everything. Entity summaries are materialized from canonical claims, never stored as entity fields.
2. **Never let the LLM claim what a noun source knows.** Whatever a deterministic source can attest — for code: symbols, imports, call edges, types, via an *external* emitter such as tree-sitter — enters under view semantics, carries no confidence machinery, and is true until the source re-emits. Core contains no parser of any kind. The probabilistic apparatus is reserved for knowledge that is expensive to verify.
3. **Two axes, one graph.** Containment scope (workspace → … → symbol) is the structural backbone; epistemic kind (fact, rationale, risk, …) is a property on claims. There are no "which layer does this go in" decisions.
4. **The raw ledger is append-only.** Every incoming claim is inserted, even duplicates. Canonicals, summaries, and merged views are *views over* the ledger; the ability to re-audit how any confidence got where it is is never lost.
5. **Strong evidence moves fast; weak evidence moves slow.** Status transitions gate on evidence *quality* (tier); posteriors move with evidence *quantity*.
6. **A contradiction never edits the standing claim.** The new observation might be the wrong one. Contradictions accumulate as rivals and flow through the dispute machinery.
7. **The partition is belief.** Which propositions are treated as one unit of belief is itself a belief. Every merge is a falsifiable claim; any configuration in which the partition cannot be revised by evidence is out of bounds.
8. **Compression may hide detail by default; it may never hide the existence of detail.** Canonicals disclose what they stand on; drill-down always resolves.
9. **Similarity steers; confidence ranks.** Vector proximity decides where to look, never what to trust.
10. **Sync-cheap, async-expensive.** The inline write path is one embedding plus one small-model call. Everything heavier hangs off a background clock (§9). This is the constraint that decides whether agents feed the graph at all.
11. **One choke point for belief.** Only two things mutate the graph without passing through adjudication: view-regime attestations from noun sources (re-derived, not believed; deduped by coreference, not by judgment) and churn decay (which only ever moves evidence toward the prior). Every other change — agent observations, hook capture, reflection output, consolidator merges — goes through the write path (§5).
12. **Transports, not truths.** MCP tools and host lifecycle hooks are two transports over one serving layer and one write pipeline (§7.6, §5.9). Bypassing a protocol never bypasses adjudication, and taint follows serving on every transport.
13. **The taxonomy is belief.** Principle 7 extended upward: coarse structure — merged propositions, concept nodes, asserted groupings, document boundaries — is itself a set of claims. Any level of any vertical that cannot be revised by evidence is out of bounds (§3.7, §8.8).
14. **One substrate, two regimes.** Claims are the only primitive. Entities, containment, aliases, and the structural floor are existence, containment, and identity claims — parsed ones under view semantics (invalidated by the change feed, never believed with posteriors), asserted ones under the ordinary evidence machinery. Every index over them — the referent index, the locator map, facets — is a materialized view, rebuildable from the ledger. Performance structures for a particular transport live in that transport, never in the schema.

## 3. Data model

Plain labeled property graph, deliberately DB-agnostic (§11). Two node families (entities, claims), a small closed set of edge types, and two derived object shapes (identity claims, canonical views) built from claims.

### 3.1 Entity spine

Entity-hood is derived, not primitive (principle 14), and referents **emerge from the nouns claims use**. Normalization (§5.2) forces every claim to name its referents explicitly; each noun mention resolves to a referent or mints a *provisional* one. The entities table is the **coreference index** — the materialized clustering of noun mentions into referents, rebuildable from the ledger (`rebuild-index`) — plus a many-to-one mention index (surface form → referent) materializing identity claims over names. Ground truth is a **privileged noun source, nothing more**: the parser contributes canonical nouns with locators at parsed tier, which act as resolution attractors. A domain with no noun source runs pure usage-emergence — the all-asserted mode and the noun-emergent mode are the same mode. Parsed existence claims carry view semantics; asserted ones bear evidence, so boundary disputes, splits, and refinement apply natively. Referents connect top-down by materialized `CONTAINS`:

```
workspace → repo → system → component → module → symbol
```

| Field | Notes |
|---|---|
| `id` | ULID |
| `name` | **derived**: the referent's most-corroborated surface form, a view over its mention cluster — never authoritative |
| mention index | surface form → referent id, cached at the weight of that pair's naming claim (§4.1's α) — a naming is evidence, not a tally, so the row is written *absolutely* to the claim's current posterior on every use rather than incremented; a use-count would let twelve repetitions in one episode outrank four independent ones (§4.2, §4.4). `AuthService` / `auth-service` / "the auth thing" are one referent because the identity machinery merged them, and can be split if it was wrong (§8.4) |
| `level` | pack-declared level, **nullable** ('unplaced') — a usage-born referent ("practice", "the retry pattern") has no level until a containment claim places it |
| `regime` | `view` \| `evidence` — derived per referent: `view` while any noun source attests it (re-derived, no α/β), `evidence` otherwise (an ordinary existence claim with a posterior). The index *materializes* this value; it does not own it — the ledger row is the fact, enforced at the store boundary (§11). A bad asserted boundary is just a wrong claim: disputable, splittable, revisable (principle 14) |
| `locator?` | opaque, nullable, **never parsed or queried by the store** — locator is claim content, interpreted only by spine code. Parsed existence-claim ids are content hashes of (level, locator), so re-parse is upsert-by-id; the §7.6 PreToolUse path is a SessionStart-built in-memory map in the hook adapter (invalidated by change events), not a store query. Absence is first-class: a zero-adapter domain runs an **all-asserted spine** — referents minted via the resolution ladder and grouping claims, no structural floor, nothing reaching verified tier — correctly humbler testimony |
| `gloss_embedding` | embedding of name + one-line gloss, used for anchor resolution and vague-query entry |
| `facets[]` | 1–4 centroid vectors summarizing the embedding clusters of attached claims. Maintained incrementally: O(1) mean update on every claim write (episode clock), re-clustered on the calendar clock (§9). Substrate for traversal lookahead (§7.3) — maintained from day one even before Mode C ships |

**No `description` field.** A description is knowledge and will drift; entity summaries are materialized on demand from that entity's canonical claims.

**Claims at ancestor scopes apply to descendants.** "Handlers must be idempotent" anchored at repo level is relevant to every module beneath it. This inheritance is what makes abstraction-level selection at read time mostly implicit (§7.1).

**Naming is evidence.** A naming claim is a first-class claim like any other: the same Beta-Bernoulli posterior (§4.1), the same episode cap and taint (§4.2, §4.3), and the same independence discount (§4.4) apply as to any other observation. Twelve uses of a form inside one episode sum to the episode cap's geometric series (1, ½, ¼, … → 2); four uses across four independent episodes sum to 4 — corroboration outranks repetition here exactly as it does everywhere else in the evidence model. The derived `name` above is a view over these posteriors, never a separate vote.

**The derived name's tie-break is the surface form.** Two forms tied at the best weight are broken by the smaller string (`<` over UTF-16 code units, never `localeCompare` — a collator's answer depends on the machine asking, which is exactly the database-specific dependence a rebuild must not reintroduce). The tie is broken on the forms and not on arrival order or the naming claim's id: arrival order is not a fact the ledger records, and a naming-claim id is a content hash only when a noun source attested the referent (§3.5) — under baseline usage-emergence it is a fresh ULID, which would make the name a coin flipped separately in every database that rebuilds it. Measured against the naming-claim-id tiebreak on the replay corpus, the two disagreed on 258 of 500 referents.

**De-attestation reaches every referent a form names.** A noun source's withdrawal is addressed to a `(source, form[, locator])` triple, not to one referent: the mention index can key one form to several referents, and a withdrawal that stopped at the first would leave the attestation it was asked to retract standing on the others. Regime falls back to `evidence` per referent, and only where that referent's *last* live attestation is the one withdrawn. A withdrawal is not a vote: the successor existence claim it seeds carries no §15 first-observation boost, because the message paying for it asserts the referent's *absence*. Where a retired evidence-regime existence claim still holds a posterior, the successor reads it through a `DERIVED_FROM` edge rather than starting over; where none exists, the successor starts at the bare §15 prior. Re-attestation later reinstates a retired view claim in place — §6.2's "never flip back" rule is scoped to the evidence regime, not to this one.

**Facet assignment.** A claim's embedding joins the nearest centroid at or above `facet_assign_floor` (§15); failing that it starts a new centroid while fewer than the §15 ceiling exist; failing that it joins the nearest centroid unconditionally. The mean moves in O(1): `m ← m + (x − m)/(n + 1)`. Spine claims (existence, naming, containment) are excluded — they place a referent, they are not knowledge about it. An exact tie keeps the older centroid. A retraction does not back its contribution out of the mean it joined; that repair is left to the calendar-clock re-clustering (§9). Facets are the one entity field a rebuild does not reconstruct: an incremental mean replayed from the ledger would bake in an arrival order the ledger does not record, so `rebuild-index` leaves them exactly where it found them.

### 3.2 Claim nodes

The fat node. Every unit of non-parsed knowledge — observation, convention, rationale, risk, theory — is a claim.

| Field | Notes |
|---|---|
| `id` | ULID by type (§3.5) — in practice a fresh monotonic ULID for a usage-emergent mint, or a content-addressed hash of the declaration for a parsed or attested one; same 26-character shape, different arithmetic (§11) |
| `text` | **normalized, self-contained declarative sentence.** Deixis ("this handler", "the bug from earlier") is resolved at write time — the only moment referents are recoverable (§5.2) |
| `embedding` | embedding of `text`; stored quantized in-graph for cheap traversal scoring, full precision retained for final rerank (§7.3, §11) |
| `kind` | `fact` \| `convention` \| `rationale` \| `risk` \| `intent` \| `coupling` — drives hint biasing at read time (§7.1) and kind-compatibility at adjudication (§5.4) |
| `tier` | `verified` (test executed, noun-source attested, CI observed) \| `observed` (agent directly read the relevant code/output) \| `inferred` (model reasoning, no direct observation) |
| `status` | `provisional` \| `active` \| `disputed` \| `deprecated` \| `archived` (§6) |
| `evidence` | `{ alpha, beta }` — Beta-Bernoulli (§4.1). Prior α₀=1, β₀=1; **inferred-tier claims seed β₀=2** (skeptical prior). **Nullable by regime**: `null` for a view claim, populated for an evidence claim — a storage invariant enforced by a table constraint and a typed refusal, not a convention (§11) |
| `scope` | referent id — the single spine anchor where the claim *lives*. Existence claims are **self-anchored** (scope = the referent they mint); parent linkage lives only in containment claims. No FK to the referent index — anchor integrity is the pipeline's job (§5.2, §11) |
| `temporal` | `{ createdAt, lastCorroborated, invalidatedAt?, lastChurnEvent? }` |
| `provenance` | `{ episodes[], changeEvents[], artifacts[], channel?, agent? }` (A15/A16) — feeds churn decay (§4.5), independence accounting (§4.4, §4.7), and merge priors (§8.2) |
| `canonical` | boolean — consolidator output (view) vs raw ledger entry |

### 3.3 Edge types

| Edge | From → to | Meaning |
|---|---|---|
| `CONTAINS` | entity → entity | spine structure — the materialization of containment claims (principle 14) |
| `ABOUT` | claim → entity (1..n) | what the claim references; exactly one target is the scope anchor |
| `SUPPORTS` | claim → claim | corroborating raw attached to the claim it supports |
| `CONTRADICTS` | claim ↔ claim | live rivalry; both sides remain live until resolution (§6) |
| `REFINES` | claim → claim | successor narrows/conditions the original |
| `DERIVED_FROM` | claim → claim | lineage: consolidated canonical → absorbed raws; resurrection successor → corpse |
| `SUPERSEDED_BY` | claim → claim | resolution outcome: loser points at winner |
| `MERGES` | identity/grouping claim → claim (2..n) | membership of a cluster under an identity (§8.2) or grouping (§8.8) hypothesis |
| `STATED_IN` | claim → document | extracted member assertion, span-anchored (§3.6, §5.10) |
| `INSTANCE_OF` / `SPECIALIZES` | claim/entity/concept → concept | conceptual-vertical zoom (§3.7, §8.8) |

Structural edges (calls, imports, type relations) arrive as view-regime claims from external noun sources through the ingest port and materialize as plain referent–referent edges: no evidence fields, invalidated and re-emitted on change-feed events.

**Containment materializes immediately, ratified for v1.** A live containment claim's `CONTAINS` edge and `contains_index` row are written in the same transaction as the claim, not deferred to a consolidator pass or a rebuild. Ratified with a revisit marker at P4: if uncorroborated spine rewiring turns out to pollute gather, immediate materialization is the first thing reconsidered.

**A null `childLevel` never unplaces.** A containment claim that asserts no level leaves whatever level the child already has alone; only a non-null `childLevel` overwrites it. Explicit unplacement — a message saying a child belongs at no level — is deferred to a future message type; nothing in v1 sends one.

**Retirement takes the edge with it, conditionally.** A containment claim leaving the live set (deprecated, or in time disputed against a §6.2 verdict) takes its `CONTAINS` edge and `contains_index` row with it in the same breath — but only when no other live claim still asserts that `(parent, child)` pair, since a rebuild would materialize the edge for any one of them that remained.

### 3.4 Identity claims and canonical views

**Identity claims** are first-class claim nodes asserting "these member claims state the same proposition," with their own α/β and lifecycle. The consolidator's merge judgment is *inferred-tier evidence* for the identity claim, not a verdict. Merges execute when the identity claim promotes and **reverse when it is contradicted** — the split path ordinary merging lacks (§8.4).

**Canonical views** hold **no evidence of their own**. They render an aggregate over live member posteriors (conservative pooling, §8.3) plus disclosure integers: raw count, live-refinement count, dispute flag, posterior width. Retrieval reads canonicals by default; provenance and dispute resolution read through to members.

### 3.5 Schemas (Zod)

```ts
import { z } from "zod";

// A16: levels are pack-declared ordered data, not a closed type.
// The shipped code pack declares: workspace, repo, system, component, module, symbol.
export const EntityLevel = z.string();
export const ClaimKind = z.enum([
  "fact", "convention", "rationale", "risk", "intent", "coupling",
]);
export const ClaimTier = z.enum(["verified", "observed", "inferred"]);
export const ClaimStatus = z.enum([
  "provisional", "active", "disputed", "deprecated", "archived",
]);

export const Evidence = z.object({
  alpha: z.number().positive(),
  beta: z.number().positive(),
});

export const Provenance = z.object({
  episodes: z.array(z.string()),
  changeEvents: z.array(z.string()), // was commits (A16)
  artifacts: z.array(z.string()), // was files (A16)
  channel: z.string().optional(), // A15 pathway signature
  agent: z.string().optional(), // A15 pathway signature
});

// v0.6: a materialized referent-index row — a view over existence claims,
// rebuildable from the ledger. Names derive from the mention index (no aliases
// column); level is nullable; regime is derived from attestation.
export const Entity = z.object({
  id: z.string().ulid(),
  name: z.string().min(1), // derived: most-corroborated surface form
  level: EntityLevel.nullable(),
  regime: z.enum(["view", "evidence"]),
  locator: z.unknown().nullable(), // opaque; never parsed or queried by the store; code recipe: { path, symbolRange }
  glossEmbedding: z.array(z.number()),
  facets: z.array(z.array(z.number())).max(4).default([]),
});

export const Claim = z.object({
  id: z.string().ulid(),
  text: z.string().min(1), // self-contained declarative, deixis-free
  embedding: z.array(z.number()),
  kind: ClaimKind,
  tier: ClaimTier,
  status: ClaimStatus,
  evidence: Evidence,
  scope: z.string().ulid(), // spine anchor entity
  temporal: z.object({
    createdAt: z.string().datetime(),
    lastCorroborated: z.string().datetime().optional(),
    invalidatedAt: z.string().datetime().optional(),
    lastChurnEvent: z.string().datetime().optional(),
  }),
  provenance: Provenance,
  canonical: z.boolean().default(false),
});

export const IdentityClaim = z.object({
  id: z.string().ulid(),
  members: z.array(z.string().ulid()).min(2),
  evidence: Evidence,
  status: ClaimStatus,
  priorBasis: z.object({
    paraphraseDistance: z.number(), // max pairwise cosine distance
    provenanceOverlap: z.number(), // Jaccard over files ∪ commits
  }),
});
```

### 3.6 Document nodes (A9)

A document is a hand-authored or machine-materialized canonical: discursive knowledge whose value lies in connective structure a sentence canonical cannot hold — ADRs, runbooks, overviews, postmortems. **Documents hold no evidence of their own** — the §8.3 rule applied to prose: a document is a bundle of propositions with different truth values, and whole-document evidence recreates the attractor/shielding failures. Its assertions live as member claims linked by `STATED_IN` with span anchors; evidence lands on members; the document renders derived health (§7.7).

| Field | Notes |
|---|---|
| `id`, `contentRef` | full text or pointer |
| `chunks[]` | chunk boundaries: `{ hash, embedding }` — hash + fuzzy-quote anchoring, never raw offsets (span rot, §5.10) |
| `docKind` | `adr` \| `runbook` \| `overview` \| `postmortem` \| `other` |
| `origin` | `authored` (human/external, ingested and extracted) \| `materialized` (generated from canonicals — members exist by construction via `DERIVED_FROM`, extraction forbidden, §5.10) |
| `scope` + `ABOUT` | resolved like claims (§5.2); members re-resolve their own entities |
| health | **derived, never stored**: member states + extraction coverage (§7.7) |

Non-propositional content — command sequences, config examples — is **artifact, not assertion**: it carries no posterior. Claims *about* it do ("this failover procedure works as of `<commit>`", verifiable when hook capture sees it run, §5.9).

```ts
export const DocumentNode = z.object({
  id: z.string().ulid(),
  docKind: z.enum(["adr", "runbook", "overview", "postmortem", "other"]),
  origin: z.enum(["authored", "materialized"]),
  contentRef: z.string(),
  chunks: z.array(z.object({ hash: z.string(), embedding: z.array(z.number()) })),
  scope: z.string().ulid(),
});
```

Documents are the coarse end of the consolidation vertical (§3.7) — the compression target for the kinds that do not compress into sentences (§8.6).

### 3.7 Verticals (A10)

A **vertical** is an axis along which resolution declines as you zoom out: a zoom edge type, a direction of applicability, and a level discipline. Epistemic kind is deliberately *not* one — a fact does not zoom out into a rationale; kind has no resolution axis, which is why it is a property (principle 3).

| Vertical | Zoom edge | Applicability | Levels | Status |
|---|---|---|---|---|
| Containment | `CONTAINS` | coarse claims govern fine — inheritance down (§3.1) | fixed six, two asserted | first-class |
| Consolidation | `DERIVED_FROM` / `MERGES` | coarse summarizes fine — aggregation up | emergent by construction | raw → canonical → document |
| Conceptual | `INSTANCE_OF` / `SPECIALIZES` | principles govern instances — inheritance down | emergent via grouping claims (§8.8) | new in v0.2 |
| Temporal | supersession chains, era nodes | era claims bound validity windows | vestigial | parked (§14) |

Rules:

- **Admission test.** A new vertical is admitted only if inheritance along it changes retrieval results the evaluation harness can detect (§13). Containment and consolidation pass trivially; conceptual passes on cross-scope pattern queries neither spine inheritance nor Mode C serves well; temporal currently fails (supersession chains already answer most "as of when" questions) and stays vestigial until replay data says otherwise.
- **Single anchor.** A claim keeps exactly one containment anchor (`scope`) — gather's workhorse. Participation in every other vertical is by edges, never a second anchor, or gather's scoping becomes ambiguous.
- **Emergent levels are claims** (principle 13). Coarse nodes in emergent verticals are grouping claims (§8.8): falsifiable, evidence-bearing, splittable. Nothing coarse is permanent by fiat.
- **Spine relaxation — resolved by principle 14.** Asserted strata *are* ordinary existence claims already; no migration remains. Parsed levels keep deterministic content-hash ids, which is what keeps re-parse an upsert and the PreToolUse session map cheap to build (§7.6).
- **Domain neutrality: language-free core, schema-room only.** Levels as validated data, opaque nullable locators, open-string structural edge kinds, generic provenance names — and nothing else in the core. **Core contains no parser, grammar, or language-specific module**; it must serve a philosophy research project as well as a TypeScript codebase. Noun sources are external emitters feeding the ingest port. One *supported recipe* ships alongside core, outside it: the code recipe (a tree-sitter emitter package, a git change-feed emitter, test-execution-as-verified). Other domains are integrator-owned optional emitters, never a build obligation; a domain with no emitter runs day one in noun-emergent mode.

## 4. Evidence model

### 4.1 Beta-Bernoulli claims

Each claim's confidence is the posterior of a Beta-Bernoulli: supporting observations increment α, contradicting observations increment β, confidence is the posterior mean α/(α+β). **The posterior width travels with the mean** in every response: agents must be able to distinguish "0.7 from one observation" from "0.7 from forty" — wide means verify-before-relying, tight means use.

### 4.2 Observation weights

Every α/β update applies weight:

```
w = tier × episode_cap × taint
```

| Factor | Values |
|---|---|
| `tier` | 3.0 verified · 1.0 observed · 0.5 inferred ⚙ |
| `episode_cap` | 1, ½, ¼, … per repeat contribution from the same episode — an agent saying something three times in one session is one observation, not three |
| `taint` | 0 if the target claim was in this episode's retrieval context, 1 otherwise — **with the exemption in §4.3** |

### 4.3 Taint and the echo loop

The single most important rule in the system. The failure it kills: episode retrieves claim E → agent restates E → post-episode extraction writes it back → α increments → E ranks higher → retrieved more often. Confidence in whatever the graph already believed, with numbers that look great throughout.

**Rule:** an episode that had E in its retrieval context cannot corroborate E — restatements at inferred tier carry weight 0 (they still land in the ledger as raws).

**Exemption (amendment A1):** verified-tier evidence with *fresh provenance* — a test, parse, or CI observation that did not exist before the episode — counts even when the claim was in context. Without this, disputes are unresolvable by the very agents investigating them. Taint suppresses *reasoning about* retrieved claims; it never suppresses *new experiments on* them.

Taint sets are recorded server-side per episode at query time (§7.5); agents never manage them. Taint is keyed by the episode, not the host session: v1 maps one host session to one episode, so at this grain the two coincide, but where a host chains sessions the chain collapses to one episode and one taint set — a chained continuation saw everything its predecessor was served, which is exactly the semantics this section wants.

### 4.4 Evidence independence

Episode caps handle within-session repetition. Cross-arrival correlation is governed by pathway saturation (§4.7, A15), of which the original provenance-overlap discount is the degenerate two-contribution case.

**An orphaned pathway signature is refused.** A `channel`/`agent` signature (§4.7) is stored per provenance row, so a claim carrying one while naming no episode, change event or artifact has nowhere for it to live — the write is refused rather than silently dropped. No valid write hits this: ingest always names an episode. The refusal exists for a claim built by a caller that went around ingest.

### 4.5 Churn decay (commit clock)

Fires from change-feed events delivered by an external emitter (git commits in the code recipe), never in the write path. When events touch artifacts in a claim's provenance:

```
alpha ← alpha0 + γ(alpha − alpha0)      γ ≈ 0.8 ⚙ per touching commit
beta  ← beta0  + γ(beta  − beta0)
```

Toward the prior, **not** toward zero — churn makes the graph uncertain again; it does not make claims false. A claim about a module untouched for a year is more trustworthy than one about a file modified yesterday.

**Neighbour expansion (amendment A3):** on any verified-tier contradiction, decay additionally applies to claims whose provenance files import or are imported by the contradicting evidence's provenance files. This catches semantic drift originating *outside* a claim's own provenance set (the hot-reload-in-a-new-module case) at the moment it is revealed.

**Decay-then-refine is the standard fix pattern:** a landed fix changes the truth. The commit's churn decay shrinks the old claim's evidence; the post-session reflector writes the successor ("X is idempotent as of `<commit>` via upsert-on-conflict") with a `REFINES` edge, seeded from the old posterior. No special-casing.

### 4.6 Soft evidence (A14 — gated ⚙)

Exact antithesis between claims is rare and tier-stratified: common at the verified/operational bottom (tests are bivalent), vanishing with epistemic altitude. The adjudicator therefore emits, per pair: a **verdict distribution** P(entail / contradict / neutral) from joint pair-encoding (polarity-aware, unlike bi-encoder difference vectors, which are not logically meaningful), an **overlap bucket** (full / partial / tangential → {1.0, 0.5, 0.2} ⚙ — discretized precisely to avoid miscalibrated scalars), and a **decomposable flag**.

- Gated update rule: Δα ∝ w·P(entail), Δβ ∝ w·P(contradict); overlap multiplies `w` (Jeffrey conditioning via fractional pseudo-counts — the `w` chain is already its implementation surface).
- **Atomization beats weighting where possible:** evidence addressing a *separable* sub-claim routes to a REFINES split (make full-weight updates true); overlap-weighting is reserved for irreducibly diffuse bearing.
- Lifecycle stays hard-gated (principle 5): a discrete contradiction *event* is P(contradict) > τ_event ⚙; A2 and the dispute rules are unchanged. Soft updates are posteriors-only.
- v1 applies argmax semantics; the full distribution and bucket are logged for replay, and the rule sits behind a `soft_updates` flag pending harness validation (§13).

### 4.7 Pathway-saturating independence (A15 — gated ⚙)

The nth observation from a pathway mostly tells you what that pathway says, not whether the claim is true: a pathway's total contribution saturates toward the value of one reliable report from that source. Every guard already built is a special case — taint is a zero-gain pathway, the episode cap the innermost cluster, source trust the pathway reliability prior, one-episode-per-document a cluster boundary.

- **Pathway signature** per contribution: utterance ⊂ episode ⊂ session-chain ⊂ artifact ⊂ **channel** ⊂ **agent** ⊂ store. Channel enum: `live-observe, hook-capture, reflector, transcript-mining, doc-extraction, commit-mining, history-stats, interview, user-correction, exploration, import:<store>`. Agent keys: `model:<family-major>` (minor versions lumped — shared training lineage is shared priors), `human:<id>`, `script:<name>`.
- **Cluster test:** two contributions share a cluster iff one systematic bias would distort both the same way. When unsure, lump — over-splitting grants correlated evidence false independence (the failure this exists to stop); over-lumping merely discounts slowly, which is safe.
- **Update:** effective weight = w × ∏ γ_level^{n_level} ⚙, from per-claim×cluster atomic counters; **symmetric on β** (a misfiring channel cannot execute claims); γ_agent gentlest — all LLM agents are partially the same witness, so verified evidence (agent-neutral world feedback, gain 1.0 at the agent level) remains the only true independence anchor.
- **World-state reset:** commit-clock events on the relevant provenance partially reset counters ⚙ — repetition across world-states is re-observation, not repetition (keeps the A4 sampler effective).
- **Near-verbatim detector:** suspiciously identical evidence text arriving via nominally independent channels is itself a correlation signal; flag or discount.
- **Serving:** means and widths computed from *effective* counts; disclosure gains pathway diversity (`channels: n · agents: m`); the ledger keeps raw contributions for audit and replay.
- v1 ships the plumbing only — channel/agent fields and the counter table — with flat gains behind a `pathway_saturation` flag.

## 5. Write path

The one synchronous pipeline every observation passes through, whatever its origin (agent tool call, hook capture, reflector output, consolidator merge proposal). Inline cost budget: one embedding + one small-model adjudication call (~a second, pennies). Every stage logs its inputs and decision (§5.8).

### 5.1 Stage 0 — idempotency dedupe

`hash(normalized_text) + episode_id` at the very front. Agents retry tool calls; without this, every network blip double-counts evidence.

### 5.2 Stage 1 — normalize and resolve

Rewrite the claim into a self-contained declarative sentence, resolving all deixis against session context **now** — the only moment referents are recoverable. Then resolve the scope target against spine entities:

```
exact name → mention index → embedding match → LLM tiebreak
```

Rungs 1 and 2 share one read: a canonical-name match outranks any number of mention-index matches, whatever the count on either side — §3.1's `name` is the most-corroborated surface form, and that ranking is what rung 1 *is*. Ambiguity escalates to the tiebreak only on a **plurality at the same strength** — two or more canonical matches, or, absent any, two or more mention-index matches — never merely because more than one candidate exists across different strengths. An alternative that escalated on any plurality regardless of strength was rejected on principle 10's cost: every escalation is a small-model call, and a single canonical match already answers the question an alias-level tie would otherwise re-ask the model to settle. The embedding rung answers only when rungs 1–2 returned nothing outright, and widens the slate rather than settling a tie it never saw.

The ladder is candidate retrieval for coreference. If nothing resolves above threshold, the mention **mints a provisional existence claim** — invisible to gather until corroborated (the §8.8 rule, reused). Recurrence across independent episodes promotes it through ordinary evidence and pathway saturation (§4.7); name-cluster merges and splits run on identity claims (§8.2–8.4). Fragmentation is answered by minting into a lifecycle, not by refusing to mint; there is no separate triage structure — the provisional-referent population is queryable by status.

**An unconfigured rung 4 declines, it does not refuse (E9a, 2026-09-12).** A repository naming no `models.adjudicator` in `.kgmem/config.json` — every fresh install — used to be handed a stub whose `tiebreakReferent` *rejected* with `UnconfiguredPortError`. `ladder.ts`'s rung 4 awaits that call with no surrounding `catch`, deliberately, so the rejection propagated straight out of `ingest.submit()` mid-write. This is the ruling two paragraphs up applied to the one rung that can have nobody to ask: the code was contradicting its own stated contract, not filling a gap the ruling left open. Because rung 4 is reached only on a genuine plurality of equal-strength candidates, the defect does not fire against an empty store — it fires once a graph has content, on the first mention that lands two canonical or mention-index matches, or two gloss-embedding hits, with nothing above to break the tie. And because `submit` is not transactional, an ambiguity on a claim's second mention left the first mention's referent, naming claim and mention row committed with no claim row to show for them. `kgmem reflect`'s drain (§5.10) classifies anything `submit` throws as transient, so the rejection burned a retry per chunk per run, under an exit code of 0, until §9's cap parked the chunk for good — a default install silently mining nothing. The stub now resolves `{ outcome: 'unresolved' }` instead: the verdict `Adjudicator`'s own vocabulary already had for a model that cannot choose, true in the limit of a model that was never configured. Rung 4 mints on it exactly as it would for a configured adjudicator that genuinely could not decide, and the write it was in the middle of completes.

### 5.3 Stage 2 — embed and retrieve candidates

Two channels, unioned, deduped, capped at ~15 ⚙:

- **Semantic:** ANN over claim embeddings, scoped to the target entity's spine subtree plus ancestors, top-k ≈ 10 ⚙ above a low floor (~0.7 cosine ⚙).
- **Structural:** every claim already attached via `ABOUT` to the same entities, regardless of cosine — catches paraphrases with disjoint vocabulary that slip under the embedding floor.

### 5.4 Stage 3 — adjudicate

One structured-output call to a small fast model classifies each candidate pair. This is the polarity-aware step embeddings cannot do ("batch inserts are idempotent" and "batch inserts are **not** idempotent" embed nearly on top of each other).

**Kind-compatibility rules (amendment A5):** a verified *fact* contradicting a *rationale* or *intent* claim does not disprove the rationale — intent and behavior can genuinely diverge. The adjudicator classifies such pairs as REFINES-adjacent ("the intent exists but is not implemented"), not CONTRADICTS. This prevents a whole class of wrong β increments.

There is **no fast mode** that merges or matches on cosine alone, at any cadence, in any component (§8.6).

Output schema (A14): verdict distribution + overlap bucket + decomposable flag; v1 applies argmax until `soft_updates` validates (§4.6).

### 5.5 Stage 4 — apply verdict

| Verdict | Graph mutation | Evidence update |
|---|---|---|
| `UNRELATED` | insert claim (`status=provisional`) | α₀=1, β₀=1 (inferred tier: β₀=2) |
| `DUPLICATE` | insert raw + `DERIVED_FROM` → E | E.α += w |
| `SUPPORTS` | insert raw + `SUPPORTS` → E | E.α += w |
| `CONTRADICTS` | insert raw as **live rival**, `CONTRADICTS` ↔ E | E.β += w, then dispute check (§5.6); neighbour decay expansion if verified (§4.5) |
| `REFINES` | insert claim′ + `REFINES` → E | claim′ prior seeded from E's posterior; E flagged for consolidator review |

Two deliberate choices: every incoming claim is inserted even as a duplicate (append-only ledger, principle 4), and a contradiction never edits or deletes the standing claim (principle 6).

### 5.6 Stage 5 — dispute check

After any β update on claim E:

```
if contradiction.tier == verified:            → E.status = disputed   (unconditional, amendment A2)
elif posterior_mean(E) < τ_dispute (0.65 ⚙):  → E.status = disputed
elif contradictions from ≥ 2 distinct episodes: → E.status = disputed
on transition: emit verification_task(E, rival)
```

The unconditional verified-tier rule exists because a freshly executed test is neither an adjudicator misread nor inference noise — the two things the ≥2-episode rule protects against. Cheap evidence accumulates; strong evidence acts. Without A2, a high-α wrong claim (α=20, β=1) survives a verified refutation at posterior ≈ 0.83 and poisons every subsequent agent's search space until two sessions independently collide with it.

### 5.7 Concurrency

α/β updates are **atomic increments in the database**, never read-modify-write from the MCP server. Two agents updating the same claim concurrently must not drop evidence.

### 5.8 Observability

Every stage logs inputs and decisions; every adjudication verdict is logged with both texts. Thresholds (τ_promote, τ_dispute, γ, cosine floors, beam parameters) are tuned by offline replay against these logs (§13), never by live surgery.

### 5.9 Ingress transports — hook capture (A8)

Host lifecycle hooks (Claude Code being the concrete case) are a second write-side transport alongside the MCP tools, generalizing the pattern the git hook already established. Hooks **capture, never assert**: a diff or a test exit code is not a proposition, and mapping events to claims is exactly the judgment this pipeline exists to apply.

- **Enqueue-only.** PostToolUse hooks append the event (diff summary, command, outcome, touched files) to the episode log and return immediately; adjudication and reflection run on the daemon, off the agent's critical path. Capture is best-effort — a dead daemon loses events, never blocks the agent.
- **Verification-task routing.** §5.6 emits `verification_task(E, rival)` on dispute. A hook watching test runs matches outcomes against open verification tasks by provenance-file overlap and routes the result through this pipeline as verified-tier evidence on that specific claim — disputes close automatically, without the agent being told to call `contradict`.
- **User-correction capture.** UserPromptSubmit captures the user's own assertions and corrections ("no, the retry behaviour is deliberate") as high-value candidate claims for the reflector — evidence the transcript-scraping reflector otherwise never sees reliably.
- **`observe` / `contradict` remain the precision instruments.** An agent that just ran a test knows what it meant; asserting it inline at verified tier is sharper than post-hoc reflection. Reflection over captured events is the safety net, not the replacement.

### 5.10 Document ingest and lazy extraction (A9)

Ingest is cheap: chunk, embed, anchor (resolution ladder §5.2; unresolved anchors mint provisional referents) — the document serves whole immediately. **Extraction is lazy:** member claims are extracted per chunk when the chunk is served and cited, when incoming evidence targets it, or opportunistically on the calendar clock. A 3,000-word ADR never pays forty inline adjudications.

- **Claim-with-quote.** Every member carries its verbatim source span; an entailment gate (span ⊨ claim, floor ⚙) guards insertion; failures go to the extraction-rejection log — never the graph. Phantom members (assertions the document never made) corrupt doc health in both directions: a refuted phantom marks a correct paragraph stale, a supported phantom buys unearned health.
- **Authored documents only.** Materialized documents have members by construction; re-extracting them would launder canonicals back in as fresh testimony.
- **A document is one episode.** Member seeding applies episode caps (§4.2): forty assertions from one ADR are one source, not forty observations. Doc-to-doc copying falls under provenance overlap (§4.4).
- **Idempotent.** Dedupe on (doc id, span hash, normalized text) at stage 0.
- **Per-member resolution.** Members re-resolve their own `ABOUT` entities; the document's anchor is a prior, not an inheritance.
- **Testimony decay.** Document edits fire the doc-side sibling of churn decay: members whose spans changed decay their doc-sourced contribution toward the prior; members whose quotes vanish flag `retracted_in_source` — the author withdrew the testimony, which is signal, but the claim is not auto-deprecated: it may still be true on other evidence.

**A concrete extractor exists.** `AnthropicExtractor` — one call to Anthropic's Messages API per chunk, forcing a single tool (`record_claims`) — is the first non-fixture implementation of this section's port, and it serves §5.11's transcript chunks too: same port, same adapter, whichever channel the chunk came from. Its system prompt carries the tier rubric above as prose, because no `input_schema` enum can encode *which* rung a claim earns — only argued cases can. The claim-with-quote gate is read exactly as written: `chunkText.includes(quote)`, blank quotes refused, and nothing else — no trim, no case fold, no smart-quote or whitespace normalization anywhere on the path, so a model that tidies its own citation loses the claim to the extraction-rejection log rather than the graph.

**Extraction quality is no longer unmeasured.** E7d (2026-09-06; one authored document, 23 chunks, 37 calls, $0.1767) was the first live run against this port and found defects the design above had not accounted for: **E8a**, an embedding-width default (`NomicEmbeddingProvider`) pinned to the ANN index width rather than the store's persisted width, failing `kgmem ingest` on every fresh install; **E8b**, a system prompt that told the model an empty `mentions` list was an honest answer, which `ClaimMessage`'s `.min(1)` then threw on mid-batch — the throw starved the rejection log of a genuine verbatim failure in the same batch and duplicated eight already-committed member rows on retry; and **E8c**, 35 of 225 proposals tiered `observed` from a document containing no tool output, because `ClaimMessage.tier` and `ContainmentMessage.tier` carried no default. E8d re-ran the identical 23 chunks after the fix (23 calls, $0.1130, zero retries) with zero mistiered proposals, zero duplicate rows, and 23/23 chunks completed against E7d's 19/23. The gate itself held in both runs to a single rejection each — E7d's a pronoun the model resolved inside its own quote, E8d's a one-character sentence-case change at a span boundary (§14 records both as distinct, still-open failure modes, not fixed by E8a–E8c). Fewer unique proposals landed post-fix (101 against E7d's 167) but more distinct member claims survived (100 against 92). Both transcripts and the read-only scripts that re-derive every figure above with no model and no key are preserved for replay.

### 5.11 Backfill ingestion (A17)

Backfill compresses episode-clock time using non-episode sources. Everything backfilled is testimony except executed checks, so the correct end-state is humble breadth — wide posteriors positioned to tighten under real use — never confident depth.

- **The two replays.** Commit-clock replay: seed historical evidence at its historical position, then fast-forward churn decay through every subsequent change event touching its provenance — old-but-stable knowledge survives, old-and-churned arrives pre-humbled. Episode-clock replay: cached host transcripts ingested as historical episodes through the reflector.
- **Tier-faithful transcript extraction.** Reasoning-only assertions → inferred; claims grounded in tool output visible in the transcript → observed, with claim-with-quote against the tool result; recorded test executions → verified-at-T, then commit-clock replay. Failures and dead ends mint the risk claims no other source records. The rubric is no longer aspirational: §5.10's extractor prompt encodes exactly this ladder, run against a transcript chunk the same way it runs against a document chunk. **Unmeasured against a transcript specifically:** E7d/E8d (§5.10) exercised this same prompt and gate against an authored document's chunks, not a transcript's — E8c's tier-default fix is proven against "no tool output," never yet against a chunk that *does* carry tool output the extractor must tier `observed` correctly. The transcript side of the ladder still awaits its own live run.
- **Independence at bulk scale.** Resumed session chains are one episode; documents and commits are one episode per artifact; provenance-overlap and near-verbatim checks (§4.7) apply hardest here.
- **Backfill namespaces.** Provenance episodes tagged `backfill:<source>` — seeded knowledge is always separable from organic, and a bad source is reversible by filter-and-recompute.
- **Re-verification worklist.** Mined claims cheaply checkable against the *current* tree queue for the A4 sampler; fresh verified evidence beats any replay of stale evidence.
- **Interview and exploration channels.** Uncertainty-directed question generation (high-centrality referents lacking rationale/risk coverage, uncorroborated provisional referents, contested asserted boundaries) and budgeted exploration episodes; an importance ranking (structural centrality × churn) allocates all backfill adjudication spend. Readiness is measured, not felt: anchor-hit rate, kind-coverage over top-N entities, ambient-serve usefulness, harness-baselined on day one.

## 6. Claim lifecycle

### 6.1 States

`provisional` (new, unproven) → `active` (serves by default) → `disputed` (serves with flag) → `deprecated` (kept for lineage). `archived` is orthogonal: the consolidator absorbs raws into canonicals from any state; archived claims leave candidate retrieval entirely (consolidator and audit reads only — if ANN surfaces one, that is a bug).

### 6.2 Status × verdict matrix

Incoming evidence verdict across the top, current status down the side; `w` tier-weighted as in §4.2.

| | DUPLICATE / SUPPORTS | CONTRADICTS | REFINES |
|---|---|---|---|
| **provisional** | α += w; promote → *active* at τ_promote ⚙ | β += w; if posterior < τ, **deprecate directly** — no dispute ceremony, nothing relied on it yet | successor seeded from prior; original usually deprecates when successor promotes |
| **active** | α += w; refresh `lastCorroborated` | β += w; → *disputed* if verified-tier (unconditional) or posterior < τ_dispute or ≥ 2 episodes | successor minted with `REFINES`; original flagged for consolidator (often narrows scope rather than dying) |
| **disputed** | verified: **resolves** → *active*; rival deprecated via `SUPERSEDED_BY`. observed/inferred: accumulates only — cannot resolve | verified: **resolves against** → deprecated; rival promoted. Weaker tiers accumulate | allowed and common — dispute resolution is often "both half-right"; successor supersedes *both* claim and rival |
| **deprecated** | **resurrection signal**: never flip back — mint a new claim `DERIVED_FROM` the corpse, seeded from its old posterior; history stays linear | mild support for its successor (transitive via `SUPERSEDED_BY`) | rare; treat as new claim with ancestry edge |
| **archived** | excluded from candidates entirely | — | — |

The **never-flip-back** row is scoped to the evidence regime — the row above describes a belief losing and regaining ground. A retired *view*-regime existence claim is not a belief that lost: it is a noun source's attestation withdrawn, and a later re-attestation reinstates it in place rather than minting a `DERIVED_FROM` successor (§3.1).

### 6.3 Tier privileges

Tier cuts across every cell as privilege level:

- **verified** — creates disputes, resolves disputes, kills provisionals unilaterally.
- **observed** — moves posteriors at full weight; needs the 2-episode rule for status changes.
- **inferred** — accumulates at half weight; taint-zeroed when restating retrieved claims; never changes a status by itself.

Disputes are therefore resolvable only by verification or TTL — status transitions gated on evidence quality, posteriors moved by quantity (principle 5).

### 6.4 Dispute TTL

Disputed claims unverified after N sessions ⚙ auto-deprecate with `reason: unverified`. Until then they are **served with status attached** — the agent double-checks rather than trusts, and disputes are never hidden (that would either serve risk silently or lose knowledge).

### 6.5 Contradiction history survives resolution

A reaffirmed claim keeps its β; the rival is deprecated but the evidence is outweighed, not zeroed. A claim that keeps attracting contradictions and keeps surviving verification reads as *true but confusing* — useful signal in its own right.

## 7. Retrieval

Three modes over one graph. Response objects always carry: text, kind, tier, status, posterior mean **and width**, scope, canonical flag, disclosure integers (for canonicals), and rival references (for contested claims).

### 7.1 Mode A — spine gather (default)

`query(task, hint, budget)`:

1. **Anchor.** Resolve entities mentioned in task context: exact → alias → gloss-embedding ANN. When multiple spine levels match, anchor at the **most specific** and let inheritance supply the rest.
2. **Gather three bands.**
   - *Anchor scope:* claims at the anchor, disputed ones included and flagged.
   - *Ancestors:* the full ancestor chain of canonicals, inherited down — this **is** the higher abstraction layers, compressed and essentially free.
   - *Structural floor:* the materialized view of parsed existence/containment/structural claims around the anchor — no confidence machinery. Served **with an as-of marker** (its last parse point); change-feed events trigger incremental re-parse of touched artifacts, so staleness is bounded by the feed and labeled, never hidden.
   - Limited-hop descent into children only if budget remains.
3. **Score.** `relevance × confidence × status_penalty × freshness`, with `hint` biasing kind: `debugging` up-weights risk/fact; `planning` up-weights rationale/intent/convention; `implementing` sits between.
4. **Pack to budget.** Canonicals by default; raws behind `drill_down`.

### 7.2 Mode B — ANN entry (vague queries)

No resolvable anchor ("how does auth work here"): ANN over entity glosses and claim embeddings chooses the entry scope. Scope-level canonical summaries are what make this work — a system-level canonical out-matches forty symbol-level claims.

### 7.3 Mode C — vector-steered lateral traversal (gated ⚙)

For lateral/cross-scope questions spine inheritance cannot serve ("what else in this workspace touches idempotency?") and for hot anchors needing directional pruning. Beam search of width B ⚙ with ε-slack ⚙ (never greedy — one bland hop must not kill a good path), expanding entity → claim → entity hops scored:

```
hop_score = max( sim(q, claim.embedding),
                 max_facet_sim(q, far_entity.facets) )
            × posterior_mean × status_penalty × kind_bias
```

The claim term asks "is this *relationship* relevant?"; the facet term asks "is the *region behind this door* relevant?" — the one-hop lookahead that makes bridge claims (relevant regions behind bland structural claims) non-fatal. Hub entities get per-node expansion caps ⚙. Claim vectors are scored quantized in-traversal; full precision only at final rerank.

**Similarity steers, confidence ranks** (principle 9): the posterior/status factors are non-negotiable, or the traversal confidently walks into deprecated territory on a good text match.

**Gating:** the facet-centroid substrate (§3.1) is maintained from day one (O(1) writes). The traversal implementation itself ships only when the evaluation harness (§13) shows retrieval failures Modes A and B cannot fix.

### 7.4 Rivals travel together

Budget-cut ranking can serve one side of a live dispute by scoring accident — read-side false consensus, per-query, leaving no trace in the graph. Rule: if one side of a `CONTRADICTS` pair makes the cut, the other rides along, or the pair collapses to a single "contested: A vs B" line. Budget pressure compresses disputes; it never drops a side.

### 7.5 Taint recording

The server records the set of claim ids served to a session — this session's taint set (§4.3). Agents never manage it. **Taint follows serving, not the tool (A8):** ids are recorded at serving time on every transport — MCP `query` responses and hook injections alike — which requires all transports to share session identity (hook payloads carry a session id; plumbing, not design). Done right, the taint set doubles as the ambient-injection dedup ledger (§7.6); done wrong, ambient injection becomes an echo-loop machine.

### 7.6 Transports and the serving layer (A8)

MCP tools are elective — the agent must choose to call them — and the empirical failure mode of memory servers is that agents under-call them. Host lifecycle hooks make retrieval **ambient**: a second read-side transport over the same serving layer.

| Hook | Injection | Character |
|---|---|---|
| SessionStart | ancestor canonicals for the cwd's repo scope — conventions, standing risks | inherited band, pushed once |
| UserPromptSubmit | embed the prompt, Mode B entry, top-k conservative | task-relevant band, per turn |
| PreToolUse (Read/Edit/Grep) | locator → referent via the adapter's in-memory session map → anchor-scope claims, risk/convention-biased | just-in-time precision, per touch |

PreToolUse is the high-value hook: the disputed idempotency claim arrives at the moment the agent opens the file, unrequested — the collapsed-search-space target (§1) delivered without the agent knowing to ask.

**Push is conservative; pull is expressive.** Ambient injection serves only tight-posterior canonicals and flagged disputes, under a hard per-session token budget ⚙, deduped against the taint set. Anything deeper — drill-down, raws, Mode C traversal — stays behind the deliberate MCP `query`. The PreToolUse path is an in-memory session-map hit (no store query, no LLM call, no embedding call); UserPromptSubmit may pay one embedding.

**Fail-open.** A dead daemon degrades to a memoryless agent, never a blocked one.

Accepted side effect: ambient serving enlarges taint sets, so cheap inferred-tier corroboration gets rarer and confidence growth shifts toward verified evidence — the direction the epistemics should lean regardless. The real risk is **channel fatigue**: ambient injection that is 30% noise trains the agent to ignore the served context, which is worse than no channel (§12, §13).

### 7.7 Serving documents (A9)

- **Health annotation.** Documents serve with derived health: members active / disputed / deprecated plus extraction coverage. Below the coverage floor ⚙, health renders **"unaudited"**, never a number — lazy extraction audits contested chunks first, so low-coverage health is computed over a hostile sample.
- **Span-level flags.** Disputed and deprecated members flag their exact source spans: "this paragraph is stale" is a first-class serving output. Past the health threshold ⚙ the document enters a revision queue — regenerate for materialized documents (calendar clock), propose-diff for authored ones; an author's prose is never overwritten.
- **No double-serving.** Serve-time dedup along `STATED_IN`: a served chunk suppresses its member claims (their status decorates the chunk inline); served members leave the document behind `drill_down`.
- **Prose never outranks evidence.** A served chunk contradicted by higher-tier claim evidence renders the contradiction inline. Documents feel authoritative; the serving layer must not let that authority ride over the posteriors.
- **Taint.** Serving a document taints its members, extracted or not; extraction triggered by serving marks the new members into the session's taint set retroactively.

### 7.8 Multi-vertical gather bounding (A13)

**Invariant: retrieval cost is budget-linear and graph-size-independent** — the graph-database promise (cost depends on what you touch, not how big the store is) preserved across verticals.

- **Fixed band shares.** The budget partitions into per-band shares ⚙ (structural floor, anchor scope, containment ancestors, concepts), hint-dependent — planning buys the concept band more than debugging does. Ranking happens within bands; there is never an open union over an unbounded frontier.
- **Asymmetric contribution.** Containment inheritance is *governance* (conventions bind): full ancestor chains, bounded by tree depth anyway. Concept inheritance is *analogy* (patterns inform): **depth-1 with spillover** — a concept is admitted only when instanced by claims already selected in the anchor band or query-matched to its definition; its `SPECIALIZE` ancestors enter only if the concept's own claims underfill its share. Grandparent concepts are near-vacuous for a specific task in a way grandparent scopes are not.
- **Precomputed admission.** Each spine entity caches the set of *active* concepts instantiated in its subtree — the facet pattern (§3.1): O(1) on write, re-derived on the calendar clock. Concept admission is a set intersection, zero traversal. A10's rent-paying α and invisible-until-active already pre-filter the serving population to concepts that have earned attention.
- **Serve-once identity.** Dedup by claim id across all bands — a claim reachable through two verticals serves once (generalizes the §7.7 rule).

Consolidation contributes no band: it is the *form* axis (raw / canonical / document), governed by presentation policy — depth, not breadth. If temporal is ever admitted (§3.7), era chains bound like containment chains; the pattern extends without new rules. Resolves §14.7.

## 8. Consolidation — accountable merges

Consolidation compresses *form*; it holds no editorial power over belief, because merging is itself modeled as belief (principle 7). The naive framing — "the consolidator compresses how the graph says things, never what it believes" — is rejected in this spec: at scale, merging edits the **partition** (which propositions are one unit of belief), and the composition of consolidation with resolution manufactures consensus even when every per-step label invariant holds. The mechanisms below exist to make that impossible-by-construction rather than tuned-away.

### 8.1 The three operations have three owners

- **Refinement** is claim creation → owned by the write path (§5).
- **Resolution** is a status change → owned exclusively by the evidence machinery: verified contradictions, dispute checks, TTLs (§5.6, §6).
- **Consolidation** is compression → owned by the consolidator, subject to §8.2–8.6. The consolidator may not change a status, pick sides in a dispute, or deprecate a rival.

### 8.2 Identity is a claim

Clustering (per scope, diameter-capped: bounded by **max pairwise distance** ⚙, not size, with the canonical re-adjudicated against its most distant member on every accretion — the chain-drift check) produces candidate merges. Each candidate mints an **identity claim** (§3.4) whose prior is set by paraphrase distance *and* provenance structure:

- near-identical text + entangled provenance → cheap, safe merge, low bar;
- similar-but-not-identical text + disjoint provenance → precisely the "different facts that read the same" case → high bar, plus an adjudication prompt that probes **conditions, scope, and rationale** specifically (the informative differences paraphrase-adjacent claims hide).

The consolidator's merge judgment is inferred-tier evidence on the identity claim. **Merges execute when the identity claim promotes; they reverse when it is contradicted.** The consolidator makes hypotheses, like everyone else.

### 8.3 Evidence stays at member level

The canonical holds no evidence of its own; it is a genuine view rendering **conservative pooling**: the deduplicated union of member provenance, episode-capped — never the sum of member counts. Incoming evidence routes hierarchically: ANN to the cluster, adjudication against *members* (cheaper than flat search at 100k+ anyway), landing on the specific member it bears on. Consequences:

- no **evidence attractor**: support for facet A cannot silently strengthen facet B through a shared node;
- no **evidence shielding**: a verified contradiction lands on member B and can kill B without A's accumulated α absorbing the blow.

### 8.4 Divergence — two layers, and splits (A12)

Naive posterior spread fails both ways: noise-inflated for thin members (two observations produce wildly different means that mean nothing) and correlation-deflated for co-fed members (shared episodes make posteriors co-move, hiding real disagreement). Divergence is measured in two layers:

- **Layer 1 — differential verdicts (online, write path).** Whenever one piece of evidence is adjudicated against multiple members of a cluster — which candidate retrieval already produces — non-matching polarity (supports A, contradicts B) is a direct observation that the members are not one proposition: the identity claim takes β at the evidence's own weight (tier × cap × taint), inheriting the whole evidence machinery — a verified differential event disputes the merge unconditionally (A2); an inferred one cannot flip anything alone. Matching polarity across members adds identity α, capped as one event. Cheap, correlation-safe by inheritance, and attributable: it names the offending pair.
- **Layer 2 — batch separation on disjoint evidence (calendar clock).** For drift that never yields a single differential event because different episodes feed different members: per member pair, compute P(|θ_A − θ_B| > δ_div ⚙) from the two Beta posteriors **over their non-shared evidence only** — overlapping provenance contributions removed before comparison. Thin members have wide posteriors, so the probability stays low (uncertainty-aware by construction); a pair whose evidence is fully shared contributes nothing (correct: no independent signal exists). Findings land as inferred-tier β — accumulating toward dispute, never forcing one alone.

A disputed identity claim emits its own verification-task type: a deliberate deep re-adjudication of the pair with full context, counting as its own episode, which resolves or splits. **Splits** partition members by evidence-polarity affinity; the identity claim deprecates with `SUPERSEDED_BY` edges to narrower identities over the coherent subsets. Because evidence was routed to members all along (§8.3), nothing is reattributed — the canonical view simply recomputes. The routing design pays its bill here.

Grouping claims use definition-entailment instead (§8.8). Resolves §14.1.

### 8.5 Contradictions are incompressible

Merging is licensed only across DUPLICATE/SUPPORTS relationships. A cluster containing a live CONTRADICTS either stays raw or produces an explicitly **two-sided contested summary** — both positions, both evidence sets. A single-position canonical over a live dispute is forbidden output at every dial setting.

### 8.6 Configuration envelope

Both ends of the eagerness dial fail *epistemically*, in opposite directions: over-consolidation manufactures consensus through the partition; under-consolidation dilutes ANN candidates, makes adjudication miss duplicates, and fragments corroboration across paraphrases so nothing crosses promotion thresholds — real consensus rendered invisible. That is the argument for a configurable dial with hard boundaries, rather than a fixed conservative setting.

**Free parameters:**

| Knob | Range |
|---|---|
| cadence | inline / post-session / nightly / on-demand |
| trigger thresholds | cluster size, staleness before summarization ⚙ |
| presentation default | canonicals-only vs canonicals + top-k raws |
| archive latency | how fast absorbed raws leave the candidate set ⚙ |
| per-kind overrides | facts/conventions compress freely into sentence canonicals; **rationale/intent cluster-and-link at small N, then canonicalize into materialized documents (§3.6) rather than sentences** ⚙ — the compression ladder's top rung for the kinds paraphrase-merging destroys |

**Out of bounds at any setting:** changing a status or moving a posterior beyond conservative pooling; merging on cosine alone (adjudication-grade decisions at every cadence — eagerness changes *when*, never *how carefully*); a one-sided canonical over a live dispute; dropping a rival at read time; hiding the existence of detail; any configuration in which the partition cannot be revised by evidence.

### 8.7 Upward promotion

When near-identical canonicals exist across sibling scopes ("handlers must be idempotent" in repos A, B, and C), the consolidator mints a generalized claim with links down to its instances. Org-level conventions *emerge* from component-level observations rather than being written down. **Routing (A10):** promotion targets the containment parent when the generalization's extent is a place in the tree; when the recurring thing is a mechanism or shape that cuts across scopes ("retry-with-backoff"), promotion routes to the conceptual vertical instead — minting or strengthening a grouping claim (§8.8).

### 8.8 Grouping claims — emergent taxonomy (A10)

A **grouping claim** asserts "these members instantiate one coarser node on vertical V" — the identity-claim machinery (§8.2–8.4) with the proposition changed from *same statement* to *same kind*. Same lifecycle, same falsifiability, `MERGES` membership edges, minted by the consolidator on the calendar clock.

**The prior inverts across the two claim types.** Identity priors rise with provenance overlap (entangled evidence → probably one fact). Grouping priors rise with **scope dispersion given semantic cohesion** — the same shape in three unrelated repos is a pattern; three claims from one module are just that module.

Cohesion is fuzzier than paraphrase distance, so grouping claims replace the diameter cap with an **intensional definition**:

- Minting requires the adjudicator to produce a short necessary-features definition, not an extension list; clusters that cannot be intensionally defined are refused.
- **Discrimination test:** the definition must entail the members and reject sampled near-misses (semantically close non-members). Discrimination = entail(members) − entail(near-misses), floored ⚙ — the guard against vacuous concepts that entail everything.
- **Membership is definition-entailment**, which supplies the divergence statistic for free: members failing re-check increment β on the grouping claim, and the lowest-entailment member is re-checked on every accretion (the chain-drift check, §8.2, transposed).
- α accrues from independent arrivals — new members passing the definition from distinct scopes and episodes — and from **verified transfers**: a concept-level claim verified at a member. A concept earns promotion by paying rent in inference, not by clustering statistics.
- Definition revisions are `REFINES` on the grouping claim, depth-capped ⚙ before a forced split — the concept-side analog of chain drift.
- Minting floors: ≥ 3 members across ≥ 2 scopes ⚙; grouping claims are **invisible to gather until active** — never load-bearing while provisional.
- Concepts may `SPECIALIZE` concepts; depth emerges through the same machinery, never by fiat.

Partially resolves §14.1 — definition-entailment is the divergence statistic for grouping claims (identity claims use the two-layer statistic of §8.4, A12) — and supplies the mechanism §14.3 asked for.

### 8.9 Cold start — emergent, not configured (A11)

Cold start is not a mode. The write path already dedupes incrementally — DUPLICATE verdicts pile corroboration onto the first-written claim of each proposition — so a young graph does not fragment without the consolidator. The consolidator's jobs (canonical compression, promotion, concepts) are scale responses, and the scale signal arrives on its own: identity claims promote only on independent write-path corroboration — a fresh claim adjudicated DUPLICATE against multiple members of one cluster in the same candidate set is an independent judge saying "one proposition." In a young graph those events are rare, so identities sit provisional, merges do not execute, and cluster-and-link is emergent rather than configured.

- **The consolidator is one episode.** Its re-judgments of a cluster episode-cap like any repeated source (§4.2); consolidator opinion alone can never climb to τ_promote. This is the rule that makes the rest true.
- **Bootstrap ordering: noun sources before claims.** If the recipe has emitters, run them first (resolution has attractors to land on; PreToolUse works from day one); if not, start noun-emergent. Then ingest existing documents — lazy extraction seeds the graph with episode-capped, wide-posterior testimony, which is the correct cold epistemic state: modest confidence, verify before relying.
- **Retrieval pressure directs attention, never bars.** Gather repeatedly exceeding budget at a hot anchor may prioritize which scopes the consolidator clusters first; it never lowers promotion thresholds. Budget pressure driving merges would be compression editing belief (§8.6) — restated here because cold start is exactly when the temptation appears.

Resolves §14.2.

## 9. Temporal model — three clocks

| Clock | Fires on | Owns |
|---|---|---|
| **Episode** | each agent session — session hooks (SessionStart/Stop) are this clock's event source (§7.6, §5.9) | retrieval + taint set; inline write path; α/β movement; hook capture into the episode log; reflection triggered on Stop (extract 2–3 claims per episode; taint-set restatements at inferred tier land as weight-0 raws) |
| **Change feed** | external emitter events (git commits in the code recipe) | churn decay toward the prior; view invalidation and re-emission of attested claims; pathway counter reset; neighbour expansion on verified contradiction; the decay-then-refine fix pattern |
| **Calendar** | cron / nightly | consolidator cadence; divergence monitor; re-verification sampler over old, high-α, low-churn claims (the scariest claims are the undisturbed ones); dispute TTL sweep; facet re-clustering; extraction backlog, document health sweep, materialized-doc regeneration (§5.10, §7.7); grouping-claim minting and definition re-checks (§8.8); identity batch-separation sweep (§8.4) |

**Design test for any future mechanism:** it hangs off exactly one clock. If it needs two, it is two mechanisms.

## 10. MCP tool surface

Small by design; inline latency is what decides whether the elective channel gets used (principle 10) — though with ambient transports (§7.6, §5.9) it is no longer the only channel feeding the graph.

```ts
export const QueryRequest = z.object({
  task: z.string().min(1),
  hint: z.enum(["debugging", "planning", "implementing"]).optional(),
  budgetTokens: z.number().int().positive().default(2000),
  anchor: z.string().optional(), // entity id/name; resolved when absent (Mode B)
  modes: z.array(z.enum(["spine", "ann", "traverse"])).default(["spine", "ann"]),
});

export const ServedClaim = z.object({
  id: z.string().ulid(),
  text: z.string(),
  kind: ClaimKind,
  tier: ClaimTier,
  status: ClaimStatus,
  posteriorMean: z.number().min(0).max(1),
  posteriorWidth: z.number().min(0).max(1), // e.g. 95% credible-interval width
  scope: z.string().ulid(),
  canonical: z.boolean(),
  disclosure: z
    .object({
      rawCount: z.number().int(),
      refinementCount: z.number().int(),
      disputed: z.boolean(),
    })
    .optional(),
  rivals: z.array(z.string().ulid()).optional(), // contested pairs travel together
});

export const QueryResponse = z.object({
  anchor: z.object({ id: z.string().ulid(), name: z.string(), level: EntityLevel }),
  claims: z.array(ServedClaim),
  structural: z.array(
    z.object({ from: z.string(), edge: z.string(), to: z.string() }),
  ),
  taintRecorded: z.literal(true),
});

export const ObserveRequest = z.object({
  claim: z.string().min(1),
  tier: ClaimTier,
  about: z.array(z.string()).optional(), // entity names/ids; resolver handles the rest
  provenance: Provenance.partial(),
});

export const ContradictRequest = z.object({
  target: z.string().ulid(),
  claim: z.string().min(1),
  tier: ClaimTier,
  provenance: Provenance.partial(),
});

export const DrillDownRequest = z.object({
  canonical: z.string().ulid(),
  includeArchived: z.boolean().default(false),
});
```

Outside the tool surface: the ingest port (claims and change-feed events in from external emitters, §4.5, §5), the hook CLI adapter (ambient serving and event capture for host lifecycle hooks, §7.6, §5.9), and a provisional-referent view (§5.2).

## 11. Storage and implementation notes

- **Storage is a recipe, not an architecture decision.** SQLite + sqlite-vec is the v1 *local* recipe and is potentially temporary. The system must support, in its final form: cloud-hosted enterprise deployments, gigantic codebases, and stores in the billions of claims. Recipes by use-case (local · team · enterprise/hosted) sit behind the `GraphStore` port, and **migration pathways are first-class**: the ledger is exportable and importable at raw fidelity (principle 4), every index is rebuildable (`rebuild-index`), so moving SQLite → Kùzu → a hosted graph store is export, import, rebuild — never a rewrite. Nothing above the port may assume SQLite.
- **Query-shape logging from day one:** hop depth, fan-out, and latency per query class. The workload is unmeasured; deep or wide traversal at scale is exactly where SQLite would fail, and the logs decide the swap — not assumptions.
- Vector index in-graph where native (Kùzu, Neo4j); otherwise a sidecar keyed by claim id — mildly annoying, not blocking.
- Claim embeddings stored quantized (int8/PQ) as node properties for SIMD-cheap in-traversal scoring; full precision retained for final rerank only.
- **Embedding width is unconstrained in the schema, enforced at the store boundary.** `Claim.embedding` and `Entity.glossEmbedding` are bare `z.array(z.number())` — the schema is not where a fixed width belongs, since the store is the only layer that knows what width it pinned. A vector arriving at the wrong width is a typed refusal there, not a shape failure earlier.
- Facet centroids: incremental mean updates in the write path; re-clustering (k ≤ 4) on the calendar clock. The one exception to rebuildability (§3.1): `rebuild-index` neither reconstructs nor destroys them, since an incremental mean replayed from the ledger would bake in an arrival order the ledger does not record.
- **Regime is a storage invariant, not a convention.** A claim's `evidence` is `null` in the view regime and populated in the evidence regime, enforced by a table constraint and a typed refusal — "nothing is ever both, and nothing is ever neither." The referent index materializes a claim's regime; it does not own it.
- α/β as atomic DB increments (§5.7).
- **The ledger scan is real, and rebuildability was not actually held before.** `listClaimIds`/`listEntityIds` are keyset-paginated, draining to an empty page — never a short one — with no upper bound but the table. They replace an ANN-KNN probe capped at what the vector index would accept as `k`, which was never an enumeration at all: it was the first page of one, silently truncated past roughly 2,048 referents. §3.1's and this section's rebuildability guarantee holds only from this fix forward.
- No foreign keys from the ledger onto materialized indexes (`claims.scope` → entities was dropped): a projection cannot constrain its source, and `rebuild-index` must be able to clear and regenerate. DDL keeps mechanical constraints only; ontological integrity lives in the pipeline.
- One daemon, thin adapters: an internal serving/ingest API, with MCP tools as the portable interface and a small CLI that host hooks shell out to (§7.6, §5.9). Hooks are host-specific; the daemon is not.
- The real constraints the DB cannot help with: every write is an LLM round-trip (embedding + adjudication + occasional rewrite) — the write path is where the latency and cost budget goes — and consolidation quality depends on prompt/threshold tuning, not storage.

## 12. Failure-mode registry

| Failure | Mechanism | Mitigation |
|---|---|---|
| Retrieval echo loop | retrieved → restated → written back as evidence | taint set; inferred restatements at w=0 (§4.3). **Implement day one — cannot be retrofitted once confidences are polluted** |
| Confident and stale | semantic drift from outside a claim's provenance set | neighbour-expanded decay on verified contradiction (§4.5); re-verification sampler (§9) |
| Search-space poisoning | one wrong high-α claim eliminates the true cause a priori, per session | unconditional dispute on verified contradiction (§5.6, A2) |
| Evidence attractor / shielding | merged canonicals absorb misdirected evidence / cushion refutations | member-level evidence routing (§8.3) |
| Absorbing merges, chain drift | no split path; A≈B, B≈C, … until A and D share nothing | identity claims + divergence splits (§8.4); diameter caps + most-distant-member re-adjudication (§8.2) |
| Read-side false consensus | budget cut drops one rival | rivals travel together (§7.4) |
| Fragmented corroboration | under-consolidation dilutes ANN and splits evidence across paraphrases | consolidation exists; cadence floor on the dial (§8.6) |
| Polarity misreads | adjudicator error, few percent, biased toward informative differences | 2-episode rule for weak tiers (§5.6); condition/scope/rationale-probing merge prompts (§8.2); verdict logging + drift audits (§13) |
| Correlated evidence | same source repeated across episodes | episode caps (§4.2); provenance-overlap discount (§4.4) |
| Zombie disputes | verification tasks nobody runs | TTL auto-deprecate; serve flagged meanwhile (§6.4) |
| Double-counted retries | non-idempotent tool calls | stage-0 dedupe (§5.1) |
| Lost updates | concurrent sessions on one claim | atomic increments (§5.7) |
| Entity fragmentation | name variants becoming separate referents | resolution ladder as candidate retrieval; identity claims over names merge clusters, divergence splits them (§5.2, §3.1) |
| Noun soup | usage-born provisional referents proliferating ("that helper") | invisible until corroborated; pathway saturation stops single-session promotion; parser nouns as attractors (§5.2, §4.7) |
| Local-minimum traversal | bridge claims behind bland hops | beam + ε-slack; facet lookahead (§7.3) |
| Elective-tool starvation | agents under-call voluntary memory tools; the graph is neither fed nor read | ambient transports: hook-served reads, hook capture (§7.6, §5.9) |
| Ambient channel fatigue | noisy push injection trains the agent to ignore served context | conservative push: canonicals-only, tight posteriors, hard budgets; ambient-vs-elective A/B arm (§7.6, §13) |
| Transport taint leak | hook-injected claims corroborated because taint tracked only the MCP tool | taint recorded at serving time on every transport (§7.5) |
| Hallucinated extraction | extractor writes assertions the document never made; health computed over phantoms, corrupting in both directions | claim-with-quote spans + entailment gate at insert, failures to the rejection log (§5.10) |
| Testimony laundering | materialized docs re-extracted, looping canonicals back as fresh testimony | extraction on authored documents only; materialized members exist by construction (§5.10) |
| Span rot | document edits break anchors; retracted assertions keep contributing | hash + fuzzy-quote anchoring; re-anchor pass; testimony decay + `retracted_in_source` (§5.10) |
| Doc shadowing | chunks and member canonicals double-served; authoritative prose outranks posteriors | `STATED_IN` serve-time dedup; member flags render inline; prose never outranks evidence (§7.7) |
| Biased doc health | lazy extraction audits only contested chunks; health over a hostile sample | coverage-aware health; below floor renders "unaudited" (§7.7) |
| Concept thrash | over-minted micro-concepts; vacuous concepts that entail everything | intensional definitions + near-miss discrimination floor; minting floors; invisible until active (§8.8) |
| Consolidator self-corroboration | nightly re-judgments of one cluster climbing to promotion | the consolidator is one episode — capped like any repeated source (§8.9) |
| Divergence blindness | co-fed members co-move, hiding disagreement; thin members alarm on noise | differential verdicts + disjoint-evidence batch separation (§8.4) |
| Open-union gather | multi-vertical ancestor union unbounded; concept chains flood the budget | fixed band shares; depth-1 concept admission via precomputed subtree sets (§7.8) |
| Same-pathway inflation | the nth arrival via one channel counted as fresh corroboration; a rumor amplifier | pathway signatures + saturating marginal gains, symmetric on β (§4.7) |
| Backfill overconfidence | bulk testimony landing at live weights; historical claims about churned code born confident | tier-faithful extraction, per-artifact episode caps, commit-clock replay, backfill namespaces (§5.11) |
| Stale floor served as truth | parsed structure silently wrong after refactors; no posterior to widen | view semantics: change-feed-triggered incremental re-parse, as-of marker on the structural band (§7.1, principle 14) |
| Threshold brittleness | every constant a guess until data | full-pipeline logging + offline replay tuning (§5.8, §13, §15) |

## 13. Evaluation

- **Task-level A/B on repo tasks** — memory on vs off, success rate and time-to-fix. Unaided intuition lies about whether memory helps; plausible-looking triples are not the metric.
- **Ambient vs elective arm** — hooks-only, MCP-only, both, neither: does ambient injection add task success beyond elective pull, and at what noise cost (§7.6)?
- **Structure audits** — sampled entailment checks: extracted members against their quoted spans, grouping-claim members against their definitions. Drift here silently corrupts document health and the conceptual vertical (§5.10, §8.8).
- **Replay tuning** — thresholds (§15) tuned offline against stage logs, never live.
- **Adjudicator drift audits** — every verdict logged with both texts; periodic offline re-classification against a stronger model.
- **Calibration** — posterior means vs empirical verification outcomes; the one item here that borders on research.

## 14. Open questions (parked, not blocking)

1. **The divergence statistic** (§8.4): *resolved by A12* — differential verdicts online plus disjoint-evidence batch separation for identity claims; definition-entailment for grouping claims (A10).
2. **Cold-start consolidation policy:** *resolved by A11* — emergent, not configured: the consolidator-is-one-episode rule makes cluster-and-link the natural young-graph state; parse-before-claims bootstrap ordering (§8.9).
3. **Asserted-boundary revision** (§3.1): *fully resolved by principle 14* — asserted boundaries are ordinary existence claims; nothing to migrate. Parsed levels participate as view-semantics claims, not evidence-bearing ones.
4. **TTL, beam, and diameter constants** — replay-tuned (§13).
5. **Reflector prompt design** — extraction quality bounds everything downstream; treat as its own tuned artifact.
6. **Extraction verifier tuning** (§5.10) — the entailment gate's model and threshold: false rejects starve document health; false accepts hallucinate members.
7. **Multi-vertical gather cost** (§3.7): *resolved by A13* — fixed band shares, governance-vs-analogy vertical asymmetry, precomputed concept admission (§7.8).
8. **Scale-out storage** (§11): the enterprise/hosted recipe — which graph store, ledger sharding, federation on hosted tiers, and whether billions of claims change any retrieval bound. Driven by query-shape logs, not decided up front.
9. **Retirement of a usage-child's only placing claim** (§3.1, §3.3): a deprecated containment claim that was the only thing placing a usage-born child leaves the live view holding the level while a rebuild reads `null` off the existence payload. Resolving it means deciding whether retirement unplaces, which no ruling says.
10. **`setClaimStatus` bypassing containment cleanup** (§3.3, §6.1): `setClaimStatus` is public on the port and a direct `deprecated`/`archived` transition bypasses the containment cleanup. Nothing does this today — only `retireClaim` writes `deprecated`, and nothing writes `archived` at all — but §6.1's archive is a concept P3 will need, and archiving a containment claim would reproduce exactly the drift F9 fixes.
11. **Containment retirement cost** (§3.3, §11): O(ledger) — 697 ms against a 100k-claim ledger after optimisation, down from 4,900 ms. Unpaid today, since no production path can retire a containment claim; it lands with §6.2's verdicts in P3.
12. **Extractor model choice is not configurable end-to-end** (§5.10): `openModels`'s `loadPort` calls the configured factory with no arguments (`src/adapters/cli/config.ts`), so `AnthropicExtractor`'s model id is the hard-coded `ANTHROPIC_MODEL_ID` and its own constructor options (`model`, `fetch`) are unreachable from `.kgmem/config.json`. A wrapper module cannot close over them either: the package ships `private: true` with no `exports` field and builds to one bundled `dist/kgmem.js`, so there is no importable entry point outside the CLI to build a wrapper against. The intended, deliberately deferred fix: widen `models.extractor` to accept `{ module, options }` alongside today's bare specifier string, and pass `options` through to the factory. `ANTHROPIC_API_KEY` stays an environment variable regardless — a secret does not belong in a committable file.
13. **An admitted claim's quote is stored nowhere** (§3.6, §5.10): the claim-with-quote gate (`chunkText.includes(quote)`) is a plain substring test, and any substring of a chunk remains a substring of that chunk after `.trim()` — so a `quote.trim()` introduced anywhere upstream of the gate could never be caught by it. Nothing tests for this today because nothing needs to: an admitted proposal's `quote` is never passed to `ingest.submit()` at all, no `STATED_IN` edge is written (§3.3's edge addresses a claim or an entity, and a document is neither), and no other column carries it — so the extraction-rejection log is the only place in the system a quote is ever stored, and it only ever holds quotes already being refused for some other reason. Consequence: testimony decay's "members whose quotes vanish flag `retracted_in_source`" has no admitted quote to test against, for any document extracted today. **E8d gives this sharper evidence than the argument above:** `document_chunks` itself carries no text column (`id`, `document_id`, `ordinal`, `hash`, `embedding` only — `migrations/0000_initial.sql`), and both live workspaces' own read-only diagnostic script demonstrates the consequence directly — it prints `chunk: undefined` for the one rejection row it holds, because the `DocumentChunk` the store hands back has no `text` field to print. See item 18 below.
14. **Taint enforcement must land before serving, not before extraction** (§4.3, §7.6): §4.3's echo loop — episode retrieves claim E, agent restates E, post-episode extraction writes it back, α climbs — is exactly what mining LLM transcripts risks. It is safe today only because nothing serves: no retrieval or serving layer exists yet, so the graph tells an agent nothing and there is nothing to echo. `observationWeight` already takes a `tainted` flag, but nothing in the codebase calls `store.isTainted`; the boolean `submitClaim` passes into that parameter today is the stage-0 `duplicate` flag (§5.1's replay dedupe), not §4.3's retrieval-context taint — a different question with a same-shaped answer. The moment a serving layer exists, transcript extraction (§5.11) becomes an echo amplifier unless `isTainted` gates the weight before then.
15. **`kgmem reflect` exits 0 on transient extraction failure** (§5.10, §9): a thrown `Extractor` is caught inside the drain and turned into a handed-back or parked job, never rethrown, so a run where every chunk's model call fails — a full outage, or every answer truncated at the output budget — still reports success: exit 0, "reflected over N chunks: 0 members admitted, 0 rejected." `kgmem reflect`'s own implementation argues the *unconfigured* case must not exit 0 for exactly this reason — a cron entry or session-end hook reads a 0 as an empty backlog — but the transient-failure case has the identical shape and does exit 0 today. No ruling has been made on it. *Confirmed unchanged by E8a–E8c: `runReflect`'s catch and `workChunk`'s `handBack` are exactly as described above, and E8d's clean run never exercised this path either way.*
16. **The verbatim gate rejects a one-character case change at a span boundary** (§5.10, §12): E8d's single rejection was the model sentence-casing a mid-sentence span's leading letter (`the upper cone…` → `The upper cone…`) to make it read as a standalone sentence — a real span, a sound claim, discarded over one byte. `extraction.ts`'s head docblock already argues the gate's byte-exact reading is deliberate, not decided here again. This is a different failure from E7d's one rejection, where the model resolved a pronoun inside the quote (`it needs…` → `the graph needs…`) — that mode did not recur under E8b's prompt rewrite. Recorded as a measured cost of the existing ruling, not a new defect: two live runs, two rejections, two distinct ways a model tidies a quote it should have left alone.
17. **`mentionsAbsent` has no live coverage** (§5.10, E8b): E8b's prompt fix removed the cause upstream of its own gate — zero of E8d's 101 proposals carried an empty `mentions` list — so `doorRefusalFor` (`extraction.ts`) has been exercised against a live model only in its non-triggering branch; every other test is against an injected `fetch`. Worth recording because a future prompt regression reintroducing E7d's `mentions` failure is exactly what this reason exists to catch, and nothing has yet caught it live.
18. **A rejection row cannot be adjudicated from the store alone** (§5.10, §13): `document_chunks` holds `(id, document_id, ordinal, hash, embedding)` and no text (`migrations/0000_initial.sql`) — a chunk's text is derived from the document, never stored, by §5.10's own "chunk, embed, anchor" design. So an `extraction_rejections` row anchors to a chunk by ordinal and hash but cannot show what that chunk said: diagnosing *why* a rejection fired needs the source document open beside the store. Not a bug — item 13 already argues the quote itself is deliberately unstored — but a real constraint on §13's structure audits, confirmed directly by both live workspaces' own diagnostic script printing `chunk: undefined` for the rejection it reads back.
19. **A referent minted for want of an adjudicator cannot be told apart from one a configured model genuinely could not resolve** (§5.2, E9a): rung 4's outcome carries only the rung reached (`tiebreak` or `minted`) and the referent it produced — nothing marks *why* the tiebreak declined. An unconfigured stub and a configured adjudicator that looked at the same candidates and still could not choose both return `{ outcome: 'unresolved' }`, both mint through the identical path, and the referent that results carries no field distinguishing the two afterward. The fact is therefore not recoverable from the ledger once the write completes — E9a's own coverage-gap fix is the demonstration: every fixture adjudicator that declines, whether standing in for "unconfigured" or for "configured and genuinely undecided," was bit-for-bit the same verdict, and telling the two apart in a test at all took inventing a third fixture that resolves instead, because no observation available at rung 4 does the telling. Consequence for an operator: a default install quietly accumulates provisional referents that a configured adjudicator would have merged, with nothing recorded to say that absence is why. Any future audit of "how many referents this graph minted with nobody to ask" has to capture the fact at the write-time seam, in `resolveSurfaceForm` or its caller — it cannot be reconstructed afterward from what is written today. No fix is proposed here.

## 15. Constants (all ⚙ unless noted)

| Symbol | Meaning | Initial |
|---|---|---|
| α₀, β₀ | prior | 1, 1 (inferred tier: β₀ = 2) |
| tier weights | verified / observed / inferred | 3.0 / 1.0 / 0.5 |
| episode cap | repeat contributions per episode | 1, ½, ¼, … |
| τ_promote | provisional → active | 0.80 |
| τ_dispute | posterior floor before dispute | 0.65 |
| episode rule | distinct contradicting episodes | ≥ 2 (fixed by design, not tuned) |
| γ | churn retention per touching commit | 0.8 |
| cos_floor / k_sem / cand_cap | candidate retrieval | 0.70 / 10 / 15 |
| B / ε | traversal beam width / slack | 8 / 0.05 |
| hub cap | expansions per high-degree entity | 32 |
| δ_max | cluster diameter (max pairwise cosine distance) | 0.35 |
| facets | centroids per entity | ≤ 4 |
| TTL_disputed | sessions before auto-deprecate | 10 |
| push_budget | ambient injection tokens per session (§7.6) | 1,500 |
| entail_floor | span ⊨ member gate at extraction (§5.10) | 0.90 |
| coverage_floor | extraction coverage below which health renders "unaudited" (§7.7) | 0.40 |
| health_rev | document health threshold triggering revision queue (§7.7) | 0.60 |
| disc_floor | grouping-claim discrimination floor (§8.8) | 0.30 |
| min_extension | members × distinct scopes to mint a concept (§8.8) | 3 × 2 |
| def_rev_cap | definition revisions before forced split (§8.8) | 3 |
| δ_div | member-pair separation threshold, disjoint-evidence batch check (§8.4) | 0.25 |
| band_shares | budget fractions floor / anchor / ancestors / concepts, per hint (§7.8) | hint-tuned |
| overlap buckets | full / partial / tangential weight (§4.6) | 1.0 / 0.5 / 0.2 |
| τ_event | P(contradict) for a discrete contradiction event (§4.6) | 0.60 |
| γ_episode / γ_artifact / γ_channel / γ_agent | pathway marginal-gain decay per level (§4.7) | 0.5 / 0.5 / 0.7 / 0.85 |
| ws_reset | counter reset factor on world-state change (§4.7) | 0.5 |
| map_build | SessionStart locator-map build gate, large repo (§7.6) | ≤ 200 ms |

## 16. Amendment log

**v0.1.0 — frozen baseline (2026-08-04).** Consolidates the design sessions to date. Amendments absorbed into this baseline, with origin:

- **A1 — taint exemption for fresh verified evidence** (§4.3): from the cold-debugging walkthrough; without it, agents cannot resolve the disputes they investigate.
- **A2 — unconditional dispute on verified-tier contradiction** (§5.6): from the confident-and-wrong walkthrough; posterior- and episode-gates alone let a high-α wrong claim survive a verified refutation.
- **A3 — neighbour-expanded churn decay** (§4.5): same walkthrough; provenance-scoped decay is blind to drift from outside the provenance set.
- **A4 — re-verification sampler** (§9): same walkthrough; old, high-α, low-churn claims are the highest-risk population precisely because nothing disturbs them.
- **A5 — kind-compatibility adjudication** (§5.4): fact-vs-rationale contradictions classify as REFINES-adjacent; intent and behavior legitimately diverge.
- **A6 — accountable-merge consolidation** (§8): replaces "consolidation is belief-neutral compression of form," which fails at ≥100k claims — the partition is belief; merges become falsifiable identity claims with member-level evidence and divergence-triggered splits.
- **A7 — vector-steered traversal as gated Mode C** (§7.3): third retrieval mode for lateral/cross-scope queries; facet-centroid substrate maintained from day one, traversal implementation gated behind evaluation evidence.

**v0.1.1 (2026-08-22).**

- **A8 — transports, not truths** (§7.6, §5.9, §7.5, principle 12): MCP tools and host lifecycle hooks become two transports over one serving layer and one write pipeline. Read side: ambient injection (SessionStart / UserPromptSubmit / PreToolUse) under conservative push budgets, with pull remaining the expressive channel. Write side: enqueue-only hook capture into the episode log, verification-task routing for automatic dispute closure, and user-correction capture. Taint generalizes to serving time on every transport; session hooks become the episode clock's event source; fail-open reads, best-effort capture. Motivated by the elective-tool starvation failure: agents empirically under-call voluntary memory tools.

**v0.2.0 (2026-08-22).**

- **A9 — documents as evidence-free views** (§3.6, §5.10, §7.7): documents are hand-authored or materialized canonicals holding no evidence of their own; assertions extracted lazily as span-anchored member claims (claim-with-quote + entailment gate); derived, coverage-aware health with span-level staleness flags and revision queues; testimony decay on document edits; one-episode evidence capping; serve-time dedup and prose-never-outranks-evidence. Closes the §8.6 gap: documents are the compression ladder's top rung for rationale/intent.
- **A10 — verticals generalized; the taxonomy is belief** (§3.7, §8.7–8.8, principle 13): a vertical is a zoom edge, an applicability direction, and a level discipline; inventory of four (containment, consolidation, conceptual, temporal-vestigial) with an eval-detectable admission test and a single-anchor rule. Emergent coarse structure is minted as grouping claims — identity machinery with the prior inverted (scope dispersion, not provenance overlap), intensional definitions with near-miss discrimination, membership-by-entailment as the divergence statistic, rent-paying α via verified transfers, and thrash floors. §8.7 promotion routes to scope or concept by the generalization's extent.

**v0.2.1 (2026-08-22).**

- **A11 — cold start is emergent** (§8.9): no cold-start mode; write-path dedupe carries low density; the consolidator is one episode, so cluster-and-link falls out of the evidence machinery; parse-before-claims bootstrap; retrieval pressure directs attention, never lowers bars. Resolves §14.2.
- **A12 — identity divergence, two layers** (§8.4): event-level differential verdicts on the write path (inheriting tier weights and A2) plus calendar-clock batch separation over disjoint evidence; identity verification tasks as their own episode; splits partition by polarity affinity with no evidence reattribution. Resolves §14.1.
- **A13 — gather bounding** (§7.8): budget-linear, size-independent retrieval via fixed band shares, governance-vs-analogy vertical asymmetry (concept depth-1 with spillover), precomputed subtree concept sets, serve-once identity across bands. Resolves §14.7.

**v0.3.0 (2026-08-30).**

- **A14 — soft evidence** (§4.6, §5.4): pair-encoded verdict distributions, discretized overlap buckets as Jeffrey conditioning, atomization-beats-weighting routing; posteriors-only, lifecycle hard-gated; shipped as logged plumbing behind `soft_updates` pending harness validation.
- **A15 — pathway-saturating independence** (§4.7, §4.4): nested pathway signatures (channel and agent join provenance), per-claim×cluster counters with saturating marginal gains symmetric on β, world-state resets, near-verbatim detection, diversity disclosure; unifies taint, episode caps, per-artifact caps, and source trust as special cases; plumbing in v1 behind `pathway_saturation`.
- **A16 — domain neutrality by schema-room** (§3.1, §3.2, §3.5, §3.7): levels as pack-declared data, opaque nullable locators, `artifacts`/`changeEvents` provenance names, all-asserted spine as first-class zero-adapter mode; exactly one shipped pack (code), parser direct-wired, **no adapter layer** — domain add-ons are integrator-owned, never a build obligation; corrects the federation note's claim that kind was the only code-flavoured surface. Origin: implementation back-annotation at commit 25.
- **A17 — backfill ingestion** (§5.11): the two clock replays, tier-faithful transcript extraction, session-chain collapsing, backfill namespaces, re-verification worklists, interview/exploration channels, importance-ranked budget, measured readiness.

**Numbering note.** Amendment numbers are now allocated solely by the repo's spec log (which had independently reached A24 via back-annotation when these docs held A14–A17). Doc entries from v0.4.0 onward are *named*; the repo log assigns their numbers on sync.

**v0.4.0 (2026-08-30) — named amendments.**

- **Fast lane as materialization; floor as view** (§3.1, §7.1, §7.6, principle 14): no locator queries or indexes in the store — locator is opaque claim content; deterministic content-hash ids make re-parse an upsert; PreToolUse runs on a SessionStart-built adapter-owned in-memory map invalidated by change events; churn joins on provenance artifacts, never entity locators; the structural band carries an as-of marker with change-feed-triggered incremental re-parse. Deletes locator_key/locator_value, their index, and getEntitiesByLocator.
- **Claims as the sole primitive** (§3.1–3.3, §3.5, §3.7, §14.3, principle 14): parser and resolution emit existence and containment claims through the one pipeline; the entities and CONTAINS tables are re-contracted as materialized referent indexes, rebuildable from the ledger; aliases are identity claims about names; asserted boundaries are ordinary evidence-bearing claims from day one — the §14.3 migration machinery is deleted. One substrate, two regimes: the parsed/Bayesian epistemics split is preserved exactly.

**v0.5.0 (2026-08-31) — named amendment.**

- **Referents from nouns** (§3.1, §3.2, §5.2, §10, §11, registry): the entities table becomes the coreference index over noun mentions; unresolved mentions mint provisional existence claims promoted by corroborated recurrence and merged/split by identity claims; names are derived; levels nullable; ground truth reframed as a privileged noun source, unifying all-asserted and noun-emergent modes; `claims.scope` FK dropped and existence claims self-anchored; triage deleted as a structure. Origin: the FK-inversion finding at implementation.

**v0.5.1 (2026-08-31) — named amendment.**

- **Storage as recipe** (§11, §14.8): SQLite marked as the potentially temporary local recipe; local/team/enterprise recipes behind the store port; export-import-rebuild migration pathways as first-class; query-shape logging from day one; scale targets (hosted, gigantic codebases, billions of claims) recorded as requirements on the final system.

**v0.6.0 (2026-08-31) — consistency pass.** Full scan after the v0.4–v0.5 rulings; contradictions resolved: (1) principles 2 and 11 still named a core parser — now noun sources via the ingest port; (2) §3.1/§3.5 still carried `origin` and `aliases` — replaced by derived `regime` and the mention index, `level` nullable; (3) §3.7 and A16 said "one shipped pack, parser direct-wired" — superseded: language-free core, code recipe as external emitters; (4) §5.10/§5.11 still referenced triage — extraction failures go to a rejection log, referents to the provisional population; (5) §7.6 still described PreToolUse as a `ref.path` store lookup — now the session map; (6) §4.5/§9/§10 named git hooks as core — now change-feed events from an external emitter. A16's historical text stands as history; this entry supersedes it.

**v0.7.0 (2026-09-02) — named amendments.** Nine named code rulings and one storage invariant absorbed, made where this spec was silent or where code and spec disagreed, plus three back-annotations already numbered in the repo log (A22, A24, A25); the code's behavior is canonical and this pass brings the text into line with it.

- **A22 — embedding width unconstrained in schema, enforced at the store boundary** (§3.2, §11): `Claim.embedding` and `Entity.glossEmbedding` are bare `z.array(z.number())`; a fixed width is the store's fact to enforce, by a typed refusal (`DimensionMismatchError`), not the schema's to declare.
- **A24 — edge vocabulary derived from §3.3's table** (§3.3, §3.5): §3.5's Zod block never carried an edge schema; `LiveClaimEdgeKind` is derived from §3.3's table rather than declared a second time.
- **A25 — `Entity.id`/`Claim.id` are ULID-shaped, minted two ways** (§3.2, §3.5, §11): typed `z.string().ulid()`, but the arithmetic behind the type differs by origin — a fresh, monotonic ULID for a usage-emergent mint (nothing to hash yet), a content-addressed hash of the declaration for a parsed or attested existence claim or a naming claim (the declaration is the identity). Same 26-character Crockford base32 shape, different mechanism.
- **Naming corroboration is evidence** (§3.1): the mention index caches a naming claim's posterior, not a use-count; writes are absolute, not increments, so twelve repeats of one name inside one episode do not outweigh four namings spread across four episodes.
- **A derived name's tie-break is the surface form, not the naming-claim id** (§3.1): the id hashes the referent id, which is a content hash only for a noun-attested referent and a fresh ULID otherwise — tie-breaking on it would make the derived name a coin flipped separately per database. Breaking on the surface form itself answers the same way in every database that saw the same naming claims; measured disagreement between the two tiebreaks was 258 of 500 referents.
- **Taint is keyed by the episode, not the host session** (§4.3, §7.5): v1 maps one host session to one episode (A17), so the two coincide at this grain; where they diverge, chained sessions collapse into one episode and share one taint set.
- **An orphaned pathway signature is refused** (§4.4, §4.7/A15): `putClaim` rejects a pathway signature that carries a channel or an agent but no provenance axis to attach either to — `OrphanedSignatureError`, not a silent drop.
- **Ambiguity escalates the ladder only on plurality at the same strength** (§5.2): rungs 1 and 2 share one read and escalate to the LLM tiebreak only when more than one contender ties at the strongest match; a canonical-name match always outranks any number of alias or mention-index matches regardless of count. The alternative — escalate on any plurality — was rejected on principle 10's cost.
- **De-attestation reaches every referent a form names, and reinstatement is in place** (§3.1, §6.2): withdrawing a `(source, form[, locator])` naming reaches every referent that form names; a referent's regime falls to evidence only when its last live attestation drops. A successor evidence-regime claim seeds from the retired one it replaces via `DERIVED_FROM` where one exists, or a bare §15 prior otherwise — a withdrawal is not a vote against the referent. §6.2's no-resurrection rule is scoped to the evidence regime only; re-attesting a retired view claim reinstates it in place rather than minting a successor.
- **Facets are maintained on the write path, and a rebuild does not reconstruct them** (§3.1, §9, §11): nearest-centroid-above-`FACET_ASSIGN_FLOOR`, else a new centroid while under `FACET_CEILING`, else the nearest centroid unconditionally; the mean updates incrementally, `m ← m + (x − m)/(n + 1)`. Spine claims never contribute; a rebuild folds nothing into facets and a retraction never backs a contribution out — both repairs are left to the calendar-clock re-clustering. An exact tie keeps the older centroid. Facets are the one entity field `rebuild-index` does not reconstruct.
- **Containment: a null `childLevel` never unplaces, and retirement takes the edge with it, conditionally** (§3.3): immediate materialization of an evidence-regime containment claim is ratified for v1, with a P4 revisit marked in §14. A containment claim carrying a null `childLevel` never clears a level already placed; only a non-null level overwrites. A claim leaving the live set takes its `contains_index` row with it, but only when no other live claim still asserts that pair.
- **The ledger scan is real** (§3.1, §11): `listClaimIds`/`listEntityIds` are real keyset-paginated enumerations, draining to an empty page; they replace an ANN-KNN probe that was never an enumeration at all — the first page of one, capped at what the vector index would accept as `k` and silently truncated past it. §3.1's and §11's rebuildability guarantee holds from this fix forward.
- **Regime rides the ledger row** (§3.1, §3.2, §11): a claim's `evidence` is nullable by regime — `null` for a view claim, populated for an evidence claim — as a storage invariant enforced by a table constraint and a typed refusal, "nothing is ever both, and nothing is ever neither." The referent index materializes a claim's regime; it does not own it.

**v0.8.0 (2026-09-06) — extraction adapter back-annotation.** §5.10 gains a real, non-fixture `Extractor` (`AnthropicExtractor`, one call per chunk against Anthropic's Messages API), shared verbatim by §5.11's transcript extraction; its byte-exact quote gate and tier rubric are as designed, but extraction quality is unmeasured — every test injects `fetch`, and no chunk has been sent to the live API. §14 gains four open items the adapter surfaced: extractor model choice is not configurable end-to-end; an admitted claim's quote is stored nowhere, so testimony decay's `retracted_in_source` flag has no admitted quote to test against; taint enforcement (§4.3) must land before a serving layer does, not before extraction, and is safe today only because nothing serves; and `kgmem reflect` exits 0 on transient extraction failure the same way its own unconfigured-extractor argument says it must not.

**v0.9.0 (2026-09-12) — the first live run, its fixes, and a second live run against them.** E7d (2026-09-06, 23 chunks, 37 calls, $0.1767) is the first live call against §5.10's extractor and found defects: an embedding-width default (`NomicEmbeddingProvider`) pinned to the ANN index width rather than the store's persisted width, failing `kgmem ingest` on every fresh install (E8a); a prompt that sanctioned an empty `mentions` list against a schema (`ClaimMessage.mentions`) that rejects one, whose mid-batch throw silently starved the rejection log of a genuine failure in the same batch and duplicated eight already-committed member rows on retry (E8b); and 35 of 225 proposals tiered `observed` from a document with no tool output, for want of a tier default (E8c). E8d re-ran the identical 23 chunks after the fix: zero mistiered proposals, zero duplicate rows, 23/23 chunks completed against 19/23, zero retries, $0.1130 against $0.1767. §5.10 and §5.11 are back-annotated with both runs' headline numbers, including the caveat that only document-chunk extraction has live evidence — transcript-chunk extraction does not yet. §14 gains sharper evidence for item 13 (the stored-nowhere quote) and three new items: the verbatim gate's byte-exact rejection cost (16), `mentionsAbsent`'s want of live coverage (17), and a rejection row's dependence on the source document for audit (18). Items 12, 14 and 15 were checked against current code and stand unchanged by E8a–E8c.

**v0.9.1 (2026-09-12) — the unconfigured adjudicator declines instead of refusing (E9a).** §5.2's rung 4 stub for a repository naming no `models.adjudicator` — every fresh install — used to reject with `UnconfiguredPortError`; `ladder.ts` awaits it with no `catch`, so the first mention reaching a genuine plurality of equal-strength candidates aborted the write it was in the middle of, and because `submit` is not transactional an ambiguity on a claim's second mention left the first mention's referent, naming claim and mention row committed with no claim row to show for them. `kgmem reflect`'s drain classified the rejection as transient, burning a retry per chunk per run under an exit code of 0 until §9's cap parked every chunk for good — a default install silently mining nothing. Renamed `decliningAdjudicator`, the stub now resolves `{ outcome: 'unresolved' }`, the verdict §5.2 already ruled for a rung with nobody to ask, back-annotated into §5.2's body by this entry. A mutation pass over the pre-existing suite found the reason nothing had caught it: every fixture adjudicator, including every test written before this fix, declines by default — bit-for-bit the unconfigured stub's own verdict — so a mutant discarding a *configured* `models.adjudicator` outright survived all 93 tests across eight files; closed with a new fixture, `resolving-adjudicator-module.ts`, that resolves instead of declining. §14 gains one new item (19): the fix is silent by design, and closing the coverage gap showed the same indistinguishability holds in production — a referent minted for want of an adjudicator cannot be told apart, after the fact, from one a configured model genuinely could not resolve.

Future changes: append named entries here; the repo log owns numbers.
