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
--    containment index (`contains_index`) are all materialized from existence and
--    containment claims, so no foreign key points from a ledger row onto any of
--    them — `claims.scope` is a referent id and nothing more. A view that could
--    refuse a ledger write would be a view the ledger depends on, and
--    `rebuild-index` must be able to drop all three and regenerate them.
--
--    `entity_edges` is a fourth table and deliberately not a fourth view of the
--    same kind: it holds what a parser saw (CALLS, IMPORTS, ...), re-derived by
--    re-running that parser rather than by replaying claims. Containment used to
--    share it, which made a re-parse of one module's call graph delete that
--    module's containment — the whole spine, silently, on the second parse.
--
-- 3. The plan §7 seams are here too, empty. `documents` / `document_chunks`
--    (§3.6, §5.10) and `pathway_counters` (A15) are v1 non-goals, but a table
--    that exists from migration 0 is a feature that slots in rather than one that
--    bolts on. The reserved edge kinds need no seam of their own: `ClaimEdgeKind`
--    already admits them and `claim_edges.kind` is an open text column.
--
-- `{{ANN_DIMENSIONS}}` and `{{RERANK_BYTES}}` are substituted at load time from
-- `ANN_INDEX_DIMENSIONS` and `STORED_VECTOR_DIMENSIONS`, so each width spike S2
-- pinned is declared in exactly one place. The first is a component count, which
-- is what a `vec0` column declaration takes; the second is a byte count, because
-- the f32 columns are plain blobs and `length()` over a blob counts bytes.

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
  -- Opaque JSON: the code pack's `{ path, symbolRange }` is one recipe's shape
  -- and another pack's locator is another shape entirely. Never queried and
  -- never indexed — no statement in this file reads *into* it — but it is
  -- parsed once, on the way back out through `getEntity`, and the older claim
  -- here that it never was is a good part of why an unguarded `JSON.parse` sat
  -- on §7.6's serving path for as long as it did.
  --
  -- SQL NULL means the referent carries no locator at all; the JSON text `null`
  -- means it carries one that is null. The CHECK admits both, and has to admit a
  -- bare JSON string besides: `'not json'` is a perfectly good locator, and the
  -- encode path stores it as `"not json"`, which is valid JSON — a guard that
  -- refused that would be refusing the encoded form rather than the corrupt one.
  -- What it does refuse is what a writer that is not this store leaves behind: a
  -- truncated object, the empty string every `IS NOT NULL` guard admits, a blob
  -- TEXT affinity will not convert.
  --
  -- It cannot help a file that already holds a bad row, which is why the read
  -- path degrades to a referent without a locator rather than relying on this.
  -- The CHECK stops the next one.
  locator         TEXT
                    CHECK (locator IS NULL OR json_valid(locator)),
  -- An f32 blob, the §5.2 anchor-resolution vector.
  --
  -- The CHECK is here for the reason the posterior's is: `BLOB` above declares an
  -- affinity, and BLOB affinity is the one that converts *nothing* — text stays
  -- text, an integer stays an integer. Both then reach `decodeFloatVector`, which
  -- copies through `bytes.set(blob)`: over text that raises at read time, and over
  -- a number it reads no `byteLength` at all and yields an empty vector, so the
  -- referent loses its anchor geometry with nothing raised anywhere. A read-path
  -- guard is a guarantee only the reads that remembered to ask for it get; a write
  -- that is refused cannot be read at all.
  --
  -- The width clause is not decoration. `typeof = 'blob'` alone still admits
  -- `zeroblob(7)`, which decodes to a one-component vector that scores against
  -- 768-component ones as though it belonged beside them.
  --
  -- What this cannot guarantee: that the bytes are a *vector*. Any 3072 bytes pass,
  -- including 3072 zeroes — which is a legal f32 blob, a zero-norm one, and
  -- meaningless as a direction. Nothing expressible in a table CHECK can tell those
  -- apart; only `assertStoredWidth` and the unit-norm enforcement in
  -- `truncateEmbedding` cover that, and they cover it for this store's writes only.
  gloss_embedding BLOB NOT NULL
                    CHECK (typeof(gloss_embedding) = 'blob'
                       AND length(gloss_embedding) = {{RERANK_BYTES}}),
  -- 0–4 centroids concatenated end to end; incremental O(1) mean updates (§9).
  --
  -- Same argument as `gloss_embedding`, with the width stated as a multiple rather
  -- than an equality because this column holds a *set*. Length 0 is the legal and
  -- common case — a referent with no centroids — and needs no exception carved for
  -- it: `typeof(x'')` is `'blob'` and `0 % {{RERANK_BYTES}}` is 0, so the column
  -- DEFAULT satisfies its own CHECK. The cap is §3.1's four, restated in SQL
  -- because the schema's `.max(4)` is a guarantee only writers that go through the
  -- schema get.
  --
  -- What this cannot guarantee: that `facet_counts` is positionally aligned with
  -- these centroids. That is a two-column invariant a per-column CHECK cannot see,
  -- and a view column on a view table besides — `rebuild-index` is what makes it
  -- true again.
  facets          BLOB NOT NULL DEFAULT x''
                    CHECK (typeof(facets) = 'blob'
                       AND length(facets) % {{RERANK_BYTES}} = 0
                       AND length(facets) <= 4 * {{RERANK_BYTES}}),
  -- How many claims each centroid above is the mean of, as a JSON array of ints,
  -- positionally aligned with `facets`. §3.1's update is `mean ← mean + (x −
  -- mean)/(n+1)`, which is O(1) only while n is kept; without it the "incremental"
  -- mean is a full re-average over every claim attached to the referent. A view
  -- column on a view table, so it costs nothing to be wrong about and is rebuilt
  -- with the rest of the index.
  facet_counts    TEXT NOT NULL DEFAULT '[]',
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
  -- The first naming, not the latest: the pair is a set member, and the instant
  -- it entered the set is the one an audit can do anything with.
  at           TEXT NOT NULL,
  -- The support standing behind this naming, cached from the naming claim's own
  -- posterior. §3.1 calls this index "the many-to-one mention index materializing
  -- identity claims over names" and `entities.name` "the most-corroborated surface
  -- form", so a naming is a claim and its corroboration is ordinary evidence: the
  -- claim's α is the number, and this column is a cache of it that `rebuild-index`
  -- refills from the ledger. It was a count of uses, which no rebuild could
  -- reproduce and which counted insistence — twelve repeats in one episode
  -- outranking four namings from four, the inversion §4.2's cap and §4.4's
  -- independence accounting exist to prevent.
  --
  -- `REAL` and not `INTEGER` because §15's tier weights and §4.2's 1, ½, ¼, …
  -- cap series are fractional, and a column that could only hold whole numbers
  -- would round two-and-a-bit observations to two or to three and change which
  -- surface form a referent answers to.
  --
  -- The CHECK is the same argument as the posterior's, on a column where it has
  -- already been reachable rather than merely possible. `REAL` is an affinity: it
  -- converts what it can read as a number and leaves everything else exactly as it
  -- arrived, so `weight = 'zzz'` is stored as TEXT — and the tally is read
  -- `ORDER BY weight DESC`, where every TEXT outranks every number. A single
  -- corrupt row therefore reaches the head of the list, and §3.1's derived name is
  -- the head of the list and nothing more, so the referent is renamed by the
  -- garbage. Refusing the write is what stops that; no read-path guard would,
  -- because the read is doing exactly what §3.1 says.
  --
  -- `IN ('real','integer')` and not `= 'real'`: affinity converts an integer
  -- literal to REAL here, but the storage class is what is being fenced and an
  -- arm that admitted only one of the two numeric ones would be fencing the
  -- conversion instead. Numeric text is untouched by any of this — affinity
  -- converts `'1.5'` to REAL 1.5 before a CHECK could run, and that is intended.
  --
  -- `>= 0` and not `> 0`: support is a sum of non-negative observation weights
  -- (§4.2), and a tainted episode contributes exactly zero.
  --
  -- What this cannot guarantee: that the weight is *true*. `weight = weight + 1`
  -- from any writer is a well-formed real and an uncorroborated naming. The
  -- defence there is not the CHECK but derivability: this column is a cache, and
  -- `rebuild-index` re-reads every one of them off the naming claims.
  weight       REAL NOT NULL DEFAULT 0
                 CHECK (typeof(weight) IN ('real','integer') AND weight >= 0),
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
  -- An f32 blob at the §11 rerank width. Migration 0 is final on this column.
  --
  -- Checked for the same reason as `entities.gloss_embedding`, and see there for
  -- the full argument: BLOB affinity converts nothing, so text and integers both
  -- survive into the column, and an integer is the quiet one — it decodes to an
  -- empty vector without raising. The width clause refuses the blobs that are
  -- blobs but not vectors of this width.
  --
  -- What this cannot guarantee: that these 3072 bytes and the int8 copy in
  -- `claim_vectors` are the same vector. The two are written by two statements and
  -- kept in step by the transaction around them, not by anything a CHECK can see;
  -- §11 makes the narrow copy rebuildable from this one precisely so that a drift
  -- between them is repairable rather than fatal.
  embedding         BLOB NOT NULL
                      CHECK (typeof(embedding) = 'blob'
                         AND length(embedding) = {{RERANK_BYTES}}),
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
  --
  -- The evidence arm asks what the posterior *is*, not only whether one is there,
  -- because `alpha REAL` above declares an affinity and not a type. SQLite stores
  -- a value it cannot read as a number exactly as it arrived, and `>` then
  -- compares storage classes, in which every TEXT outranks every number and every
  -- BLOB every TEXT: `'abc' > 0` is true. Without the `typeof` clauses an α of
  -- `'abc'` is a well-formed row by presence and sign and a garbage posterior by
  -- every reading of §4.1. Numeric text is untouched by this — affinity converts
  -- `'1.5'` to a REAL before any CHECK runs, so only genuinely unreadable values
  -- are refused. `'integer'` cannot arise while the affinity is REAL, which
  -- converts bound integers on the way in; it is admitted so the rule survives a
  -- later change to that affinity rather than silently becoming vacuous. The
  -- `IS NOT NULL` clauses are subsumed by `typeof` (a NULL's is `'null'`) and kept
  -- because presence is the §6 rule and belongs in the SQL that states it.
  --
  -- What this still cannot see: `alpha = alpha + 1` against a view claim yields
  -- NULL, which satisfies the view arm, so a raw increment of a claim that has no
  -- posterior is accepted and changes nothing. No table CHECK can catch that —
  -- only the `regime = 'evidence'` predicate the store carries on its own §4.2
  -- and §4.5 UPDATEs can, which is why it is there as well as this.
  CHECK ((regime = 'view'     AND alpha IS NULL     AND beta IS NULL)
      OR (regime = 'evidence' AND alpha IS NOT NULL AND beta IS NOT NULL
                              AND typeof(alpha) IN ('real','integer')
                              AND typeof(beta)  IN ('real','integer')
                              AND alpha > 0 AND beta > 0))
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
  -- Same affinity argument as `mentions.weight`, and the same two clauses. The axis is
  -- read back `ORDER BY axis, ordinal`, so a TEXT ordinal does not merely sit in
  -- the wrong place — it sorts after every integer ordinal on the axis and quietly
  -- rewrites the order of the artifacts, change events and episodes that §4.4
  -- independence discounting and §4.5 churn decay read. The `UNIQUE` below does not
  -- help on its own: it compares storage classes too, so `'0'` written as text is a
  -- different key from `0`, and the `typeof` clause is what closes that.
  --
  -- What this cannot guarantee: that each axis is a dense 0-based sequence. No
  -- table CHECK can see across rows, so an ordinal of 9 on a claim's first artifact
  -- is accepted here and simply orders that artifact last. Denseness belongs to the
  -- writer and to a renumbering rebuild; only the `>= 0` floor and the storage
  -- class are expressible at this level.
  ordinal  INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
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
  -- Same two clauses as `mentions.weight`, narrowed to whole numbers and applied
  -- before there is a writer rather than after. v1 writes nothing here, which is
  -- exactly the moment to state what `n` is: this one really does count pathways,
  -- so a fractional value is nonsense where a fractional weight next door is not.
  -- The saturation gate divides by it and compares it against a threshold, so
  -- a TEXT count would not merely read wrong, it would read as *unbounded* under
  -- storage-class ordering and suppress the corroboration the gate exists to meter.
  -- `>= 0` admits the DEFAULT, which is the row a first corroboration mints.
  n             INTEGER NOT NULL DEFAULT 0
                  CHECK (typeof(n) = 'integer' AND n >= 0),
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

-- Parsed structural edges, re-derived on every parse. Deliberately no alpha/beta
-- and no tier: principle 2 says these carry no confidence machinery and are true
-- until the next parse. `kind` is an open parser vocabulary (CALLS, IMPORTS,
-- CONTAINS, ...), not the closed claim-edge set.
--
-- Written whole-set per source entity, which is why containment no longer lives
-- here: `DELETE FROM entity_edges WHERE from_id = ?` is the replacement, and an
-- emitter that re-emitted only CALLS for a module used to take that module's
-- containment down with it. Nothing reported the loss, because dropping edges is
-- what a re-parse is *for*.
CREATE TABLE entity_edges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  to_id   TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  UNIQUE (from_id, kind, to_id)
);

CREATE INDEX idx_entity_edges_to ON entity_edges (to_id, kind);

-- The containment index (diagram §4, `CONTAINS_INDEX { parent, child }`): the
-- spine, materialized from containment claims and rebuilt by `rebuild-index`
-- alone. Its own table rather than a `kind` value in `entity_edges`, because the
-- two are maintained on different clocks — a parse re-derives one, replaying the
-- ledger re-derives the other — and a shared table means whichever ran last wins.
--
-- Parent and child, not `from`/`to` with a kind: there is exactly one relation
-- here. Direct edges only; the transitive closure is a traversal, not a row.
CREATE TABLE contains_index (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  UNIQUE (parent_id, child_id)
);

CREATE INDEX idx_contains_index_child ON contains_index (child_id);

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
  -- Both payload columns are JSON that `readStageLog` parses, so both are
  -- guarded at the write boundary. TEXT affinity is no help here: it converts a
  -- number to text and leaves a blob exactly as it arrived, so the column can
  -- hand back bytes `JSON.parse` chokes on however this column is declared.
  --
  -- The read path refuses such a row by type rather than degrading it, which is
  -- the opposite of what `entities.locator` does and is argued on
  -- `CorruptStageLogError`: §13 replays this table to tune every ⚙ constant in
  -- §15, and a payload that came back empty would be indistinguishable from a
  -- stage that honestly logged nothing. These CHECKs cannot repair a row already
  -- on disk; they stop the next writer that is not this store from leaving one.
  --
  -- `decision` is nullable and its NULL is not corruption — a stage that decided
  -- nothing is the ordinary case, a dedupe rejection every time — so the guard
  -- admits SQL NULL and checks only bytes that are actually there.
  inputs     TEXT NOT NULL CHECK (json_valid(inputs)),
  decision   TEXT CHECK (decision IS NULL OR json_valid(decision)),
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
