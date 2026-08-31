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
 * @spec §3.2, §3.5, §5.2
 */
export const ClaimMessage = z.object({
  type: z.literal('claim'),
  text: z.string().min(1),
  kind: ClaimKind.default('fact'),
  tier: ClaimTier.default('observed'),
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
 * @spec §3.1, §3.3
 */
export const AttestationMessage = z.object({
  type: z.literal('attestation'),
  /** Which source stands behind it. §3.1's regime holds while *any* source does. @spec §3.1 */
  source: z.string().min(1),
  surfaceForm: z.string().min(1),
  level: EntityLevel.nullable().default(null),
  /** Opaque. Never parsed, never queried, never turned into a hierarchy. @spec §3.1 */
  locator: z.unknown(),
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
 * @spec §3.1, §3.3
 */
export const ContainmentMessage = z.object({
  type: z.literal('containment'),
  parent: z.string().min(1),
  child: z.string().min(1),
  childLevel: EntityLevel.nullable().default(null),
  tier: ClaimTier.default('observed'),
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
 * @spec §3.1, §3.3, §4.5
 */
export const RetractionMessage = z.object({
  type: z.literal('retraction'),
  source: z.string().min(1),
  surfaceForm: z.string().min(1),
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
