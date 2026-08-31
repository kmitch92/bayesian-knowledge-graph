-- Migration 0 — the whole kg-mcp schema, live tables and deferred-feature seams alike.
--
-- Three rules govern what is here.
--
-- 1. Every table §5 writes to exists now, at the shape §3 describes. Vectors are
--    stored twice (§11): a full-precision little-endian f32 blob for rerank, and a
--    quantized int8 copy in a `vec0` index for in-traversal scoring.
--
-- 2. **The ledger is the only primitive; the rest is a view** (diagram §4). The
--    referent index (`entities`), the mention index (`mentions`) and the
--    containment index (`entity_edges`) are all materialized from existence and
--    containment claims, so no foreign key points from a ledger row onto any of
--    them — `claims.scope` is a referent id and nothing more. A view that could
--    refuse a ledger write would be a view the ledger depends on, and
--    `rebuild-index` must be able to drop all three and regenerate them.
--
-- 3. The plan §7 seams are here too, empty. `documents` / `document_chunks`
--    (§3.6, §5.10) and `pathway_counters` (A15) are v1 non-goals, but a table
--    that exists from migration 0 is a feature that slots in rather than one that
--    bolts on. The reserved edge kinds need no seam of their own: `ClaimEdgeKind`
--    already admits them and `claim_edges.kind` is an open text column.
--
-- `{{ANN_DIMENSIONS}}` is substituted at load time from `ANN_INDEX_DIMENSIONS`, so
-- the width spike S2 pinned is declared in exactly one place.

------------------------------------------------------------------------------
-- §3.1 The referent index — a view over existence claims.
------------------------------------------------------------------------------

CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  -- Derived, not asserted: the most-corroborated surface form in `mentions`.
  name            TEXT NOT NULL,
  -- Nullable and open (A16). A referent born from a mention is unplaced until a
  -- containment claim places it, and the ladder a level belongs to is the active
  -- pack's data rather than this schema's business.
  level           TEXT,
  -- Which truth-maintenance machinery maintains this referent (diagram §6).
  -- Replaces the v0.2 parsed/asserted `origin`, which named provenance instead.
  regime          TEXT NOT NULL CHECK (regime IN ('view','evidence')),
  -- Opaque JSON. Never parsed, never queried, never indexed: the code pack's
  -- `{ path, symbolRange }` is one recipe's shape and another pack's locator is
  -- another shape entirely. SQL NULL means the referent carries no locator at
  -- all; the JSON text `null` means it carries one that is null.
  locator         TEXT,
  -- f32 blob, the §5.2 anchor-resolution vector.
  gloss_embedding BLOB NOT NULL,
  -- 0–4 centroids concatenated end to end; incremental O(1) mean updates (§9).
  facets          BLOB NOT NULL DEFAULT x'',
  updated_at      TEXT
);

CREATE INDEX idx_entities_name ON entities (name);
CREATE INDEX idx_entities_level ON entities (level);

-- The mention index: many surface forms, one referent. Was `entities.aliases`, a
-- JSON column — which could answer "what is this referent called?" but not
-- "which referent is this called?", the question §5.2 resolution actually asks,
-- and which is what stops AuthService, auth-service and "the auth thing"
-- fragmenting into separate subgraphs (§12). Indexed both ways for the same
-- reason: resolution reads it forwards, `rebuild-index` reads it backwards.
CREATE TABLE mentions (
  surface_form TEXT NOT NULL,
  referent_id  TEXT NOT NULL,
  at           TEXT NOT NULL,
  PRIMARY KEY (surface_form, referent_id)
);

CREATE INDEX idx_mentions_referent ON mentions (referent_id);

------------------------------------------------------------------------------
-- §3.2 Claim nodes. The fat node: every unit of knowledge, in either regime.
------------------------------------------------------------------------------

CREATE TABLE claims (
  id                TEXT PRIMARY KEY,
  -- Normalized, self-contained, deixis-free (§5.2).
  text              TEXT NOT NULL,
  -- f32 blob at the §11 rerank width. Migration 0 is final on this column.
  embedding         BLOB NOT NULL,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('fact','convention','rationale','risk','intent','coupling')),
  tier              TEXT NOT NULL CHECK (tier IN ('verified','observed','inferred')),
  status            TEXT NOT NULL
                      CHECK (status IN ('provisional','active','disputed','deprecated','archived')),
  -- Diagram §6: one substrate, two truth-maintenance regimes. A view-regime claim
  -- is maintained by re-parsing the source that attests it, so re-running that
  -- source cannot inflate anything — there is no posterior to inflate. An
  -- evidence-regime claim is maintained by α/β, taint, caps and saturation.
  regime            TEXT NOT NULL CHECK (regime IN ('view','evidence')),
  -- §4.1 Beta-Bernoulli parameters, nullable because the view regime has none.
  -- REAL, not INTEGER — §15 tier weights and episode caps are fractional.
  alpha             REAL,
  beta              REAL,
  -- The single referent a claim is anchored at. Deliberately **no foreign key**:
  -- the referent index is a view (rule 2 above), and anchor integrity is the
  -- pipeline's job, not a constraint the ledger can be refused by.
  scope             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_corroborated TEXT,
  invalidated_at    TEXT,
  -- §4.5 change clock: the last change event whose churn touched this claim.
  last_churn_event  TEXT,
  -- Consolidator output (a view) rather than a raw ledger entry (§3.4).
  canonical         INTEGER NOT NULL DEFAULT 0 CHECK (canonical IN (0,1)),
  -- "Nothing is ever both. Nothing is ever neither." Enforced here as well as in
  -- the store: a view claim carrying a posterior is a parser vote counted as
  -- corroboration, and an evidence claim without one is a belief with no belief
  -- in it. Stated in SQL because a table CHECK is the cheapest place to make the
  -- rule unfalsifiable — it also holds against the UPDATE paths (§4.2 increments,
  -- §4.5 decay) and against any future writer that is not this store.
  CHECK ((regime = 'view'     AND alpha IS NULL     AND beta IS NULL)
      OR (regime = 'evidence' AND alpha IS NOT NULL AND beta IS NOT NULL AND alpha > 0 AND beta > 0))
);

CREATE INDEX idx_claims_scope ON claims (scope);
CREATE INDEX idx_claims_status ON claims (status);
CREATE INDEX idx_claims_canonical ON claims (canonical, status);
CREATE INDEX idx_claims_regime ON claims (regime, status);

-- §3.5 provenance, normalized. The {episodes, changeEvents, artifacts} triple
-- feeds churn decay (§4.5), independence discounting (§4.4) and merge priors
-- (§8.2) — all of which ask "which claims touch this artifact?", which a JSON
-- column cannot answer. `ordinal` keeps each axis an ordered list rather than a
-- set. `channel` and `agent` are the A15 pathway signature: which transport and
-- which agent this backing arrived over, the key a pathway counter is grouped by.
CREATE TABLE provenance (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  axis     TEXT NOT NULL CHECK (axis IN ('episode','changeEvent','artifact')),
  value    TEXT NOT NULL,
  ordinal  INTEGER NOT NULL,
  channel  TEXT,
  agent    TEXT,
  UNIQUE (claim_id, axis, ordinal)
);

CREATE INDEX idx_provenance_lookup ON provenance (axis, value);
CREATE INDEX idx_provenance_pathway ON provenance (channel, agent);

-- A15 pathway counters: how many times this claim has been corroborated through
-- one cluster of the pathway space (a channel, an agent, a channel×agent pair).
-- The substrate for the saturation the gated feature applies; v1 writes nothing
-- here, and a table that exists from migration 0 needs no migration to start.
CREATE TABLE pathway_counters (
  claim_id      TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  cluster_level TEXT NOT NULL,
  cluster_key   TEXT NOT NULL,
  n             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (claim_id, cluster_level, cluster_key)
);

------------------------------------------------------------------------------
-- §3.3 Edges.
------------------------------------------------------------------------------

-- Claim edges: ABOUT to a referent, the other five to a claim. One `to_id` column
-- rather than a nullable pair, because SQLite treats NULLs as distinct in a
-- UNIQUE index — which would silently defeat the idempotence a re-resolve needs.
CREATE TABLE claim_edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id    TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_id, kind, to_id)
);

CREATE INDEX idx_claim_edges_to ON claim_edges (to_id, kind);
CREATE INDEX idx_claim_edges_kind ON claim_edges (kind, to_id, id);

-- The containment index: parsed structural edges, materialized from containment
-- claims and re-derived on every parse. Deliberately no alpha/beta and no tier:
-- principle 2 says these carry no confidence machinery and are true until the
-- next parse. `kind` is an open parser vocabulary (CONTAINS, CALLS, IMPORTS,
-- ...), not the closed claim-edge set.
CREATE TABLE entity_edges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  to_id   TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  UNIQUE (from_id, kind, to_id)
);

CREATE INDEX idx_entity_edges_to ON entity_edges (to_id, kind);

------------------------------------------------------------------------------
-- §5.1 / §5.8 The episode ledger and the replay log.
------------------------------------------------------------------------------

CREATE TABLE episodes (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  started_at TEXT,
  ended_at   TEXT
);

-- §5.1 stage-0 idempotency dedupe. The UNIQUE pair is the whole mechanism:
-- hash(normalized_text) + episode_id at the very front, so a retried tool call
-- cannot double-count, while the same text from another episode still lands as
-- the independent corroboration it is.
CREATE TABLE episode_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  text_hash  TEXT NOT NULL,
  at         TEXT NOT NULL,
  UNIQUE (episode_id, text_hash)
);

-- §5.8: every stage logs its inputs and decisions. Append-only, ordered, and
-- opaque — §13 replay tunes every ⚙ constant in §15 against exactly this table,
-- and an entry missing or reordered tunes nothing.
CREATE TABLE stage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  inputs     TEXT NOT NULL,
  decision   TEXT,
  at         TEXT NOT NULL
);

CREATE INDEX idx_stage_log_episode ON stage_log (episode_id, id);

-- §5.4 verdicts, kept separately from the generic stage log because §13's drift
-- audits read both claim texts and the model that judged them.
--
-- A14: the verdict is a *distribution* over the adjudicator's labels, as JSON,
-- not a single winning label with a confidence beside it. A label plus a scalar
-- cannot say that a model was torn between two labels rather than unsure about
-- one, and that difference is exactly what a drift audit is looking for.
-- `overlap_bucket` records which provenance-overlap band the pair fell in, so
-- the audit can compare like with like instead of averaging over the lot.
CREATE TABLE adjudication_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id           TEXT,
  incoming_text        TEXT NOT NULL,
  candidate_claim_id   TEXT,
  candidate_text       TEXT NOT NULL,
  verdict_distribution TEXT NOT NULL,
  overlap_bucket       TEXT,
  model_id             TEXT,
  at                   TEXT NOT NULL
);

CREATE INDEX idx_adjudication_log_episode ON adjudication_log (episode_id, id);

------------------------------------------------------------------------------
-- §4.3 / §7.5 Taint. "The single most important rule in the system."
------------------------------------------------------------------------------

-- Recorded server-side at serving time, on every transport, and keyed by the
-- episode rather than by a session (diagram §4): an episode that had claim E in
-- its retrieval context cannot corroborate E. The episode is the unit §4.4
-- independence discounting and §4.2 episode caps already count in, so keying
-- taint by anything coarser would let one episode launder its own output.
CREATE TABLE taint (
  episode_id TEXT NOT NULL,
  claim_id   TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  PRIMARY KEY (episode_id, claim_id)
);

CREATE INDEX idx_taint_claim ON taint (claim_id);

------------------------------------------------------------------------------
-- §5.6 / §9 Queues.
------------------------------------------------------------------------------

-- §5.2 no longer parks unresolved referents in a structure of their own: a
-- referent nothing resolved above threshold is minted provisional and is
-- queryable by status, so a second place to look for one would be a second place
-- to forget to look.

-- §5.6: emitted on the transition into `disputed`. §6.4 gives them a TTL so a
-- task nobody runs auto-deprecates instead of becoming a zombie dispute (§12).
CREATE TABLE verification_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id       TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  rival_claim_id TEXT REFERENCES claims (id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  resolved_at    TEXT,
  outcome        TEXT
);

CREATE INDEX idx_verification_tasks_state ON verification_tasks (state, expires_at);

-- §9 clocks: consolidation, re-clustering, the re-verification sampler and churn
-- decay all arrive as deferred work rather than on the write path.
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);

CREATE INDEX idx_jobs_queue ON jobs (state, scheduled_at);

------------------------------------------------------------------------------
-- Deferred-feature seams (plan §7). Created empty; v1 writes nothing here.
------------------------------------------------------------------------------

-- §3.4 / §8.2 identity claims have no table of their own: an identity claim is
-- an ordinary claim carrying MERGES edges to its members, which is what makes it
-- disputable, decayable and archivable by exactly the machinery every other
-- claim already has. A parallel table would have been a second lifecycle.

-- §3.6 / §5.10: discursive knowledge that holds no evidence of its own.
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('authored','materialized')),
  content_ref TEXT NOT NULL,
  scope       TEXT,
  created_at  TEXT
);

CREATE TABLE document_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  embedding   BLOB,
  UNIQUE (document_id, ordinal)
);

------------------------------------------------------------------------------
-- §11 Vector indexes. sqlite-vec `vec0` virtual tables.
------------------------------------------------------------------------------

-- The quantized in-graph copy (§11), narrowed to the ANN width by Matryoshka
-- slice. `archived` rides along as a metadata column so the §6.1 exclusion is
-- applied *inside* the KNN scan: filtering afterwards would silently shorten
-- every result set by however many archived neighbours the scan happened to hit.
CREATE VIRTUAL TABLE claim_vectors USING vec0 (
  claim_id  TEXT PRIMARY KEY,
  embedding int8[{{ANN_DIMENSIONS}}] distance_metric=cosine,
  archived  INTEGER
);

-- §5.2's resolution ladder ends in an embedding match against entity glosses.
CREATE VIRTUAL TABLE entity_gloss_vectors USING vec0 (
  entity_id TEXT PRIMARY KEY,
  gloss     int8[{{ANN_DIMENSIONS}}] distance_metric=cosine
);
