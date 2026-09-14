/**
 * Resolving the entity a query is anchored at.
 *
 * The orchestrator's design for §7.1 step 1: choosing an entity from either an
 * explicit anchor or the task text itself via exact → alias → gloss-embedding
 * ANN, anchoring at the most specific.
 *
 * @spec §7.1, §7.2
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAnchor } from '../anchor';
import { openGraphStore, type GraphStore } from '../../store/index';
import {
  ENTITY_ID,
  OTHER_ENTITY_ID,
  makeEntity,
  makeMinimalEntity,
  testUlid,
} from '../../store/__tests__/fixtures';
import {
  fakeEmbeddings,
  type FakeEmbeddings,
  declaredVector,
  queriedTexts,
} from '../../referents/__tests__/fixtures';

/** A third referent, for the deeper-wins case. @spec §7.1 */
const THIRD_ENTITY_ID = testUlid('ENTITY-RETRYBVDGET');

/** What one untainted, uncapped naming is worth. @spec §4.2, §15 */
const ONE_NAMING = 1;

let store: GraphStore;
let embeddings: FakeEmbeddings;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
  embeddings = fakeEmbeddings();
});

afterEach(() => {
  store.close();
});

describe('resolveAnchor', () => {
  describe('case 1: anchor given and it is an entity id', () => {
    it('returns that entity with rung id', async () => {
      store.putEntity(makeEntity());

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'why does auth retry', anchor: ENTITY_ID },
      );

      expect(result).toStrictEqual({
        id: ENTITY_ID,
        name: 'AuthService',
        level: 'component',
        rung: 'id',
      });
    });
  });

  describe('case 2: anchor given, not an id, but names index knows it as a surface form', () => {
    it('returns the referent with rung mention', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'auth-service', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'why does it retry', anchor: 'auth-service' },
      );

      expect(result).toStrictEqual({
        id: ENTITY_ID,
        name: 'AuthService',
        level: 'component',
        rung: 'mention',
      });
    });
  });

  describe('case 3: anchor given but resolves to nothing', () => {
    it('falls through to resolving from task, not undefined', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'something about AuthService', anchor: 'notfound' },
      );

      expect(result).toStrictEqual({
        id: ENTITY_ID,
        name: 'AuthService',
        level: 'component',
        rung: 'mention',
      });
    });
  });

  describe('case 4: from task: split, trim, drop empty; runs of 1–3 words looked up in names index', () => {
    it('finds a single-word surface form from task text', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'RetryPolicy', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'why does (RetryPolicy), back off' },
      );

      expect(result?.rung).toBe('mention');
      expect(result?.id).toBe(ENTITY_ID);
      expect(queriedTexts(embeddings)).toStrictEqual([]);
    });

    it('trims non-alphanumeric from ends of words', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'RetryPolicy', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'consider (RetryPolicy)! what happens?' },
      );

      expect(result?.id).toBe(ENTITY_ID);
      expect(result?.rung).toBe('mention');
    });

    it('drops empty words after trimming', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'Service', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'the Service !!!   and more' },
      );

      expect(result?.id).toBe(ENTITY_ID);
      expect(result?.rung).toBe('mention');
    });

    it('does not make an embedding call when a name matches', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'AuthService', referentId: ENTITY_ID, weight: ONE_NAMING });

      await resolveAnchor(
        { store, embeddings },
        { task: 'how does AuthService handle refresh' },
      );

      expect(queriedTexts(embeddings)).toStrictEqual([]);
    });
  });

  describe('case 5: longer run wins', () => {
    it('prefers 2-word surface form over 1-word when both match', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID, name: 'drain' }));
      store.putEntity(makeMinimalEntity({ id: OTHER_ENTITY_ID, name: 'job drain' }));

      store.putMention({ surfaceForm: 'drain', referentId: ENTITY_ID, weight: ONE_NAMING });
      store.putMention({ surfaceForm: 'job drain', referentId: OTHER_ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'how does the job drain retry' },
      );

      expect(result?.id).toBe(OTHER_ENTITY_ID);
    });

    it('prefers 3-word run over 2-word', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID }));
      store.putEntity(makeMinimalEntity({ id: OTHER_ENTITY_ID }));
      store.putEntity(makeMinimalEntity({ id: THIRD_ENTITY_ID }));

      store.putMention({ surfaceForm: 'job', referentId: ENTITY_ID, weight: ONE_NAMING });
      store.putMention({ surfaceForm: 'job drain', referentId: OTHER_ENTITY_ID, weight: ONE_NAMING });
      store.putMention({
        surfaceForm: 'job drain system',
        referentId: THIRD_ENTITY_ID,
        weight: ONE_NAMING,
      });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'how does the job drain system work' },
      );

      expect(result?.id).toBe(THIRD_ENTITY_ID);
    });
  });

  describe('case 6: deeper wins at the same run length', () => {
    it('chooses the deeper entity when one surface form names two at different depths (deeper mention recorded first)', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID, name: 'root' }));
      store.putEntity(makeMinimalEntity({ id: OTHER_ENTITY_ID, name: 'auth' }));
      store.putEntity(makeMinimalEntity({ id: THIRD_ENTITY_ID, name: 'auth' }));

      store.putMention({ surfaceForm: 'auth', referentId: THIRD_ENTITY_ID, weight: ONE_NAMING });
      store.putMention({ surfaceForm: 'auth', referentId: OTHER_ENTITY_ID, weight: ONE_NAMING });

      store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
      store.putContainment({ parent: OTHER_ENTITY_ID, child: THIRD_ENTITY_ID });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'where is auth configured' },
      );

      expect(result?.id).toBe(THIRD_ENTITY_ID);
    });

    it('chooses the deeper entity when one surface form names two at different depths (deeper mention recorded second)', async () => {
      store.putEntity(makeEntity({ id: ENTITY_ID, name: 'root' }));
      store.putEntity(makeMinimalEntity({ id: OTHER_ENTITY_ID, name: 'auth' }));
      store.putEntity(makeMinimalEntity({ id: THIRD_ENTITY_ID, name: 'auth' }));

      store.putMention({ surfaceForm: 'auth', referentId: OTHER_ENTITY_ID, weight: ONE_NAMING });
      store.putMention({ surfaceForm: 'auth', referentId: THIRD_ENTITY_ID, weight: ONE_NAMING });

      store.putContainment({ parent: ENTITY_ID, child: OTHER_ENTITY_ID });
      store.putContainment({ parent: OTHER_ENTITY_ID, child: THIRD_ENTITY_ID });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'where is auth configured' },
      );

      expect(result?.id).toBe(THIRD_ENTITY_ID);
    });
  });

  describe('case 7: no name matches → embed task and search gloss index', () => {
    it('embeds task once as query and finds gloss hit at cosine ≥ 0.70', async () => {
      store.putEntity(
        makeEntity({
          id: ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('AuthService')),
        }),
      );

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'the auth thing' },
      );

      expect(result?.id).toBe(ENTITY_ID);
      expect(result?.rung).toBe('gloss');
      expect(queriedTexts(embeddings)).toStrictEqual(['the auth thing']);
    });

    it('at same depth, higher cosine wins among gloss hits', async () => {
      store.putEntity(
        makeEntity({
          id: ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('AuthService')),
        }),
      );
      store.putEntity(
        makeMinimalEntity({
          id: OTHER_ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('auth-service')),
        }),
      );

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'the auth thing' },
      );

      expect(result?.id).toBe(OTHER_ENTITY_ID);
    });

    it('deeper wins over higher cosine among gloss hits', async () => {
      store.putEntity(
        makeEntity({
          id: ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('AuthService')),
        }),
      );
      store.putEntity(
        makeMinimalEntity({
          id: OTHER_ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('auth-service')),
        }),
      );

      store.putContainment({ parent: OTHER_ENTITY_ID, child: ENTITY_ID });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'the auth thing' },
      );

      expect(result?.id).toBe(ENTITY_ID);
    });
  });

  describe('case 8: gloss hit below 0.70 does not anchor', () => {
    it('returns undefined when cosine is below floor', async () => {
      store.putEntity(
        makeEntity({
          id: ENTITY_ID,
          glossEmbedding: Array.from(declaredVector('LedgerEntry')),
        }),
      );

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'the ledger' },
      );

      expect(result).toBeUndefined();
    });
  });

  describe('case 9: nothing resolves at all', () => {
    it('returns undefined when no anchor and no name or gloss matches', async () => {
      store.putEntity(makeEntity());

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'something completely unrelated' },
      );

      expect(result).toBeUndefined();
    });

    it('returns undefined when anchor is not given and task has no matches', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'Service', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'totally unrelated query with no matches' },
      );

      expect(result).toBeUndefined();
    });
  });

  describe('ResolvedAnchor shape', () => {
    it('returns name and level as store.getEntity reports them', async () => {
      store.putEntity(
        makeEntity({ id: ENTITY_ID, name: 'CustomName', level: 'module' }),
      );

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'anything', anchor: ENTITY_ID },
      );

      expect(result?.name).toBe('CustomName');
      expect(result?.level).toBe('module');
    });

    it('includes level as null when entity has no level', async () => {
      store.putEntity(makeMinimalEntity({ id: OTHER_ENTITY_ID }));

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'anything', anchor: OTHER_ENTITY_ID },
      );

      expect(result?.level).toBeNull();
    });

    it('always includes id, name, level, and rung', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'auth', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'auth matters', anchor: undefined },
      );

      expect(result).toStrictEqual({
        id: ENTITY_ID,
        name: 'AuthService',
        level: 'component',
        rung: 'mention',
      });
    });
  });

  describe('edge cases', () => {
    it('handles undefined anchor parameter', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'Service', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'about Service behavior' },
      );

      expect(result?.id).toBe(ENTITY_ID);
    });

    it('tries task fallback when anchor is empty string', async () => {
      store.putEntity(makeEntity());
      store.putMention({ surfaceForm: 'Service', referentId: ENTITY_ID, weight: ONE_NAMING });

      const result = await resolveAnchor(
        { store, embeddings },
        { task: 'about Service', anchor: '' },
      );

      expect(result?.id).toBe(ENTITY_ID);
    });
  });
});
