/**
 * The witness an increment may carry: which episode moved this posterior.
 *
 * §4.2 weighs an observation by `tier × episode_cap × taint`, and the episode
 * cap is a function of *how many times this episode has already contributed to
 * this claim*. Today that count is only answerable for claims the ingest port
 * can reach through an `ABOUT` edge — {@link contributionsFromEpisode} walks
 * `getClaimsAbout` and counts the ones whose provenance names the episode.
 *
 * F2 puts naming corroboration on claims that carry no `ABOUT` edge at all
 * (§5.3's structural channel retrieves knowledge *about* a referent, and what a
 * referent is *called* is not that), so the count has to come from the claim's
 * own provenance instead. That is what `witness` is for: an increment that names
 * its episode leaves a provenance row saying so, in the same transaction as the
 * α it added, and the next increment from that episode can read its own cap off
 * the ledger rather than off a counter no rebuild could reproduce.
 *
 * Two writes, one transaction, is the whole claim of this file. A posterior that
 * moved without a provenance row is a contribution no cap can ever discount
 * again; a provenance row without the posterior is an episode credited with
 * evidence it never supplied. §12 files both as lost-update failures, and the
 * only defence against either is that neither can happen alone.
 *
 * Real SQLite throughout, on a temp file rather than `:memory:`, because two of
 * these cases need a second connection: `:memory:` opens a private, unshared
 * database, so a second connection to one would be a second empty database.
 *
 * @spec §3.5, §4.2, §4.4, §5.7, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RegimeViolationError,
  openGraphStore,
  type EvidenceIncrement,
  type GraphStore,
} from '../index';

import {
  AGENT,
  CHANNEL,
  CLAIM_ID,
  EPISODE_ID,
  OTHER_EPISODE_ID,
  PRIOR_ALPHA,
  PRIOR_BETA,
  PRIOR_BETA_INFERRED,
  RIVAL_CLAIM_ID,
  THIRD_CLAIM_ID,
  makeClaim,
  makeEntity,
  makeMinimalClaim,
  makeViewClaim,
} from './fixtures';

/**
 * The episode doing the witnessing — a third one, so it cannot be confused with
 * either episode {@link makeClaim} already records.
 *
 * @spec §3.5, §4.4
 */
const WITNESS_EPISODE = 'ep-2026-08-22-1533';

/** A second witnessing episode, for the cases about independence. @spec §4.4 */
const OTHER_WITNESS_EPISODE = 'ep-2026-08-22-1702';

/**
 * What an increment says about where it came from.
 *
 * F2 adds this to {@link EvidenceIncrement}. Declared here rather than imported
 * because the member does not exist yet, and a test that will not compile is not
 * a test that failed for the reason it was written for.
 *
 * @spec §3.5, §4.2
 */
interface Witness {
  /** The episode this contribution belongs to — §4.4's unit of independence. @spec §4.4 */
  readonly episodeId: string;
  /** §4.7's pathway half, when the contribution has one. @spec §3.5, §4.7 */
  readonly channel?: string | undefined;
  /** The other pathway half. @spec §3.5, §4.7 */
  readonly agent?: string | undefined;
}

/** One increment that names its episode. @spec §4.2 */
type WitnessedIncrement = EvidenceIncrement & { readonly witness: Witness };

/**
 * The one place this file crosses into the API F2 has yet to add.
 *
 * An intersection rather than a cast: `EvidenceIncrement & { witness }` is
 * assignable to `EvidenceIncrement` today, so the type checker stays quiet and
 * the RED signal lands at runtime, where the missing behaviour actually is.
 *
 * @spec §4.2
 */
const witnessed = (store: GraphStore, increment: WitnessedIncrement): void => {
  store.incrementEvidence(increment);
};

let directory: string;
let store: GraphStore;
let dbPath: string;

/** The provenance triple a claim currently carries, as the store reports it. @spec §3.5 */
const provenanceOf = (claimId: string): Record<string, unknown> => {
  const claim = store.getClaim(claimId);
  if (claim === undefined) throw new Error(`the ledger holds no claim ${claimId}`);
  return { ...claim.provenance };
};

/** The episodes a claim's provenance names, in ordinal order. @spec §3.5 */
const episodesOf = (claimId: string): readonly string[] => {
  const claim = store.getClaim(claimId);
  if (claim === undefined) throw new Error(`the ledger holds no claim ${claimId}`);
  return claim.provenance.episodes;
};

/** A claim's α, or a failure loud enough to read. @spec §4.1 */
const alphaOf = (claimId: string): number => {
  const evidence = store.getEvidence(claimId);
  if (evidence === undefined) throw new Error(`the ledger holds no claim ${claimId}`);
  if (evidence === null) throw new Error(`${claimId} carries no posterior`);
  return evidence.alpha;
};

/**
 * Makes the provenance table refuse the next insert, from outside this store.
 *
 * A trigger rather than a contrived key collision, and deliberately so. The
 * property under test is that the α update and the provenance append share one
 * transaction — not *which* constraint refuses the second write. A collision
 * test would have to guess the ordinal the implementation will pick (`MAX + 1`
 * and `COUNT` are both defensible, and neither can be made to collide from
 * outside), so it would pin a strategy instead of the invariant. This is still
 * the database refusing a write, on a real connection, with nothing mocked: the
 * store is never faked in this suite, and it is not faked here.
 *
 * @spec §5.7, §11, §12
 */
const refuseProvenanceWrites = (): void => {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TRIGGER refuse_provenance BEFORE INSERT ON provenance
      BEGIN SELECT RAISE(ABORT, 'this provenance row is refused'); END;
    `);
  } finally {
    db.close();
  }
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-witness-'));
  dbPath = join(directory, 'graph.db');
  store = openGraphStore({ path: dbPath });
  store.putEntity(makeEntity());
  store.putClaim(makeClaim());
  store.putClaim(makeMinimalClaim());
  store.putClaim(makeViewClaim());
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('an increment that names the episode behind it', () => {
  it('moves the posterior and records the episode that moved it', () => {
    witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });

    expect(alphaOf(CLAIM_ID)).toBe(PRIOR_ALPHA + 1);
    expect(episodesOf(CLAIM_ID)).toStrictEqual([EPISODE_ID, OTHER_EPISODE_ID, WITNESS_EPISODE]);
  });

  it('records one row per contribution, so an episode cap can be counted from the ledger', () => {
    for (let contribution = 0; contribution < 3; contribution += 1)
      witnessed(store, {
        claimId: RIVAL_CLAIM_ID,
        alpha: 2 ** -contribution,
        witness: { episodeId: WITNESS_EPISODE },
      });

    expect(episodesOf(RIVAL_CLAIM_ID)).toStrictEqual([
      WITNESS_EPISODE,
      WITNESS_EPISODE,
      WITNESS_EPISODE,
    ]);
  });

  it('keeps two episodes apart, because §4.4 counts episodes and not utterances', () => {
    witnessed(store, {
      claimId: RIVAL_CLAIM_ID,
      alpha: 1,
      witness: { episodeId: WITNESS_EPISODE },
    });
    witnessed(store, {
      claimId: RIVAL_CLAIM_ID,
      alpha: 1,
      witness: { episodeId: OTHER_WITNESS_EPISODE },
    });

    expect(episodesOf(RIVAL_CLAIM_ID)).toStrictEqual([WITNESS_EPISODE, OTHER_WITNESS_EPISODE]);
  });

  it('touches neither of the other two provenance axes', () => {
    witnessed(store, { claimId: RIVAL_CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });

    expect(provenanceOf(RIVAL_CLAIM_ID)).toStrictEqual({
      episodes: [WITNESS_EPISODE],
      changeEvents: [],
      artifacts: [],
    });
  });
});

describe('the pathway signature a witness may carry', () => {
  it('round-trips the channel and the agent onto a claim that had neither', () => {
    witnessed(store, {
      claimId: RIVAL_CLAIM_ID,
      alpha: 1,
      witness: { episodeId: WITNESS_EPISODE, channel: CHANNEL, agent: AGENT },
    });

    expect(provenanceOf(RIVAL_CLAIM_ID)).toStrictEqual({
      episodes: [WITNESS_EPISODE],
      changeEvents: [],
      artifacts: [],
      channel: CHANNEL,
      agent: AGENT,
    });
  });

  it('records a channel without inventing an agent to go with it', () => {
    witnessed(store, {
      claimId: RIVAL_CLAIM_ID,
      alpha: 1,
      witness: { episodeId: WITNESS_EPISODE, channel: CHANNEL },
    });

    expect(provenanceOf(RIVAL_CLAIM_ID)).toStrictEqual({
      episodes: [WITNESS_EPISODE],
      changeEvents: [],
      artifacts: [],
      channel: CHANNEL,
    });
  });

  it('leaves the signature off entirely when the witness carries none, rather than recording an empty one', () => {
    witnessed(store, { claimId: RIVAL_CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });
    const provenance = provenanceOf(RIVAL_CLAIM_ID);

    // The row exists — otherwise the two absences below would be true of a
    // provenance triple nothing ever wrote to.
    expect(provenance['episodes']).toStrictEqual([WITNESS_EPISODE]);
    expect(Object.hasOwn(provenance, 'channel')).toBe(false);
    expect(Object.hasOwn(provenance, 'agent')).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * One transaction, or neither write.
 * ---------------------------------------------------------------------------
 */

describe('an increment whose posterior the store refuses', () => {
  it('leaves no provenance row behind on a view claim, which has no posterior to move', () => {
    const before = provenanceOf(THIRD_CLAIM_ID);

    expect(() => {
      witnessed(store, {
        claimId: THIRD_CLAIM_ID,
        alpha: 1,
        witness: { episodeId: WITNESS_EPISODE },
      });
    }).toThrow(RegimeViolationError);

    expect(provenanceOf(THIRD_CLAIM_ID)).toStrictEqual(before);
    // The control: the same witness against a claim that has a posterior does
    // land, so the assertion above is a refusal and not a witness that never
    // wrote anything anywhere.
    witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });
    expect(episodesOf(CLAIM_ID)).toContain(WITNESS_EPISODE);
  });

  it('leaves no provenance row behind when the contribution itself is out of range', () => {
    const before = provenanceOf(CLAIM_ID);

    expect(() => {
      witnessed(store, { claimId: CLAIM_ID, alpha: -1, witness: { episodeId: WITNESS_EPISODE } });
    }).toThrow(RangeError);

    expect(provenanceOf(CLAIM_ID)).toStrictEqual(before);
    expect(store.getEvidence(CLAIM_ID)).toStrictEqual({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA });
    // The same control: a witness the store accepts does reach the table.
    witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });
    expect(episodesOf(CLAIM_ID)).toContain(WITNESS_EPISODE);
  });
});

describe('an increment whose provenance row the database refuses', () => {
  it('leaves the posterior exactly where it was', () => {
    refuseProvenanceWrites();

    expect(() => {
      witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });
    }).toThrow();

    expect(store.getEvidence(CLAIM_ID)).toStrictEqual({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA });
  });

  it('leaves the posterior of a claim with no provenance at all where it was', () => {
    refuseProvenanceWrites();

    expect(() => {
      witnessed(store, {
        claimId: RIVAL_CLAIM_ID,
        alpha: 1,
        witness: { episodeId: WITNESS_EPISODE },
      });
    }).toThrow();

    expect(store.getEvidence(RIVAL_CLAIM_ID)).toStrictEqual({
      alpha: PRIOR_ALPHA,
      beta: PRIOR_BETA_INFERRED,
    });
    expect(episodesOf(RIVAL_CLAIM_ID)).toStrictEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The unwitnessed increment, which is every increment written before F2.
 * ---------------------------------------------------------------------------
 */

/*
 * ---------------------------------------------------------------------------
 * The ordinal the append picks, and the constraint that can refuse it.
 * ---------------------------------------------------------------------------
 */

/** Appends enough witnesses to one claim that a stale `MAX` would have collided. @spec §3.5 */
const MANY_APPENDS = 64;

/** How many distinct episodes {@link MANY_APPENDS} is spread over, so repeats and firsts interleave. @spec §4.4 */
const WITNESSING_EPISODES = 7;

/**
 * The largest ordinal SQLite can hold as an integer.
 *
 * Seeding the axis with it is what turns `COALESCE(MAX(ordinal), -1) + 1` into
 * an overflow: SQLite promotes the sum to REAL, and `typeof(ordinal) =
 * 'integer'` refuses it. That is a *table* CHECK refusing the store's own
 * statement — the refusal this file otherwise provokes with a trigger, arrived
 * at through the schema instead of around it.
 *
 * @spec §3.5, §12
 */
const ORDINAL_CEILING = 9223372036854775807n;

/** The ordinals one claim's episode axis carries, read straight off the file. @spec §3.5 */
const episodeOrdinals = (claimId: string): number[] => {
  const db = new Database(dbPath);
  try {
    return (
      db
        .prepare(
          `SELECT ordinal FROM provenance WHERE claim_id = ? AND axis = 'episode' ORDER BY ordinal`,
        )
        .all(claimId) as ReadonlyArray<{ readonly ordinal: number }>
    ).map((row) => row.ordinal);
  } finally {
    db.close();
  }
};

/** Puts an episode row at {@link ORDINAL_CEILING}, from outside this store. @spec §3.5 */
const seedOrdinalCeiling = (claimId: string): void => {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO provenance (claim_id, axis, value, ordinal) VALUES (?, 'episode', 'ep-ceiling', ?)`,
    ).run(claimId, ORDINAL_CEILING);
  } finally {
    db.close();
  }
};

describe('the ordinal a witnessed append chooses', () => {
  it('numbers a long run of appends densely from zero, with nothing repeated and nothing skipped', () => {
    for (let append = 0; append < MANY_APPENDS; append += 1)
      witnessed(store, {
        claimId: RIVAL_CLAIM_ID,
        alpha: 2 ** -20,
        witness: { episodeId: `${WITNESS_EPISODE}-${String(append % WITNESSING_EPISODES)}` },
      });

    expect(episodeOrdinals(RIVAL_CLAIM_ID)).toStrictEqual([...Array(MANY_APPENDS).keys()]);
  });

  it('hands the whole run back through the store in the order it wrote them', () => {
    for (let append = 0; append < MANY_APPENDS; append += 1)
      witnessed(store, {
        claimId: RIVAL_CLAIM_ID,
        alpha: 2 ** -20,
        witness: { episodeId: `${WITNESS_EPISODE}-${String(append)}` },
      });

    expect(episodesOf(RIVAL_CLAIM_ID)).toStrictEqual(
      [...Array(MANY_APPENDS).keys()].map((append) => `${WITNESS_EPISODE}-${String(append)}`),
    );
  });

  it('starts a claim that had episodes already after the ones it had', () => {
    witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });

    expect(episodeOrdinals(CLAIM_ID)).toStrictEqual([0, 1, 2]);
  });
});

describe('an increment whose provenance row a table CHECK refuses', () => {
  it('leaves the posterior exactly where it was, with no trigger involved', () => {
    seedOrdinalCeiling(CLAIM_ID);
    const before = episodeOrdinals(CLAIM_ID);

    expect(() => {
      witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });
    }).toThrow(/CHECK constraint failed/);

    expect(store.getEvidence(CLAIM_ID)).toStrictEqual({ alpha: PRIOR_ALPHA, beta: PRIOR_BETA });
    expect(episodeOrdinals(CLAIM_ID)).toStrictEqual(before);
  });

  it('does not credit the episode it refused to record', () => {
    seedOrdinalCeiling(CLAIM_ID);

    expect(() => {
      witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });
    }).toThrow();

    expect(episodesOf(CLAIM_ID)).not.toContain(WITNESS_EPISODE);
  });
});

describe('an increment that names no episode', () => {
  it('adds nothing to the provenance triple, so only a witness ever writes one', () => {
    const before = episodesOf(CLAIM_ID);
    for (let contribution = 0; contribution < 3; contribution += 1)
      store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });

    witnessed(store, { claimId: CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });

    expect(episodesOf(CLAIM_ID)).toStrictEqual([...before, WITNESS_EPISODE]);
  });

  it('still moves the posterior exactly as much as a witnessed one does', () => {
    store.incrementEvidence({ claimId: CLAIM_ID, alpha: 1 });
    const unwitnessed = alphaOf(CLAIM_ID);

    witnessed(store, { claimId: RIVAL_CLAIM_ID, alpha: 1, witness: { episodeId: WITNESS_EPISODE } });

    expect(unwitnessed - PRIOR_ALPHA).toBe(alphaOf(RIVAL_CLAIM_ID) - PRIOR_ALPHA);
    expect(episodesOf(RIVAL_CLAIM_ID)).toStrictEqual([WITNESS_EPISODE]);
  });
});
