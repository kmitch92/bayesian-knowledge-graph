# kg-mcp — glossary

**Doc version:** 1.6 · **Date:** 2026-09-02 · (1.6: consistency pass with spec v0.7.)
**Companions:** reference spec v0.7.0 · v1 implementation plan 1.6 · emergence & federation note 0.6
**Conventions:** §refs point at the spec. *(fed)* = federation note. *(plan)* = implementation plan. *(discussion)* = established in design conversation, not yet in any doc — usually an amendment candidate. Terms are grouped thematically, alphabetical within groups.

## 1. Foundations

**Index-free adjacency** — the native-graph-DB storage property where each node physically holds pointers to its relationships, making a hop constant-time rather than a join; the origin of the "cost depends on what you touch" promise this system preserves at retrieval (§7.8).

**Labeled property graph (LPG)** — the storage model: typed nodes and edges with properties. The schema is deliberately plain LPG so the store is swappable (§11).

**Reification** — promoting a relationship to a node in its own right. The founding data-model move: rich claims cannot live on edges (flat key-value properties, exactly two endpoints), so every claim is a node — which is also what gives every "edge" an embedding for free (§3.2–3.3).

**Search-space collapse** — the system's value target: retrieval doesn't answer questions, it reduces "the whole repo" to "check this one interaction" (§1).

## 2. Data model — nodes and edges

**ABOUT** — claim → entity edge (1..n targets); what a claim references. Exactly one target is the scope anchor (§3.3).

**Alias feeding** — *superseded in v0.5*: name variants are identity claims over names, materialized in the mention index (§3.1, §16).

**Artifact (vs assertion)** — non-propositional document content (command sequences, config examples). Carries no posterior; *claims about it* carry the evidence (§3.6).

**Evidence regime (referent)** — a referent no noun source attests: its existence claim carries a posterior and is disputable and splittable like any claim (§3.1, principle 14). Replaces the old `asserted` origin.

**Canonical view** — consolidator output rendered over live member claims; holds **no evidence of its own**, displays conservative pooling plus disclosure integers (§3.4, §8.3).

**Claim** — the fat node: one unit of non-parsed knowledge with text, embedding, kind, tier, status, α/β evidence, scope anchor, temporal window, provenance, canonical flag (§3.2).

**Containment spine** — the entity hierarchy workspace → repo → system → component → module → symbol, connected by `CONTAINS`; the structural backbone and gather's workhorse (§3.1).

**DERIVED_FROM** — lineage edge: canonical → absorbed raws; resurrection successor → corpse (§3.3).

**Entity** — identity, not knowledge — and as of v0.4, not a primitive: a **materialized referent-index row** over existence claims, rebuildable from the ledger. Still deliberately description-free — summaries materialize from canonicals so they can't drift (§3.1, principle 14).

**Epistemic kind** — `fact | convention | rationale | risk | intent | coupling`: how a piece of knowledge functions, driving hint biasing and adjudication compatibility. A property, deliberately *not* a layer or vertical (§3.2, §3.7). The one honestly code-flavoured enum — per-domain packs in federation (fed §7).

**Facet centroids** — 1–4 cached centroid vectors per entity summarizing its attached claims' embedding clusters; O(1) mean-updates on write, re-clustered on the calendar clock. The traversal-lookahead and concept-admission substrate (§3.1, §7.3, §7.8).

**Gloss embedding** — embedding of an entity's name plus one-line gloss; used for anchor resolution and vague-query entry (§3.1).

**Grouping claim** — "these members instantiate one coarser node on vertical V": the identity-claim machinery with the proposition changed from *same statement* to *same kind*. Carries an intensional definition; membership is definition-entailment (§8.8).

**Identity claim** — first-class claim asserting "these member claims state the same proposition," with its own α/β and lifecycle. Merges execute on its promotion and reverse on its contradiction (§3.4, §8.2).

**MERGES** — identity/grouping claim → member edges (§3.3).

**View regime (referent)** — a referent attested by an external noun source (e.g. a tree-sitter emitter): re-derived on change-feed events, no confidence machinery, served with an as-of marker. Replaces the old `parsed` origin. See *structural floor*.

**Provenance** — episodes, changeEvents, artifacts (and, in federation, store-namespaced content-addressed refs) backing a claim; feeds churn decay, independence discounting, and merge priors (§3.2).

**Scope anchor** — the single spine entity where a claim *lives*, distinct from its wider ABOUT set. One per claim, per the single-anchor rule (§3.2, §3.7).

**Spine relaxation** — *retired: resolved by principle 14.* Asserted strata are ordinary existence claims already; no migration remains — parsed levels alone keep deterministic content-hash ids (§3.7).

**STATED_IN** — extracted member claim → document edge, span-anchored (§3.3, §5.10).

**Structural floor** — the materialized view of parsed existence/containment/structural claims: re-derived on change-feed events, served without α/β and **with an as-of marker** (§3.1, §7.1, principle 14).

**SUPERSEDED_BY** — resolution outcome edge: loser points at winner (§3.3).

**Triage queue** — *deleted in v0.5*: unresolved mentions now mint provisional referents instead of parking (§5.2, §16 below).

## 3. Evidence model

**Atomization vs weighting** *(discussion, A14 candidate)* — the routing rule for partially-bearing evidence: if it addresses a *separable* sub-claim, split via REFINES (make full-weight updates true); only genuinely diffuse bearing gets Jeffrey-weighted.

**Beta-Bernoulli evidence** — each claim's confidence is a Beta posterior: supports increment α, contradictions increment β; confidence is the posterior mean and the width always travels with it (§4.1).

**Churn decay** — commit-clock evidence shrinkage toward the prior (γ ≈ 0.8 per touching commit) when change-feed events touch a claim's provenance artifacts. Toward the prior, never zero: churn restores uncertainty, it doesn't falsify (§4.5).

**Conservative pooling** — a canonical's displayed evidence is the deduplicated, episode-capped union of member provenance — never the sum of member counts (§8.3).

**Correlated-evidence discount** — provenance-overlap-based down-weighting of contributions that share sources; the cross-episode sibling of episode caps (§4.4).

**Decay-then-refine** — the standard fix pattern: a landed fix decays the old claim (its truth changed) and the reflector writes the `REFINES` successor seeded from its posterior (§4.5).

**Episode cap** — repeat contributions from one episode weight 1, ½, ¼, …: saying something three times in a session is one observation (§4.2).

**Evidence attractor** — merged-canonical failure where support for facet A silently strengthens facet B through the shared node; killed by member-level routing (§8.3, §12).

**Evidence shielding** — the mirror failure: a refutation of B absorbed by A's pooled α; same fix (§8.3, §12).

**Jeffrey conditioning** *(discussion, A14 candidate)* — the classical treatment of uncertain/partial evidence; fractional pseudo-counts in a Beta are its conjugate-friendly implementation, which is exactly what the `w` multiplier chain already is.

**Overlap bucket** *(discussion, A14 candidate)* — coarse adjudicator-assigned bearing of evidence on a target: full / partial / tangential → {1.0, 0.5, 0.2}⚙ as a `w` factor. Discretized precisely to avoid the miscalibrated-scalar ("vibes") problem.

**Posterior width** — the credible-interval width served with every mean, distinguishing "0.7 from one look" from "0.7 from forty"; wide means verify-before-relying (§4.1).

**Skeptical prior** — inferred-tier claims seed β₀ = 2 (§3.2).

**Soft verdicts / soft evidence** *(discussion, A14 candidate)* — replacing winner-take-all verdicts with a pair-encoder distribution: Δα ∝ w·P(entail), Δβ ∝ w·P(contradict). Moves posteriors only; lifecycle stays hard-gated.

**Taint / taint set** — the server-side record of claim ids served to an episode, on any transport (v1 maps one host session to one episode 1:1, so a chained session collapses to the one episode and shares its taint set). An episode that had E in context cannot corroborate E at inferred tier (weight 0). The echo-loop killer; cannot be retrofitted (§4.3, §7.5).

**Taint exemption (A1)** — verified-tier evidence with *fresh provenance* (a test that didn't exist before) counts even when the claim was in context; without it, agents can't resolve the disputes they investigate (§4.3).

**Testimony decay** — the doc-side sibling of churn decay: document edits decay members' doc-sourced contributions; vanished quotes flag `retracted_in_source` without auto-deprecating the claim (§5.10).

**Tier** — evidence quality class: `verified` (3.0) / `observed` (1.0) / `inferred` (0.5); the quality axis of the whole epistemics (§3.2, §4.2, §6.3).

**w (evidence weight)** — `tier × episode_cap × taint` (× overlap, if A14 lands): the multiplier on every α/β update (§4.2).

## 4. Write path and adjudication

**Adjudicator** — the small fast model that classifies candidate pairs with polarity awareness; the one inline LLM call. A port with a replay implementation in tests (plan §2).

**Bi-encoder vs cross-encoder** *(discussion)* — independent embeddings vs joint pair-encoding. Bi-encoders are polarity-blind; cross-encoders (NLI-style) read both texts and emit entail/contradict/neutral — the legitimate "direction" for a pair.

**De-deixis / normalization** — rewriting a claim into a self-contained declarative sentence at write time, the only moment referents ("this handler") are recoverable (§5.2).

**Dispute check** — the post-β status rule: verified contradiction disputes unconditionally (A2); otherwise posterior < τ_dispute or ≥ 2 distinct contradicting episodes (§5.6).

**Kind-compatibility (A5)** — a verified *fact* contradicting a *rationale* is REFINES-adjacent ("the intent exists but isn't implemented"), not CONTRADICTS: intent and behavior legitimately diverge (§5.4).

**Polarity blindness** — the founding lesson: "X is idempotent" and "X is not idempotent" embed nearly on top of each other, so embeddings gate candidates and can never adjudicate (§5.4).

**Resolution ladder** — candidate retrieval for coreference: exact name → mention index → embedding → LLM tiebreak; below threshold, a provisional referent is minted (§5.2).

**Stage-0 dedupe** — `hash(normalized_text) + episode_id` at the pipeline front; agents retry, and retries must not double-count (§5.1).

**Verdicts** — DUPLICATE / SUPPORTS / CONTRADICTS / REFINES / UNRELATED, each with fixed graph mutations and evidence updates (§5.5).

**Verification task** — emitted on dispute: "run the test, read the code." Identity disputes get their own deep-re-adjudication variant counting as its own episode (§5.6, §8.4).

**Write path** — the seven-stage synchronous pipeline every observation passes through regardless of transport: dedupe → normalize/resolve → embed/retrieve → adjudicate → apply verdict → update evidence → dispute check (§5).

## 5. Claim lifecycle

**Live rival** — a contradicting claim inserted alongside the standing one; contradictions never edit or delete, because the new observation might be the wrong one (§5.5, principle 6).

**Resurrection** — a deprecated claim is never flipped back; new evidence mints a successor `DERIVED_FROM` the corpse, seeded from its old posterior — history stays linear (§6.2).

**Status × verdict matrix** — the §6.2 table: every (lifecycle status, incoming verdict) cell's mutation and evidence rule; also the v1 test table (plan §5-P3).

**Tier privileges** — verified flips status alone; observed needs the 2-episode rule; inferred never flips status by itself. "Quality gates status; quantity moves posteriors" (§6.3, principle 5).

**"True but confusing"** — a claim that keeps attracting contradictions and keeps surviving verification; its retained β is signal, not noise (§6.5).

**Zombie dispute** — a disputed claim nobody verifies; TTL auto-deprecates after N sessions, served flagged meanwhile (§6.4).

## 6. Retrieval

**Anchor** — the spine entity a query resolves to; when multiple levels match, the most specific wins and inheritance supplies the rest (§7.1).

**Band shares** — fixed per-band budget fractions (structural floor / anchor / ancestors / concepts), hint-dependent; ranking happens within bands, never as an open union (§7.8).

**Bridge claim** — a bland claim standing between the query and a relevant region ("BatchImportHandler calls RetryWrapper"); fatal to greedy traversal, survived via beam-with-slack and facet lookahead (§7.3).

**Budget-linear retrieval** — the §7.8 invariant: cost scales with budget, not graph size.

**Depth-1 with spillover** — concept-band admission: a concept enters only when instanced by already-selected claims or query-matched to its definition; its `SPECIALIZE` ancestors enter only on underfill (§7.8).

**Drill-down** — the elective deep read: raws behind canonicals, documents behind members (§7.1, §10).

**Governance vs analogy** — why verticals contribute asymmetrically to gather: containment inheritance *binds* (full ancestor chains), concept inheritance *informs* (depth-1) (§7.8).

**Hint biasing** — `debugging | planning | implementing` re-weighting kinds at score time (§7.1).

**Mode A / B / C** — spine gather (default); ANN entry for vague queries; vector-steered lateral traversal (gated behind eval evidence) (§7.1–7.3).

**Rivals travel together** — if one side of a live dispute makes the budget cut, the other rides along or the pair collapses to a "contested: A vs B" line; budget pressure compresses disputes, never drops a side (§7.4).

**Serve-once identity** — dedup by claim id across all bands and verticals (§7.8).

**"Similarity steers, confidence ranks"** — vector proximity chooses where to look, never what to trust; the traversal score's posterior/status factors are non-negotiable (principle 9, §7.3).

**Three bands** — anchor-scope claims (disputes flagged), ancestor canonicals inherited down (the higher abstraction layers, essentially free), structural floor (§7.1).

**Two-hop scoring / facet lookahead** — traversal hop score `max(sim(q, claim), max_facet_sim(q, far_entity))`: relationship relevance or region-behind-the-door relevance (§7.3).

## 7. Consolidation and emergent structure

**Absorbing state** — what merges were before A6: no split path, so errors accumulated monotonically and the graph coarsened toward fewer, broader, falsely confident claims (§8, amendment log).

**Accountable merges** — the A6 redesign: the consolidator makes hypotheses like everyone else; every merge is a falsifiable identity claim, every canonical a view over live evidence targets (§8).

**Chain drift** — A≈B licenses a merge, then C≈(AB), then D≈(ABC), until A and D share nothing; capped by diameter (identity) and definition-revision depth (grouping) (§8.2, §8.8).

**Cold start (emergent)** — not a mode: write-path dedupe carries low density; consolidator jobs are scale responses whose triggering signal arrives on its own; cluster-and-link is the natural young-graph state (A11, §8.9).

**Configuration envelope** — the eagerness dial's legal range: cadence, thresholds, presentation, archive latency, per-kind overrides are free; changing belief, hiding the existence of detail, cosine-only merges, one-sided canonicals over live disputes, and unrevisable partitions are out of bounds at any setting (§8.6).

**"The consolidator is one episode"** — its re-judgments of a cluster episode-cap like any repeated source, so consolidator opinion alone can never reach promotion; the rule that makes emergent cold start true (§8.9).

**Contested summary** — the only legal compression of a cluster containing a live CONTRADICTS: both positions, both evidence sets. Contradictions are incompressible (§8.5).

**Diameter cap** — clusters bounded by max pairwise distance, with the canonical re-adjudicated against its most distant member on every accretion (§8.2).

**Differential verdict** — one piece of evidence adjudicated against multiple cluster members with non-matching polarity: a direct, attributable observation that the members are not one proposition; identity-β at the evidence's own weight (A12, §8.4 layer 1).

**Discrimination test** — a grouping claim's definition must entail members and reject sampled near-misses; discrimination = entail(members) − entail(near-misses), floored. The vacuity guard (§8.8).

**Disjoint-evidence separation** — the batch divergence layer: P(|θ_A − θ_B| > δ_div) computed over the members' *non-shared* evidence only; thin members stay quiet, fully-shared pairs contribute nothing (A12, §8.4 layer 2).

**Eagerness dial** — how aggressively consolidation runs; configurable because *both* ends fail epistemically — over-consolidation manufactures consensus, under-consolidation fragments corroboration until nothing promotes (§8.6).

**Intensional definition** — the short necessary-features text a grouping claim must carry; extension-only clusters are refused minting (§8.8).

**Invisible until active** — provisional grouping claims never serve; nothing coarse is load-bearing before it has earned promotion (§8.8).

**"The partition is belief"** — the conceded insight that reshaped consolidation: which propositions count as one unit of belief is itself a belief; per-step label-invariance does not compose into trajectory-level neutrality (principle 7, §8).

**Polarity affinity** — how splits partition members: by which side of the accumulated evidence each member sits on (§8.4).

**Rent-paying α / verified transfers** — a concept earns confidence when concept-level claims are verified at members; promotion through inferential usefulness, not clustering statistics (§8.8).

**Upward promotion** — near-identical canonicals across sibling scopes mint a generalized claim: to the containment parent when the extent is a place, to the concept vertical when the recurrence is a mechanism (§8.7).

## 8. Documents and testimony

**Authored vs materialized** — human/external documents get extraction; machine-materialized ones have members by construction and are regenerable (§3.6, §5.10).

**Claim-with-quote** — every extracted member carries its verbatim source span; the entailment gate (span ⊨ claim) guards insertion (§5.10).

**Doc health** — derived, never stored: member states plus extraction coverage; below the coverage floor it renders "unaudited," never a number (§7.7).

**Doc shadowing** — double-serving a chunk and its member canonicals; prevented by `STATED_IN` serve-time dedup (§7.7, §12).

**Entailment gate** — the NLI check between quoted span and extracted claim; false rejects starve health, false accepts hallucinate members (§5.10, §14.6).

**Lazy extraction** — members extracted per chunk on serve-and-cite, on incoming contradiction, or opportunistically — never as an inline ingest cost (§5.10).

**One-episode-per-document** — forty assertions from one ADR are one source under episode caps, not forty observations (§5.10).

**Propose-diff** — how authored documents are revised: the system suggests patches; an author's prose is never overwritten (§7.7).

**"Prose never outranks evidence"** — served chunks contradicted by higher-tier claims render the contradiction inline; document authority never rides over posteriors (§7.7).

**Testimony** — what a document's assertions are: evidence that the author said so, not that it's true. Imported stores are testimony at federation scale (fed §6).

**Testimony laundering** — re-extracting materialized documents, looping canonicals back as fresh evidence; forbidden by authored-only extraction (§5.10, §12).

## 9. Verticals, emergence, and federation

**Admission test** — a new vertical enters only if inheritance along it changes retrieval results the harness can detect (§3.7).

**Cone / narrowing DAG** — the emergent shape of the concept vertical: plural apexes, not one; "cone-like weave" is the working image, with concepts as warp across the containment weft (fed §8).

**Crystallization around a shared prior** — emergence isn't from nothing: the adjudicator's pretrained priors shape the taxonomy, which is precisely what makes independently-minted verticals entailment-compatible across stores — the LLM as universal grammar for concepts (fed §2.2).

**Diversity-driven height** — the discrimination floor refuses vacuous apexes in narrow stores; merging introduces near-misses; cone height is a function of store diversity, and each merge licenses the next stratum (fed §4).

**Domain adapters** — the four things that vary per domain: ground truth, verification, change feed, kind vocabulary. "The domain lives in the adapters; the epistemology doesn't" (fed §7).

**Evidential attenuation with height** — verified tier grounds out in operations, so abstract claims accrue evidence only through attenuating transfer chains; the upper cone is structurally humble (fed §2.1).

**Federation** — store merging as ledger union → view recomputation → ordinary cross-store consolidation; well-defined because posteriors are views over an append-only ledger (fed §5).

**Federation invariants** — content-addressed store-namespaced provenance; text-as-canonical, embeddings-as-cache; ledger-fidelity import; source trust as an explicit weight (fed §6).

**Prior drift** — adjudicator model upgrades shifting the shared prior; whether cross-generation definitions stay entailment-compatible (fed §8.5).

**Reversibility** — store namespaces on every raw make federation filterable back apart; cross-store artifacts deprecate on separation (fed §5).

**Single-anchor rule** — one containment anchor per claim; all other vertical membership by edges (§3.7).

**Source trust** — per-store multiplier on imported evidence weight; imported claims keep their tier but are discounted until locally corroborated. The least-settled federation item (fed §6.4).

**"The taxonomy is belief"** — principle 13: coarse structure of any vertical is a set of claims; any level that cannot be revised by evidence is out of bounds (§2).

**Value-density inversion** — the apex asymptotes to pretraining, so its value is the coordinate system for joining stores, not information (fed §3).

**Vertical** — an axis along which resolution declines: a zoom edge type, a direction of applicability, a level discipline. Inventory: containment, consolidation, conceptual, temporal-vestigial (§3.7).

## 10. Transports, clocks, and architecture

**Ambient vs elective** — hook-served push (conservative: tight canonicals, hard budgets) vs deliberate MCP pull (expressive: drill-down, traversal). Complements, not alternatives (§7.6).

**Channel fatigue** — ambient injection noisy enough that the agent learns to ignore served context; worse than no channel (§7.6, §12).

**Elective-tool starvation** — the empirical failure of memory MCP servers: agents under-call voluntary tools, so the graph is neither fed nor read; the motivation for A8 (§12).

**Enqueue-only capture** — write-side hooks append events to the episode log and return; all LLM work stays off the agent's critical path (§5.9).

**Episode log** — the structured record of a session's events (diffs, commands, outcomes, served claims); the reflector's raw material and the replay harness's source of truth (§5.9, plan §2).

**Fail-open / best-effort** — a dead daemon degrades to a memoryless agent, never a blocked one; capture loses events, never blocks (§7.6, §5.9).

**One-clock test** — every mechanism hangs off exactly one clock (episode / commit / calendar); needing two means it's two mechanisms (§9).

**Reflector** — post-session extraction of 2–3 claims from the episode log through the normal pipeline; restatements of taint-set claims land as weight-0 raws (§9, §14.5).

**Retrieval echo loop** — retrieve → restate → re-write → rank higher → retrieve more: the graph becoming confident in whatever it already believed; killed by taint (§4.3, §12).

**Serving layer** — the single internal retrieve() both MCP and hooks call; where taint is recorded, on every transport (§7.5–7.6).

**Single choke point** — only view-regime attestations from noun sources and churn decay mutate the graph without adjudication; every other belief change passes through the write path (principle 11).

**Sync-cheap, async-expensive** — the inline path is one embed plus one small-model call; everything heavier belongs to a background clock (principle 10).

**Three clocks** — episode (evidence, taint, reflection; session hooks as event source), change feed (churn, view invalidation, decay-then-refine; external emitter events — git in the code recipe), calendar (consolidation, sampling, sweeps; cron) (§9).

**"Transports, not truths"** — principle 12: MCP and hooks are transports over one serving layer and one write pipeline; bypassing a protocol never bypasses adjudication.

**Verification-task routing** — hooks matching captured test outcomes against open verification tasks by provenance overlap; disputes close automatically (§5.9).

**Walking skeleton** — v1's shape: spine + write path + Mode A/B + taint + transports + reflector + harness, consolidator-less by A11's license (plan §1).

## 11. Named failure modes (the sneaky ones)

**Biased doc health** — health computed over the contested chunks lazy extraction audits first (§12). **Confident-and-stale** — semantic drift from outside a claim's provenance set; the hot-reload-in-a-new-module case (A3, §12). **Consolidator self-corroboration** — nightly re-judgments climbing to promotion (§8.9, §12). **Divergence blindness** — co-fed members co-moving, hiding disagreement (A12, §12). **Entity fragmentation** — `AuthService` / `auth-service` / "the auth thing" as three subgraphs (§5.2, §12). **False consensus, read-side** — budget cuts serving one side of a dispute (§7.4, §12). **Hallucinated extraction** — phantom members corrupting health both ways (§5.10, §12). **Open-union gather** — unbounded multi-vertical ancestor unions (§7.8, §12). **Search-space poisoning** — one wrong high-α claim eliminating the true cause a priori, per session (A2, §12). **Transport taint leak** — hook-injected claims corroborated because taint tracked only the tool (§7.5, §12). **Zombie disputes** — see §5 above.

## 12. Theory and working logic

**Aufhebung / Hegelian synthesis mapping** *(discussion)* — the dialectic located precisely: Bayes is credence bookkeeping between positions; the synthesis operator is the REFINES pathway, whose disputed-resolution successor preserves what was true in both rivals, negates what was false, and lifts to a more conditioned claim.

**God's-eye antithesis rarity** *(discussion)* — exact antithesis between claims is nearly measure-zero — but tier-stratified: common at the verified/operational bottom (tests are bivalent), vanishing with epistemic altitude.

**"Strong evidence moves fast; weak evidence moves slow"** — the recurring amendment pattern (A1, A2, A12): every walkthrough fix widened the fast lane for verified evidence while keeping inference slow (principle 5).

**Tier-stratified bivalence** *(discussion)* — the dialectical structure varies by altitude: binary opposition at the bottom, synthesis in the middle, near-vacuous agreement at the apex.

## 13. Process and conventions

**⚙ (tunable)** — an initial guess, not a commitment; tuned offline by replay against stage logs, never by live surgery (§5.8, §15).

**Amendment log (A1–A17)** — the spec's record of *why* each rule exists: A1 taint exemption · A2 unconditional verified dispute · A3 neighbour decay · A4 re-verification sampler · A5 kind-compatibility · A6 accountable merges · A7 gated Mode C · A8 transports · A9 documents · A10 verticals/grouping claims · A11 emergent cold start · A12 two-layer divergence · A13 gather bounding · A14 soft evidence (gated) · A15 pathway saturation (gated) · A16 domain neutrality by schema-room · A17 backfill ingestion (§16).

**Replay tuning** — every pipeline stage logs inputs and decisions so thresholds and update rules are re-derivable against the same history (§5.8, §13).

**Seams** — the v1 structures (reserved edge types, empty tables, zero-weight config) that let deferred features slot in rather than bolt on (plan §7).

**Spec back-annotation** — implementation contradictions become amendments, never silent drift (plan §8).

**Spikes S1–S3** — adjudicator accuracy (the gate), embedding provider, sqlite-vec/PreToolUse latency (plan §4).

## 14. v0.3 additions (A14–A17)

**All-asserted spine** — the zero-adapter mode: entities minted via resolution and grouping claims, no locators, no structural floor, nothing verified; correct-and-humbler, works day one (§3.1, A16).

**Backfill namespace** — `backfill:<source>` provenance tagging; seeded knowledge stays separable from organic and reversible by filter-and-recompute (§5.11).

**Channel** — the production mechanism of a contribution (live-observe, reflector, transcript-mining, doc-extraction, …); clustered because it shares a systematic failure mode (§4.7).

**Cluster test** — same cluster iff one systematic bias would distort both contributions; when unsure, lump (§4.7).

**Commit-clock replay / retroactive decay** — seed historical evidence at its historical position, fast-forward churn decay through subsequent change events (§5.11).

**Decomposable flag** — adjudicator signal that evidence addresses a separable sub-claim → route to a REFINES split instead of overlap-weighting (§4.6).

**Effective evidence** — posteriors and widths computed from pathway-discounted counts; raw contributions stay in the ledger (§4.7).

**Episode-clock replay** — cached host transcripts ingested as historical episodes through the reflector (§5.11).

**Importance ranking** — structural centrality × churn; allocates backfill extraction and adjudication budget (§5.11).

**Interview mode** — uncertainty-directed question generation: coverage gaps at high-centrality referents, uncorroborated provisional referents, contested boundaries (§5.11).

**Locator** — opaque, nullable, spine-interpreted entity reference; the code pack defines `{ path, symbolRange }` (§3.1, A16).

**Near-verbatim detector** — suspiciously identical evidence text via nominally independent channels is itself a correlation signal (§4.7).

**Overlap bucket** — full / partial / tangential → {1.0, 0.5, 0.2}⚙ multiplier on `w`; Jeffrey conditioning, discretized against miscalibrated scalars (§4.6). *(Supersedes the §3 (discussion) entry.)*

**Pathway signature** — the nested cluster tuple on every contribution: utterance ⊂ episode ⊂ chain ⊂ artifact ⊂ channel ⊂ agent ⊂ store (§4.7).

**Pathway saturation** — a pathway's total contribution asymptotes to one reliable report from that source; marginal gains ∏γ^n, symmetric on β (§4.7, A15).

**Re-verification worklist** — mined claims cheaply checkable against the current tree, queued for the A4 sampler (§5.11).

**Schema-room** — domain neutrality as naming discipline: levels as data, opaque locators, open edge kinds, generic provenance names — and no adapter layer (A16).

**Session-chain collapsing** — resumed conversations are one episode, not several (§5.11).

**Soft verdicts** — Δα ∝ w·P(entail), Δβ ∝ w·P(contradict) from pair-encoded distributions; posteriors-only, lifecycle hard-gated (§4.6, A14). *(Supersedes the §3 (discussion) entry.)*

**Tier-faithful extraction** — transcript claims tiered by their grounding: reasoning→inferred, tool-grounded→observed, recorded test runs→verified-at-T (§5.11).

**World-state reset** — commit-clock events partially reset pathway counters: repetition across world-states is re-observation (§4.7).

## 15. v0.4 additions — the unification

**As-of marker** — the structural band's declared last-parse point; staleness labeled, never hidden (§7.1).

**Containment claim** — "X contains Y", parsed or asserted; `CONTAINS` rows are its materialization (§3.3).

**Deterministic referent id** — content hash of (level, locator) for parsed existence claims; makes re-parse an upsert and the session map cheap (§3.1).

**Existence claim** — "X exists, at level L, located at …"; the sole source of entity-hood. Parsed ones carry view semantics; asserted ones carry ordinary evidence — boundary disputes and splits apply natively (§3.1, principle 14).

**One substrate, two regimes** — principle 14: claims are the only primitive; parsed claims are invalidated (views), everything else is believed (Bayesian). The substrate unifies; the epistemics do not blur.

**Referent index** — the entities table's honest name: a materialized, rebuildable view over existence claims, kept for anchoring speed (§3.1).

**Session locator map** — the PreToolUse fast lane's actual home: an in-memory locator→referent map built by the hook adapter at SessionStart from core data, invalidated by change events; the store never queries locators (§7.6).

## 16. v0.5 additions — referents from nouns

**Coreference index** — what the entities table is: the materialized clustering of noun mentions into referents, rebuildable from the ledger (§3.1).

**Derived name** — a referent's display name is its most-corroborated surface form, a view, never an authoritative column (§3.1).

**Mention index** — surface form → referent id, cached at the weight of that pair's naming claim: an episode-capped Beta posterior written absolutely on every use, never incremented, so a naming is evidence and not a tally; materializes identity claims over names (§3.1).

**Noun source** — what ground truth is: an emitter of canonical nouns with locators, at parsed tier, acting as coreference attractors. Optional; without one, referents emerge from usage (§3.1).

**Provisional referent** — an existence claim minted from an unresolved mention; invisible to gather until corroborated across independent episodes (§5.2).

**Self-anchored existence claim** — scope = the referent it mints; no FK to the referent index — anchor integrity lives in the pipeline (§3.2, §11).

**Store recipe** — a storage configuration per use-case (local · team · enterprise/hosted) behind the `GraphStore` port. SQLite is the v1 local recipe and potentially temporary; nothing above the port may assume it (§11).

**Migration pathway** — export the ledger at raw fidelity → import into the target store → `rebuild-index`. Never a rewrite; the scaling route from SQLite to Kùzu to hosted stores (§11).

**Query-shape logging** — hop depth, fan-out, and latency per query class, recorded from day one; the evidence that decides a store swap (§11, §14.8).
