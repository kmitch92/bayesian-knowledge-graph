-- Migration 0 — the whole kg-mcp schema, live tables and deferred-feature seams alike.
--
-- Two rules govern what is here.
--
-- 1. Every table §5 writes to exists now, at the shape §3 describes. Vectors are
--    stored twice (§11): a full-precision little-endian f32 blob for rerank, and a
--    quantized int8 copy in a `vec0` index for in-traversal scoring.
--
-- 2. The plan §7 seams are here too, empty. `identity_claims` (§3.4 consolidator),
--    `documents` / `document_chunks` (§3.6, §5.10) are v1 non-goals, but a table
--    that exists from migration 0 is a feature that slots in rather than one that
--    bolts on. The reserved edge kinds need no seam of their own: `ClaimEdgeKind`
--    already admits them and `claim_edges.kind` is an open text column.
--
-- `{{ANN_DIMENSIONS}}` is substituted at load time from `ANN_INDEX_DIMENSIONS`, so
-- the width spike S2 pinned is declared in exactly one place.

------------------------------------------------------------------------------
-- §3.1 The entity spine.
------------------------------------------------------------------------------

CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- JSON array. Fed by §5.2 resolution near-misses; stops AuthService,
  -- auth-service and "the auth thing" fragmenting into separate subgraphs.
  aliases         TEXT NOT NULL DEFAULT '[]',
  level           TEXT NOT NULL
                    CHECK (level IN ('workspace','repo','system','component','module','symbol')),
  -- Asserted groupings are LLM-drawn boundaries and revisable (§14); parsed ones
  -- are re-derived on every parse.
  origin          TEXT NOT NULL CHECK (origin IN ('parsed','asserted')),
  ref_path        TEXT,
  ref_range       TEXT,
  -- f32 blob, the §5.2 anchor-resolution vector.
  gloss_embedding BLOB NOT NULL,
  -- 0–4 centroids concatenated end to end; incremental O(1) mean updates (§9).
  facets          BLOB NOT NULL DEFAULT x'',
  updated_at      TEXT
);

CREATE INDEX idx_entities_name ON entities (name);
CREATE INDEX idx_entities_level ON entities (level);

------------------------------------------------------------------------------
-- §3.2 Claim nodes. The fat node: every unit of non-parsed knowledge.
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
  -- §4.1 Beta-Bernoulli parameters. Strictly positive: a Beta with a zero
  -- parameter is not a distribution. REAL, not INTEGER — §15 tier weights and
  -- episode caps are fractional.
  alpha             REAL NOT NULL CHECK (alpha > 0),
  beta              REAL NOT NULL CHECK (beta > 0),
  -- The single spine anchor a claim lives at. A claim may reference several
  -- entities via ABOUT, but is anchored at exactly one scope.
  scope             TEXT NOT NULL REFERENCES entities (id),
  created_at        TEXT NOT NULL,
  last_corroborated TEXT,
  invalidated_at    TEXT,
  -- §4.5 commit clock: the last commit whose churn touched this claim's files.
  last_churn_event  TEXT,
  -- Consolidator output (a view) rather than a raw ledger entry (§3.4).
  canonical         INTEGER NOT NULL DEFAULT 0 CHECK (canonical IN (0,1))
);

CREATE INDEX idx_claims_scope ON claims (scope);
CREATE INDEX idx_claims_status ON claims (status);
CREATE INDEX idx_claims_canonical ON claims (canonical, status);

-- §3.5 provenance, normalized. The {episodes, commits, files} triple feeds churn
-- decay (§4.5), independence discounting (§4.4) and merge priors (§8.2) — all of
-- which ask "which claims touch this file?", which a JSON column cannot answer.
-- `ordinal` keeps each axis an ordered list rather than a set.
CREATE TABLE provenance (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  axis     TEXT NOT NULL CHECK (axis IN ('episode','commit','file')),
  value    TEXT NOT NULL,
  ordinal  INTEGER NOT NULL,
  UNIQUE (claim_id, axis, ordinal)
);

CREATE INDEX idx_provenance_lookup ON provenance (axis, value);

------------------------------------------------------------------------------
-- §3.3 Edges.
------------------------------------------------------------------------------

-- Claim edges: ABOUT to an entity, the other five to a claim. One `to_id` column
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

-- Parsed structural edges. Deliberately no alpha/beta and no tier: principle 2
-- says these carry no confidence machinery and are true until the next parse.
-- `kind` is an open parser vocabulary (CONTAINS, CALLS, IMPORTS, ...), not the
-- closed claim-edge set.
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
CREATE TABLE adjudication_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id         TEXT,
  incoming_text      TEXT NOT NULL,
  candidate_claim_id TEXT,
  candidate_text     TEXT NOT NULL,
  verdict            TEXT NOT NULL,
  confidence         REAL,
  model_id           TEXT,
  at                 TEXT NOT NULL
);

CREATE INDEX idx_adjudication_log_episode ON adjudication_log (episode_id, id);

------------------------------------------------------------------------------
-- §4.3 / §7.5 Taint. "The single most important rule in the system."
------------------------------------------------------------------------------

-- Recorded server-side, per session, at serving time, on every transport. An
-- episode that had claim E in its retrieval context cannot corroborate E.
CREATE TABLE taint (
  session_id TEXT NOT NULL,
  claim_id   TEXT NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
  at         TEXT NOT NULL,
  PRIMARY KEY (session_id, claim_id)
);

CREATE INDEX idx_taint_claim ON taint (claim_id);

------------------------------------------------------------------------------
-- §5.2 / §5.6 / §9 Queues.
------------------------------------------------------------------------------

-- §5.2: when nothing resolves above threshold, do NOT mint an entity eagerly —
-- park the claim here. Eager entity creation is how the graph fragments (§12).
CREATE TABLE triage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id      TEXT,
  normalized_text TEXT NOT NULL,
  scope_target    TEXT,
  reason          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'parked',
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  resolved_entity TEXT REFERENCES entities (id)
);

CREATE INDEX idx_triage_state ON triage (state, id);

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

-- §3.4 / §8.2: a first-class claim asserting that its members state the same
-- proposition, carrying its own posterior so a merge can be disputed like
-- anything else.
CREATE TABLE identity_claims (
  id                  TEXT PRIMARY KEY,
  members             TEXT NOT NULL,
  alpha               REAL NOT NULL,
  beta                REAL NOT NULL,
  status              TEXT NOT NULL,
  paraphrase_distance REAL NOT NULL,
  provenance_overlap  REAL NOT NULL,
  created_at          TEXT NOT NULL
);

-- §3.6 / §5.10: discursive knowledge that holds no evidence of its own.
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('authored','materialized')),
  content_ref TEXT NOT NULL,
  scope       TEXT REFERENCES entities (id),
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
