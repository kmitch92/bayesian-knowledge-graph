/**
 * The referent layer's public surface.
 *
 * §3.1's index is *"the materialized clustering of noun mentions into
 * referents"* — a view over existence claims, and never a table anything is
 * allowed to write directly. What leaves this module is therefore vocabulary and
 * one read: the shape of a referent, the shape of a resolution, and the two
 * model-shaped ports §5.2 needs to produce one.
 *
 * There is no parser here and no grammar, in this module or under it. Nouns
 * arrive as strings through the ingest port; a philosophy notebook and a
 * TypeScript repository grow the same index by the same rules, and this layer
 * cannot tell which it is holding. §3.1: *"A domain with no noun source runs
 * pure usage-emergence — the all-asserted mode and the noun-emergent mode are
 * the same mode."*
 *
 * @spec §3.1, §3.5, §5.2
 */

export {
  COSINE_FLOOR,
  CANDIDATE_CAP,
  resolveSurfaceForm,
} from './ladder.js';

export type {
  Adjudicator,
  LadderContext,
  LadderOutcome,
  Resolution,
  ResolutionRung,
  TiebreakCandidate,
  TiebreakRequest,
  TiebreakVerdict,
} from './ladder.js';

export {
  deriveName,
  existenceClaimsOf,
  isLive,
  readAllReferents,
  readReferent,
  standingExistenceClaim,
} from './index-view.js';

export type { ExistenceClaim, Referent } from './index-view.js';

export {
  ContainmentPayload,
  ExistencePayload,
  NamingPayload,
  SpinePayload,
  decodeSpineClaim,
  encodeSpineClaim,
  spineSentence,
} from './spine.js';

export { contentAddressedId, createIdMinter, mintId } from './ids.js';

export type { IdMinter } from './ids.js';
