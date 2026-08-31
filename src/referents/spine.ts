/**
 * Spine claims: the ledger rows the referent index is a view over.
 *
 * Diagram §4 says the referent index, the mention index and the containment
 * index are *materialized views, rebuildable from the ledger*, and §11 adds that
 * "no foreign keys point from the ledger onto views". Together those two make a
 * demand of this module: every fact the three projections hold has to be
 * readable back out of a claim, because `clearViews` destroys everything else.
 *
 * A claim row has no columns to spare — §3.5 pins its shape — so the payload
 * rides in the one field that is *content*: `text`. §3.1 licenses exactly this
 * for the hardest case, a locator being "opaque, never parsed or queried by the
 * store — locator is claim content, interpreted only by spine code". This module
 * is that spine code, and it is the only place in `src/` that reads a claim's
 * text as anything but prose.
 *
 * The envelope is a marker plus one line of JSON:
 *
 * ```
 * A referent named "AuthService" exists.
 * kgmem-spine: {"v":1,"claim":"existence",…}
 * ```
 *
 * `JSON.stringify` never emits a raw newline, so the payload cannot contain the
 * marker; reading from the *last* marker is therefore exact whatever a producer
 * called its noun. The first line stays an ordinary declarative sentence, so a
 * spine claim that reaches a reader still reads like a claim.
 *
 * Nothing here is language-specific and nothing here is a parser in the sense
 * §1 forbids: the input is a string this module wrote.
 *
 * @spec §3.1, §3.3, §3.5, §11
 */

import { z } from 'zod';

import { EntityLevel } from '../schema/index.js';

/** Separates the readable sentence from the machine-readable payload. @spec §3.5 */
const MARKER = '\nkgmem-spine: ';

/** Envelope version, so a later shape change is a migration rather than a guess. */
const VERSION = 1;

/**
 * The claim that mints a referent, and the row §3.1's index materializes.
 *
 * Self-anchored (`scope` is the referent it mints), so the anchor is meaningful
 * before the index exists. `level` and `locator` ride along because they are
 * the two entity-row fields nothing else in the ledger records.
 *
 * @spec §3.1, §3.2, §3.5
 */
export const ExistencePayload = z.object({
  v: z.literal(VERSION),
  claim: z.literal('existence'),
  referent: z.string().min(1),
  surfaceForm: z.string().min(1),
  level: EntityLevel.nullable(),
  locator: z.unknown(),
  /** The noun source attesting it, when one does. Absent for a usage-born referent. @spec §3.1 */
  source: z.string().min(1).optional(),
});

/** An existence claim's payload. @spec §3.1 */
export type ExistencePayload = z.infer<typeof ExistencePayload>;

/**
 * The claim that adds a surface form to a referent §3.1 calls "an identity claim
 * over names": the ledger row the mention index materializes.
 *
 * @spec §3.1, §5.2, §8.2
 */
export const NamingPayload = z.object({
  v: z.literal(VERSION),
  claim: z.literal('naming'),
  referent: z.string().min(1),
  surfaceForm: z.string().min(1),
});

/** A naming claim's payload. @spec §3.1, §5.2 */
export type NamingPayload = z.infer<typeof NamingPayload>;

/**
 * The claim that places one referent under another — §3.3's `CONTAINS`, before
 * it is materialized, and the only thing that gives a referent a level.
 *
 * @spec §3.1, §3.3
 */
export const ContainmentPayload = z.object({
  v: z.literal(VERSION),
  claim: z.literal('containment'),
  parent: z.string().min(1),
  child: z.string().min(1),
  childLevel: EntityLevel.nullable(),
});

/** A containment claim's payload. @spec §3.1, §3.3 */
export type ContainmentPayload = z.infer<typeof ContainmentPayload>;

/** Any spine payload. Claims without one are ordinary knowledge. @spec §3.5 */
export const SpinePayload = z.discriminatedUnion('claim', [
  ExistencePayload,
  NamingPayload,
  ContainmentPayload,
]);

/** A spine claim's payload. @spec §3.5 */
export type SpinePayload = z.infer<typeof SpinePayload>;

/** JSON-quotes a surface form so the sentence can never contain a raw newline. */
const quoted = (surfaceForm: string): string => JSON.stringify(surfaceForm);

/**
 * Renders the sentence a spine claim reads as.
 *
 * Deliberately independent of the derived name: a name is a view over the
 * mention cluster and moves, and a ledger row whose text moved with it would be
 * a rewritten claim.
 *
 * @spec §3.1, §3.5
 */
export const spineSentence = (payload: SpinePayload): string => {
  switch (payload.claim) {
    case 'existence':
      return payload.source === undefined
        ? `A referent named ${quoted(payload.surfaceForm)} exists.`
        : `${quoted(payload.source)} attests a referent named ${quoted(payload.surfaceForm)}.`;
    case 'naming':
      return `The referent this claim is about is also named ${quoted(payload.surfaceForm)}.`;
    case 'containment':
      return `Referent ${payload.parent} directly contains referent ${payload.child}.`;
  }
};

/** The claim text carrying a spine payload: sentence, then envelope. @spec §3.5 */
export const encodeSpineClaim = (payload: SpinePayload): string =>
  `${spineSentence(payload)}${MARKER}${JSON.stringify(payload)}`;

/**
 * The payload a claim carries, or `undefined` for an ordinary claim.
 *
 * Reads from the last marker, which is exact: the payload is one line of JSON
 * and JSON escapes the newline the marker starts with.
 *
 * @spec §3.5, §11
 */
export const decodeSpineClaim = (text: string): SpinePayload | undefined => {
  const at = text.lastIndexOf(MARKER);
  if (at < 0) return undefined;
  const encoded = text.slice(at + MARKER.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  const payload = SpinePayload.safeParse(parsed);
  return payload.success ? payload.data : undefined;
};
