/**
 * What a *failed* write leaves behind.
 *
 * Every other file in this suite checks that a refusal throws. None of them
 * checks what the database looks like afterwards — so every `#db.transaction()`
 * wrapper in the adapter could be deleted and the suite would stay green while
 * the store quietly started shipping half-written claims.
 *
 * Two half-writes matter enough to pin by name.
 *
 * **A claim row without its vectors is a claim that can never be found.** §5.3's
 * semantic channel is the only way a claim re-enters the pipeline once the
 * episode that minted it is over; a claim row whose `claim_vectors` row was
 * never written is not "missing from one index", it is permanently invisible,
 * silently, and no read anywhere in the system will report it as wrong.
 *
 * **A claim archived in one table but not the other is an ANN result §6.1 calls
 * a bug.** "Archived claims leave candidate retrieval entirely — if ANN surfaces
 * one, that is a bug." The exclusion lives on `claim_vectors.archived`, so a
 * status change that updates `claims` and then fails leaves a retired claim
 * still being offered to the adjudicator as a live near-duplicate.
 *
 * **On the fault injection.** The store is never mocked and never stubbed here;
 * neither is better-sqlite3. Faults are installed as real `RAISE(ABORT)`
 * triggers on the database file through a second connection — genuine
 * constraint violations, indistinguishable from a `CHECK` the schema might have
 * carried, raised from inside SQLite at a chosen statement. That is the only
 * way to reach the seam *between* two statements from outside the store, and it
 * is what makes these assertions decisive: without the surrounding transaction,
 * better-sqlite3 auto-commits each statement, so the statements before the
 * aborted one survive as observable damage.
 *
 * Everything asserted afterwards is read back through the public port.
 *
 * @spec §5.7, §6.1, §11, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UnknownClaimError, openGraphStore, type Claim, type GraphStore } from '../index';

import {
  CLAIM_ID,
  ENTITY_ID,
  EPISODE_ID,
  OTHER_ENTITY_ID,
  RIVAL_CLAIM_ID,
  SESSION_ID,
  makeClaim,
  makeEntity,
  makeMinimalEntity,
  unitVector,
} from './fixtures';

/** The embedding of the claim whose mint is made to fail; also the query every ANN assertion here probes with. @spec §5.3 */
const DOOMED_VECTOR = unitVector(80);

/**
 * A provenance file path no `BEFORE INSERT` trigger will accept.
 *
 * `file` is the last of the three axes `putClaim` persists, so aborting on it
 * puts the claim row, both other axes and part of the file axis on the wrong
 * side of the failure — the widest partial write the operation can produce.
 *
 * @spec §3.5
 */
const POISONED_FILE = 'src/auth/poisoned.ts';

/** A structural edge kind no `BEFORE INSERT` trigger will accept. @spec §3.3 */
const POISONED_EDGE_KIND = 'POISONED';

/** An entity name no `BEFORE UPDATE` trigger will accept. @spec §3.1 */
const POISONED_ENTITY_NAME = 'PoisonedName';

/** A claim id that was never minted, for the refusals that need no injected fault at all. @spec §3.2 */
const ABSENT_CLAIM_ID = 'NEVERMINTED00000000000000A';

let directory: string;
let dbPath: string;
let store: GraphStore;
let control: Database.Database;

/**
 * Installs one real abort trigger on the database under test.
 *
 * The connection is a plain better-sqlite3 handle with no sqlite-vec loaded,
 * which is fine because it only ever touches ordinary tables: sqlite-vec's
 * `vec0` shadow tables refuse triggers outright, and the store's own connection
 * would read the database as malformed if one were attached to them.
 *
 * @spec §11
 */
const failWhen = (name: string, table: string, event: string, when: string): void => {
  control.exec(
    `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} WHEN ${when}
       BEGIN SELECT RAISE(ABORT, 'injected ${name} failure'); END`,
  );
};

/** Lifts an installed fault, so the same operation can be retried for real. @spec §11 */
const stopFailing = (name: string): void => {
  control.exec(`DROP TRIGGER ${name}`);
};

/** The claim whose mint is interrupted partway through. @spec §3.2, §3.5 */
const doomedClaim = (): Claim =>
  makeClaim({
    id: RIVAL_CLAIM_ID,
    text: 'A claim whose mint is interrupted between its row and its vectors.',
    embedding: Array.from(DOOMED_VECTOR),
    provenance: {
      episodes: [EPISODE_ID],
      commits: ['3c8a6f41d29e0b7c5a3d81f6e29f2c1ab4e7d05b'],
      files: ['src/auth/session.ts', POISONED_FILE],
    },
  });

/** Whether ANN currently offers this claim as a §5.3 candidate. @spec §5.3, §6.1 */
const annOffers = (claimId: string, probe: Float32Array): boolean =>
  store
    .searchClaims({ embedding: probe, limit: 10 })
    .some((hit) => hit.claimId === claimId);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kg-mcp-rollback-'));
  dbPath = join(directory, 'graph.db');

  store = openGraphStore({ path: dbPath });
  store.putEntity(makeEntity());
  store.putClaim(makeClaim());

  control = new Database(dbPath);
});

afterEach(() => {
  control.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('a putClaim that fails after the claim row is written', () => {
  beforeEach(() => {
    failWhen('fail_provenance', 'provenance', 'INSERT', `NEW.value = '${POISONED_FILE}'`);
  });

  it('refuses the mint', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();
  });

  it('leaves no claim readable by id', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();

    expect(store.getClaim(RIVAL_CLAIM_ID)).toBeUndefined();
  });

  it('never leaves a claim that reads back by id but no ANN search can reach, which is the failure no read would report', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();

    const readable = store.getClaim(RIVAL_CLAIM_ID) !== undefined;

    expect([readable, annOffers(RIVAL_CLAIM_ID, DOOMED_VECTOR)]).toStrictEqual([false, false]);
  });

  it('leaves no rerank vector for the claim that was refused', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();

    expect(store.getRerankVector(RIVAL_CLAIM_ID)).toBeUndefined();
  });

  it('leaves no ANN vector for the claim that was refused', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();

    expect(store.getAnnVector(RIVAL_CLAIM_ID)).toBeUndefined();
  });

  it('leaves the claim that was already in the ledger exactly as it was', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();

    expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
  });

  it('leaves no residue at all, so the same claim mints cleanly once the fault is gone', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();
    stopFailing('fail_provenance');

    store.putClaim(doomedClaim());

    expect(store.getClaim(RIVAL_CLAIM_ID)).toStrictEqual(doomedClaim());
  });

  it('and the re-minted claim is findable by ANN, because its vectors were written this time', () => {
    expect(() => {
      store.putClaim(doomedClaim());
    }).toThrow();
    stopFailing('fail_provenance');
    store.putClaim(doomedClaim());

    expect(annOffers(RIVAL_CLAIM_ID, DOOMED_VECTOR)).toBe(true);
  });
});

describe('a setClaimStatus that fails partway', () => {
  it('leaves an active claim active when the transition into archived is refused', () => {
    failWhen('fail_archive', 'claims', 'UPDATE', `NEW.status = 'archived'`);

    expect(() => {
      store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    }).toThrow();

    expect(store.getClaim(CLAIM_ID)?.status).toBe('active');
  });

  it('leaves that claim exactly as ANN-visible as it was, so the two tables never disagree', () => {
    failWhen('fail_archive', 'claims', 'UPDATE', `NEW.status = 'archived'`);

    expect(() => {
      store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    }).toThrow();

    expect(annOffers(CLAIM_ID, unitVector(10))).toBe(true);
  });

  it('leaves an archived claim out of ANN when the transition back to active is refused', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    failWhen('fail_revive', 'claims', 'UPDATE', `NEW.status <> 'archived'`);

    expect(() => {
      store.setClaimStatus({ claimId: CLAIM_ID, status: 'active' });
    }).toThrow();

    expect(annOffers(CLAIM_ID, unitVector(10))).toBe(false);
  });

  it('keeps an archived claim out of ANN across every refused transition, since §6.1 admits no exceptions', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    failWhen('fail_revive', 'claims', 'UPDATE', `NEW.status <> 'archived'`);
    const live = ['provisional', 'active', 'disputed', 'deprecated'] as const;

    const offered = live.map((status) => {
      expect(() => {
        store.setClaimStatus({ claimId: CLAIM_ID, status });
      }).toThrow();
      return annOffers(CLAIM_ID, unitVector(10));
    });

    expect(offered).toStrictEqual([false, false, false, false]);
  });

  it('leaves the claim archived after every one of those refusals', () => {
    store.setClaimStatus({ claimId: CLAIM_ID, status: 'archived' });
    failWhen('fail_revive', 'claims', 'UPDATE', `NEW.status <> 'archived'`);

    expect(() => {
      store.setClaimStatus({ claimId: CLAIM_ID, status: 'active' });
    }).toThrow();

    expect(store.getClaim(CLAIM_ID)?.status).toBe('archived');
  });

  it('changes no other claim when it refuses an id it has never minted', () => {
    expect(() => {
      store.setClaimStatus({ claimId: ABSENT_CLAIM_ID, status: 'archived' });
    }).toThrow(UnknownClaimError);

    expect(store.getClaim(CLAIM_ID)?.status).toBe('active');
  });

  it('and takes nothing out of ANN when it refuses an id it has never minted', () => {
    expect(() => {
      store.setClaimStatus({ claimId: ABSENT_CLAIM_ID, status: 'archived' });
    }).toThrow(UnknownClaimError);

    expect(annOffers(CLAIM_ID, unitVector(10))).toBe(true);
  });
});

describe('a putStructuralEdges that fails after the previous set was deleted', () => {
  beforeEach(() => {
    store.putEntity(makeMinimalEntity());
    store.putStructuralEdges(ENTITY_ID, [{ kind: 'CONTAINS', to: OTHER_ENTITY_ID }]);
    failWhen('fail_edges', 'entity_edges', 'INSERT', `NEW.kind = '${POISONED_EDGE_KIND}'`);
  });

  it('refuses the replacement', () => {
    expect(() => {
      store.putStructuralEdges(ENTITY_ID, [
        { kind: POISONED_EDGE_KIND, to: OTHER_ENTITY_ID },
      ]);
    }).toThrow();
  });

  it('leaves the previous structural edges standing rather than clearing the spine', () => {
    expect(() => {
      store.putStructuralEdges(ENTITY_ID, [
        { kind: POISONED_EDGE_KIND, to: OTHER_ENTITY_ID },
      ]);
    }).toThrow();

    expect(store.getStructuralEdges(ENTITY_ID)).toStrictEqual([
      { from: ENTITY_ID, kind: 'CONTAINS', to: OTHER_ENTITY_ID },
    ]);
  });

  it('writes none of the edges that came before the one it refused', () => {
    expect(() => {
      store.putStructuralEdges(ENTITY_ID, [
        { kind: 'CALLS', to: OTHER_ENTITY_ID },
        { kind: POISONED_EDGE_KIND, to: OTHER_ENTITY_ID },
      ]);
    }).toThrow();

    expect(store.getStructuralEdges(ENTITY_ID).map((edge) => edge.kind)).toStrictEqual([
      'CONTAINS',
    ]);
  });

  it('leaves the entity itself readable', () => {
    expect(() => {
      store.putStructuralEdges(ENTITY_ID, [
        { kind: POISONED_EDGE_KIND, to: OTHER_ENTITY_ID },
      ]);
    }).toThrow();

    expect(store.getEntity(ENTITY_ID)).toStrictEqual(makeEntity());
  });
});

describe('a recordTaint naming a mix of known and unknown claims', () => {
  it('refuses the whole record', () => {
    expect(() => {
      store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, ABSENT_CLAIM_ID] });
    }).toThrow(UnknownClaimError);
  });

  it('leaves the session taint set empty rather than partially populated', () => {
    expect(() => {
      store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, ABSENT_CLAIM_ID] });
    }).toThrow(UnknownClaimError);

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set());
  });

  it('does not taint the valid claim it had already reached, which would silently mute real corroboration', () => {
    expect(() => {
      store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, ABSENT_CLAIM_ID] });
    }).toThrow(UnknownClaimError);

    expect(store.isTainted({ sessionId: SESSION_ID, claimId: CLAIM_ID })).toBe(false);
  });

  it('leaves an earlier successful record for the same session intact', () => {
    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID] });

    expect(() => {
      store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, ABSENT_CLAIM_ID] });
    }).toThrow(UnknownClaimError);

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set([CLAIM_ID]));
  });

  it('records the whole set once every id in it resolves', () => {
    store.putClaim(doomedClaim());

    store.recordTaint({ sessionId: SESSION_ID, claimIds: [CLAIM_ID, RIVAL_CLAIM_ID] });

    expect(store.getTaintSet(SESSION_ID)).toStrictEqual(new Set([CLAIM_ID, RIVAL_CLAIM_ID]));
  });
});

describe('a putEntity that fails', () => {
  it('leaves the previous spine node exactly as it was', () => {
    failWhen('fail_entity', 'entities', 'UPDATE', `NEW.name = '${POISONED_ENTITY_NAME}'`);

    expect(() => {
      store.putEntity(makeEntity({ name: POISONED_ENTITY_NAME }));
    }).toThrow();

    expect(store.getEntity(ENTITY_ID)).toStrictEqual(makeEntity());
  });

  it('leaves the claims anchored at that node untouched', () => {
    failWhen('fail_entity', 'entities', 'UPDATE', `NEW.name = '${POISONED_ENTITY_NAME}'`);

    expect(() => {
      store.putEntity(makeEntity({ name: POISONED_ENTITY_NAME }));
    }).toThrow();

    expect(store.getClaim(CLAIM_ID)).toStrictEqual(makeClaim());
  });
});
