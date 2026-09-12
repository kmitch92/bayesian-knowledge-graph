/**
 * The vocabulary every producer writes in.
 *
 * Diagram §1: *"Core contains no parser and no language-specific code. Every
 * source of knowledge — human, agent, or emitter — writes claims through one
 * ingest port."* So there is no producer discriminant in this file. A message
 * says what happened, not who is speaking; the only two things that record the
 * speaker are `tier`, which is §6.3's privilege ladder, and `origin.channel`,
 * which is half of the A15 pathway signature. Both are ordinary fields an agent
 * could set as easily as an emitter could.
 *
 * Four message types, and the shortest list that covers the write path: a claim,
 * a noun source attesting a referent, a containment assertion, and a noun source
 * withdrawing an attestation. Nothing here mentions files, symbols, syntax or
 * language. A philosophy notebook and a TypeScript repository enter by the same
 * door, and the core cannot tell which it is holding.
 *
 * @spec §3.1, §3.3, §4.7, §5, §5.9, §6.3
 */

import { z } from 'zod';

import { ClaimKind, ClaimTier, EntityLevel } from '../schema/index.js';

/**
 * Where an observation came from: the episode it belongs to, the channel it
 * arrived on, and the agent behind it when there is one.
 *
 * The episode is the unit §4.4 counts independence in, which is why it is
 * required: an observation with no episode cannot be discounted for repetition
 * and would corroborate without limit.
 *
 * @spec §3.5, §4.4, §4.7
 */
export const Origin = z.object({
  episodeId: z.string().min(1),
  /** §4.7's pathway half: `live-observe`, a hook, an emitter's feed. @spec §4.7, §5.9 */
  channel: z.string().min(1),
  /** The other pathway half. Absent for a producer that is not an agent. @spec §4.7 */
  agent: z.string().min(1).optional(),
});

/** An observation's provenance signature. @spec §3.5, §4.7 */
export type Origin = z.input<typeof Origin>;

/**
 * One proposition, with the nouns it names.
 *
 * `mentions` is required and non-empty because §5.2 *"forces every claim to name
 * its referents explicitly"* — the write is the only moment referents are
 * recoverable, and a claim that named none of them has thrown that away.
 *
 * ── The tier default is privilege granted to silence ────────────────────────
 *
 * This type guarantees a proposition, its nouns and an episode. Nothing in it
 * says anybody *read* anything, while §15's tier table reads `observed` as
 * *"agent directly read the relevant code/output"*. So a producer who named no
 * tier has asserted nothing about how it knows, and the only question worth
 * asking of the default is what the *message type itself* guarantees — which
 * here is nothing at all.
 *
 * `observed` would hand that silence §6.3's middle rung: *"moves posteriors at
 * full weight; needs the 2-episode rule for status changes"*, plus the neutral
 * β₀=1 rather than §3.2's skeptical β₀=2. `inferred` is the rung §6.3 says
 * *"never changes a status by itself"*, which is exactly what an assertion with
 * nothing behind it should be able to do. E8c's first live run is what the other
 * choice costs: a prose design note containing no tool output whatever came back
 * with 35 of 225 proposals filed as `observed`, and §4's entire apparatus is the
 * ability to tell measurement from reasoning apart *afterwards* — the one thing
 * no later pass can reconstruct, because the ledger keeps the rung and not the
 * reason for it. It also settles a contradiction the extractor shipped with: its
 * own prompt says inferred is the default while this door said otherwise, and
 * the door is the rule every producer inherits.
 *
 * @spec §3.2, §3.5, §4.2, §5.2, §6.3, §15
 */
export const ClaimMessage = z.object({
  type: z.literal('claim'),
  text: z.string().min(1),
  kind: ClaimKind.default('fact'),
  /** Silence earns §6.3's bottom rung, never measurement's privileges. @spec §6.3, §15 */
  tier: ClaimTier.default('inferred'),
  mentions: z.array(z.string().min(1)).min(1),
  origin: Origin,
});

/** A claim as a producer writes it. @spec §3.5, §5.2 */
export type ClaimMessage = z.input<typeof ClaimMessage>;

/**
 * A noun source declaring that a referent exists.
 *
 * §3.1: a noun source is *"a privileged noun source, nothing more"*. The
 * privilege is the regime — an attested referent is re-derived rather than
 * believed — and it is bought by attesting, never by the channel a message
 * arrived on.
 *
 * ── Why the top rung stays here, when it left the two types either side ─────
 *
 * `source` is **required**, so this default rests on a structural guarantee of
 * the type rather than on a producer's silence — which is the whole distinction
 * {@link ClaimMessage} and {@link ContainmentMessage} turn on. This message type
 * *is* §3.1's act of attesting, and §15's tier table spends the top rung on
 * exactly that act: `verified` is *"test executed, **noun-source attested**, CI
 * observed"*. §4.3's A1 exemption names the same family — *"a test, parse, or CI
 * observation"* — as the evidence that stays untainted.
 *
 * What the rung buys is narrow and correctly placed. The existence claim goes to
 * the view regime carrying no posterior at all (§3.1: *"Nothing is ever both"*),
 * so `verified` moves nothing there; it moves the *naming* claim, an ordinary
 * evidence-regime belief about what the referent is called — and a source
 * reporting a name has read it rather than reasoned to it. So a sweep that
 * lowered all three defaults together would be wrong here: two of them were
 * privilege granted to silence and this one is not.
 *
 * @spec §3.1, §3.3, §4.3, §6.3, §15
 */
export const AttestationMessage = z.object({
  type: z.literal('attestation'),
  /** Which source stands behind it. §3.1's regime holds while *any* source does. @spec §3.1 */
  source: z.string().min(1),
  surfaceForm: z.string().min(1),
  level: EntityLevel.nullable().default(null),
  /** Opaque. Never parsed, never queried, never turned into a hierarchy. @spec §3.1 */
  locator: z.unknown(),
  /** The rung §15 spends on attesting, earned by `source` being required. @spec §6.3, §15 */
  tier: ClaimTier.default('verified'),
  origin: Origin,
});

/** A noun source's attestation. @spec §3.1 */
export type AttestationMessage = z.input<typeof AttestationMessage>;

/**
 * An assertion that one referent directly contains another.
 *
 * The only thing in the system that produces a `CONTAINS` edge or a non-null
 * level (§3.1, §3.3, principle 14). Asserted by default, and therefore
 * disputable; a noun source may stand behind it by naming itself, which moves it
 * into the view regime like any other re-derived fact.
 *
 * ── Why silence is reasoning here too ───────────────────────────────────────
 *
 * `source` is *optional*, so the type guarantees no noun source stands behind a
 * boundary, and §3.3's spine being *"the materialization of containment claims"*
 * and of nothing else is what makes a bad boundary an ordinary wrong claim. §1
 * rules on precisely the sourceless spine: *"a zero-adapter domain runs an
 * **all-asserted spine** — referents minted via the resolution ladder and
 * grouping claims, no structural floor, **nothing reaching verified tier** —
 * correctly humbler testimony."* A boundary nobody in particular asserted is a
 * belief, and a defaulted one is a belief whose holder did not even say they had
 * looked.
 *
 * The *sourced* case gives up nothing by sharing that floor. `submitContainment`
 * files a sourced boundary in the view regime with `evidence: null`, so its tier
 * moves no posterior on the boundary at all; it weighs only the naming claims
 * `resolveOne` writes on the way, and a source that wants those weighed as
 * measurement is already filling in `source` and can fill in `tier` beside it. A
 * source-dependent default — `verified` the moment `source` is present — was
 * considered and refused: that makes top-rung privilege a function of a
 * self-declared string, which is the same defect as defaulting to `observed`,
 * bought one field later.
 *
 * @spec §1, §3.1, §3.3, §6.3
 */
export const ContainmentMessage = z.object({
  type: z.literal('containment'),
  parent: z.string().min(1),
  child: z.string().min(1),
  childLevel: EntityLevel.nullable().default(null),
  /** Sourceless by type, so §1's all-asserted spine reaches no higher. @spec §1, §6.3 */
  tier: ClaimTier.default('inferred'),
  /** Present when a noun source re-derives this boundary rather than believing it. @spec §3.1 */
  source: z.string().min(1).optional(),
  origin: Origin,
});

/** A containment assertion. @spec §3.1, §3.3 */
export type ContainmentMessage = z.input<typeof ContainmentMessage>;

/**
 * A noun source withdrawing an attestation.
 *
 * The change-feed half of §3.1's regime rule: the referent has left this
 * source's view of the world, and if no source is left standing behind it, its
 * existence becomes an ordinary belief with ordinary evidence.
 *
 * The withdrawal is addressed to a *form*, and §3.1 keys the mention index
 * `(surface_form, referent_id)` precisely so a form may name more than one thing.
 * So `(source, surfaceForm)` is the coarse address: everywhere that form reaches,
 * every declaration this source made there. `locator` is the narrow one — the
 * other half of the emitter contract, and the only way to drop one of two
 * declarations a source made under a single form. Opaque here as it is on an
 * attestation: matched, never parsed.
 *
 * @spec §3.1, §3.3, §4.5
 */
export const RetractionMessage = z.object({
  type: z.literal('retraction'),
  source: z.string().min(1),
  surfaceForm: z.string().min(1),
  /** Present when the source is naming one declaration rather than all of them. @spec §3.1 */
  locator: z.unknown(),
  origin: Origin,
});

/** A withdrawn attestation. @spec §3.1, §4.5 */
export type RetractionMessage = z.input<typeof RetractionMessage>;

/** Everything the one ingest port accepts. @spec §5 */
export const IngestMessage = z.discriminatedUnion('type', [
  ClaimMessage,
  AttestationMessage,
  ContainmentMessage,
  RetractionMessage,
]);

/** A message as a producer writes it. @spec §5 */
export type IngestMessage = z.input<typeof IngestMessage>;

/** A message after defaults have been applied. @spec §5 */
export type ParsedMessage = z.output<typeof IngestMessage>;
