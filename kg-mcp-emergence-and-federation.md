# kg-mcp — emergence and federation

**Doc version:** 0.6 · **Date:** 2026-09-02 · **Status:** forward-looking design note — nothing here binds v1. (0.6: consistency pass with spec v0.7.)
**Companions:** reference spec v0.7.0 · v1 implementation plan 1.6

This note captures the answer to a question the spec's machinery raises but does not pursue: *would verticals emerge organically, without preconception — coarse claims grouping over granular ones, stacking until the apex of the vertical is about the discipline alone?* The short answer is yes, with two modifiers that turn out to strengthen the larger vision: a truly generalisable memory system, infinitely composable domains, and freely mergeable stores from agents working in different domains.

## 1. Emergence — what the machinery already permits

Grouping claims (spec §8.8) are recursive: concepts `SPECIALIZE` concepts, there is no level enum, and depth is emergent by construction. Nothing caps the cone's height. Recurrence plus intensional definability plus discrimination is the only ladder, and it can be climbed indefinitely — instances → patterns → principles → discipline. The question is not whether the stack *can* form but what shape and pace the evidence machinery imposes on it.

## 2. Two modifiers on "organic"

**2.1 Evidential attenuation with height.** Verified tier grounds out in operations — tests run, parses confirmed, procedures observed. A discipline-level claim can accrue evidence only through transfer chains (concept-level claims verified at members, §8.8), and each hop attenuates. The upper cone is therefore structurally low-α and wide-posterior: sparse, slow-growing, epistemically humble. This is not a defect — it is correct epistemics for abstraction — but it dictates what the apex is *for* (§3).

**2.2 Crystallization around a shared prior.** The minting judge is a pretrained model whose priors are the discipline's existing taxonomy. High-level intensional definitions are easy for it to generate precisely because it recognizes the territory, so the emergent taxonomy will look organic while substantially reproducing textbook ontology. A purist would call this smuggled preconception. For federation it is the load-bearing feature: two stores that have never communicated, minting concepts independently, converge on entailment-compatible definitions *because they share the prior*. The LLM functions as a universal grammar for concepts. Emergence here is crystallization around a shared prior — and that is exactly what makes free composition tractable rather than a schema-matching problem.

## 3. Value-density inversion — what the apex is for

The top of the cone asymptotes toward the model's pretraining: a discipline-level claim in the graph is textbook knowledge the LLM already has. The marginal information value of the memory system is highest at the boots-on-the-ground bottom (repo-specific, lab-specific, case-specific facts no model knows) and approaches zero at the apex. The apex's value is therefore not the claims but the **coordinate system**: the upper cone is the join structure that makes two stores addressable in the same terms. The graph does not need to teach an agent distributed systems; it needs "idempotency" to be the same node when two stores meet.

## 4. The central result — cone height is demand-driven by store diversity

The §8.8 discrimination floor requires a definition to entail its members *and reject near-misses*. In a single-repo store, "software engineering" has no in-store near-misses; discrimination collapses toward zero and minting is refused as vacuous. **The spec correctly refuses to build the apex while the store is narrow.** Merge a code store with an ops store or a lab-notebook store and discipline-level concepts acquire real near-misses; the floor passes; the next stratum becomes mintable.

Consequences:

- Abstraction height is a *function of the diversity of what the store has seen*, not a configuration.
- Each merge event licenses the next level of the cone. "Infinitely composable domains" and "the cone reaches the discipline" are the same event, not two features.
- No preconceived level structure is ever needed: the store grows exactly as tall as its contents can discriminate.

## 5. Federation mechanics — why merging is well-defined

Spec principle 4 (append-only ledger; canonicals and posteriors are views) pays its largest dividend here: **store merging needs no bespoke semantics.** Merge = ledger union → view recomputation → ordinary consolidation running cross-store.

- Overlapping concepts are matched by identity/grouping claims via definition-entailment — the A10 machinery, which turns out to have been built for federation.
- Cross-store contradictions arrive as live rivals and disputes — the correct arrival state, resolved by the ordinary evidence machinery, never by import-time fiat.
- Independent convergence — two unrelated codebases both concluding "handlers must be idempotent" — is genuinely independent evidence, the strongest kind. Shared concepts correctly *gain* confidence on merge.
- Common-source contamination (two stores that read the same blog post) is caught by provenance-overlap discounting (§4.4), *provided* the invariants below hold.
- Reversibility: because every raw carries a store namespace, a federated store can be filtered back apart and views recomputed. Cross-store consolidation artifacts (identity/grouping claims spanning namespaces) deprecate on separation. Federation is reversible in principle — "freely combine" includes freely un-combine.

## 6. Federation invariants

1. **Provenance is content-addressed and store-namespaced.** Overlap detection across stores, per-store evidence capping, and reversibility all depend on globally identifiable provenance refs (URLs, doc hashes, commit hashes, `store:` prefixes).
2. **Text is canonical; embeddings are a cache.** Different stores will use different embedding models; vectors never cross a store boundary. Re-embed on import — mechanical, if not free. Normalized claim text and intensional definitions are the interchange format.
3. **Import at ledger fidelity.** Posterior-only import is cheap but destroys auditability and evidence independence accounting. The default is raw-ledger import: the append-only property extends across federation, and views recompute.
4. **Source trust is an explicit weight.** Different agents calibrate differently; one store's "verified" may be sloppier than another's. Imported evidence retains its tier but carries a per-store trust multiplier on `w`, tunable and replay-auditable, discounted until locally corroborated. *Least-settled item in this note — calibration transfer is a real open problem (§8).*

## 7. The four domain adapters — the generalisability claim made precise

The epistemics — evidence, taint, lifecycle, consolidation, clocks, verticals — are domain-invariant. What varies per domain is exactly four adapters — with the A16 corrections: this note's 0.1 claim that kind was "the one" code-flavoured surface was wrong (EntityLevel and the locator shape were equally flavoured; now schema-room per A16), and adapters are **integrator-owned optional add-ons, never shipped obligations**. The core itself is language-free and contains none of the four: the code recipe (a tree-sitter emitter package, a git change-feed emitter, test-execution-as-verified) ships as ordinary external packages entering through the same ingest port any other domain's packages would use — beside the core, never inside it. A zero-adapter domain runs day one in all-asserted mode: everything testimony, posteriors wider, correctly humbler.

| Adapter | Role | Code recipe (external package) | Other-domain examples |
|---|---|---|---|
| Ground truth | a **privileged noun source**: emits canonical nouns (with locators) as parsed-tier existence/containment claims that act as coreference attractors; absent, referents emerge from usage alone | tree-sitter emitter | instrument readings; filed documents; ledger entries |
| Verification | defines what earns verified tier | test executed, CI observed | measurement reproduced; document filed; transaction settled |
| Change feed | the world-change clock driving churn decay | git commits, via the change-feed emitter | new experimental runs; regulatory updates; market events |
| Kind vocabulary | the claim-kind enum and its hint/compatibility rules | fact/convention/rationale/risk/intent/coupling | per-domain packs (A16: one of three formerly code-flavoured surfaces, alongside levels and locators — all now schema-room) |

*The domain lives in the adapters; the epistemology doesn't.* Kinds becoming truly emergent (very abstract grouping claims over claims-by-epistemic-role) is conceivable but destabilizing — kind drives hint biasing and adjudication compatibility — so domain packs are the horizon for now.

## 8. Geometry, and open questions

What emerges is less a single cone than a **narrowing DAG per domain — plural apexes, not one.** The "weave" is specific: concepts are the warp threading across the containment weft. After federation, formerly separate cones share upper structure and become one fabric pinned together at the abstract nodes. Multi-root containment (sibling workspaces under nothing) plus a shared concept layer is the entire merged topology; no new structure is required.

Open questions this note leaves live:

1. **Calibration transfer** — how source-trust multipliers are estimated and updated; whether a store can earn trust through local corroboration rates.
2. **Kind-pack mapping** — union vs mapping when two domain packs meet; whether cross-domain kind-compatibility rules can be derived rather than authored.
3. **Merge governance** — merges as deliberate, scoped, reviewable operations (partial merges — one subtree, one concept region — likely matter more than whole-store unions).
4. **Embedding economics** — re-embed-on-import cost at large ledger sizes; whether an interchange embedding standard ever beats text-canonical re-embedding.
5. **Prior drift** — adjudicator model upgrades shift the shared prior; whether concept definitions minted under different model generations remain entailment-compatible (definition re-checks on the calendar clock are the existing guard; may need a migration pass).

## 9. Graduation path

When implementation catches up, the candidates for spec amendments (post-A25): federation invariants → §4.4/§11; domain adapters → new top-level section; diversity-driven height → §8.8 note; source trust → §4.2 weight factor; store namespaces → §3.2 provenance. None of it touches v1.
