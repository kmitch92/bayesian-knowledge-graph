/**
 * The store's public surface.
 *
 * Everything outside `src/store/` talks to the graph through this module and
 * nothing else — which is also the rule that keeps every line of SQL in this
 * codebase underneath this directory. The vocabulary a caller needs to *describe*
 * graph data (entities, claims, edge kinds, evidence) is re-exported from
 * `src/schema/` rather than restated here: a second declaration of a shape is a
 * shape that can drift.
 *
 * What the store does own is its own failure vocabulary and its own geometry.
 * The error classes name promises only the persistence layer makes; the
 * dimensions are what migration 0 pinned.
 *
 * @spec §3.1, §3.2, §3.3, §3.5, §11
 */

export {
  LEDGER_SCAN_PAGE,
  openGraphStore,
} from './sqlite-graph-store.js';

export type {
  ArchiveScope,
  ClaimEdge,
  ClaimRecord,
  ClaimSearch,
  ClaimSearchHit,
  ClaimStatusChange,
  ClaimSummary,
  Containment,
  EvidenceDecay,
  EvidenceIncrement,
  EvidenceWitness,
  GraphStore,
  GraphStoreOptions,
  Mention,
  MentionCandidate,
  MentionTally,
  ObservationKey,
  ReferentGlossHit,
  ReferentGlossSearch,
  Regime,
  StageLogEntry,
  StructuralEdge,
  StructuralEdgeInput,
  TaintQuery,
  TaintRecord,
} from './port.js';

export {
  CorruptStageLogError,
  CorruptStoreError,
  DimensionMismatchError,
  DuplicateClaimError,
  OrphanedSignatureError,
  RegimeViolationError,
  ReservedEdgeKindError,
  StoreBusyError,
  UnknownClaimError,
  UnknownEntityError,
  UnsupportedSchemaVersionError,
} from './errors.js';

export type { StageLogPayloadColumn } from './errors.js';

export {
  ANN_INDEX_DIMENSIONS,
  STORED_VECTOR_DIMENSIONS,
  clampCosine,
  dequantizeAnnVector,
  quantizeToInt8,
  toAnnVector,
} from './vectors.js';

export { BUSY_TIMEOUT_MS, SCHEMA_VERSION } from './connection.js';

/*
 * Schema vocabulary, re-exported so a caller needs one import to work with the
 * store. These are `src/schema/`'s declarations, not copies of them.
 */
export {
  Claim,
  ClaimEdgeKind,
  ClaimKind,
  ClaimStatus,
  ClaimTier,
  Entity,
  EntityLevel,
  Evidence,
  LIVE_CLAIM_EDGE_KINDS,
  LiveClaimEdgeKind,
  Provenance,
  RESERVED_EDGE_KINDS,
  ReservedEdgeKind,
} from '../schema/index.js';
