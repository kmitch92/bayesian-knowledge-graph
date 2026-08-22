/**
 * §5.1 stage-0 idempotency dedupe.
 *
 * "`hash(normalized_text) + episode_id` at the very front. Agents retry tool
 * calls; without this, every network blip double-counts evidence." The §12
 * registry files this as *double-counted retries*, mitigated day one.
 *
 * The key is a pair, and both halves matter. The same sentence replayed inside
 * one episode is a retry and must be rejected; the same sentence arriving from a
 * *different* episode is a second independent observation and must be admitted —
 * suppressing it would silently destroy the corroboration the whole evidence
 * model runs on.
 *
 * Normalization is Stage 1's job (§5.2), not the store's. The store hashes
 * exactly the text it is handed, so two spellings of the same idea are two
 * observations here and the pipeline is responsible for having collapsed them
 * first.
 *
 * @spec §5.1, §5.2, §12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraphStore, type GraphStore } from '../index';

import { EPISODE_ID, OTHER_EPISODE_ID } from './fixtures';

/** The normalized, deixis-free sentence Stage 1 hands to stage 0. @spec §5.1, §5.2 */
export const NORMALIZED_TEXT =
  'Session refresh handlers in AuthService are idempotent under retry.';

/** A different proposition from the same episode. @spec §5.1 */
export const OTHER_NORMALIZED_TEXT =
  'AuthService.refresh retries twice before surfacing an error.';

let store: GraphStore;

beforeEach(() => {
  store = openGraphStore({ path: ':memory:' });
});

afterEach(() => {
  store.close();
});

describe('stage-0 admission of an observation', () => {
  it('admits an observation the first time its episode sees it', () => {
    expect(store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT })).toBe(
      true,
    );
  });

  it('rejects the replay of an identical observation inside the same episode', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    expect(store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT })).toBe(
      false,
    );
  });

  it('keeps rejecting a retry that fires several times over', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    const replays = [0, 1, 2, 3].map(() =>
      store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT }),
    );

    expect(replays).toStrictEqual([false, false, false, false]);
  });

  it('admits the same text from a different episode, because that is corroboration and not a retry', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    expect(
      store.admitObservation({ episodeId: OTHER_EPISODE_ID, normalizedText: NORMALIZED_TEXT }),
    ).toBe(true);
  });

  it('admits a different text from the same episode', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    expect(
      store.admitObservation({ episodeId: EPISODE_ID, normalizedText: OTHER_NORMALIZED_TEXT }),
    ).toBe(true);
  });

  it('keeps each episode ledger independent, so one episode replaying does not block another', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    expect(
      store.admitObservation({ episodeId: OTHER_EPISODE_ID, normalizedText: NORMALIZED_TEXT }),
    ).toBe(true);
    expect(
      store.admitObservation({ episodeId: OTHER_EPISODE_ID, normalizedText: NORMALIZED_TEXT }),
    ).toBe(false);
  });
});

describe('what stage 0 treats as identical', () => {
  it('hashes the text it is given, so a trailing space is a different observation', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    expect(
      store.admitObservation({ episodeId: EPISODE_ID, normalizedText: `${NORMALIZED_TEXT} ` }),
    ).toBe(true);
  });

  it('hashes the text it is given, so a case difference is a different observation', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });

    expect(
      store.admitObservation({
        episodeId: EPISODE_ID,
        normalizedText: NORMALIZED_TEXT.toUpperCase(),
      }),
    ).toBe(true);
  });

  it('matches on content rather than identity, so an equal string built at runtime still dedupes', () => {
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });
    const rebuilt = NORMALIZED_TEXT.split('').join('');

    expect(store.admitObservation({ episodeId: EPISODE_ID, normalizedText: rebuilt })).toBe(false);
  });

  it('handles a long document-sized assertion, since §5.10 seeds members through the same gate', () => {
    const long = NORMALIZED_TEXT.repeat(400);
    store.admitObservation({ episodeId: EPISODE_ID, normalizedText: long });

    expect(store.admitObservation({ episodeId: EPISODE_ID, normalizedText: long })).toBe(false);
  });
});

describe('the dedupe ledger is durable', () => {
  it('still rejects a replay from a connection opened after the first one closed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kg-mcp-dedupe-'));
    const dbPath = join(directory, 'graph.db');
    try {
      const first = openGraphStore({ path: dbPath });
      first.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT });
      first.close();

      const second = openGraphStore({ path: dbPath });
      try {
        expect(
          second.admitObservation({ episodeId: EPISODE_ID, normalizedText: NORMALIZED_TEXT }),
        ).toBe(false);
      } finally {
        second.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
