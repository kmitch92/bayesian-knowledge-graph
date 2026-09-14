/**
 * End-to-end test for the `kgmem mcp`'s `query` tool.
 *
 * The tool reads the same store the CLI writes, answers in both text and
 * structured form, and records taint per server session (one host session =
 * one episode).
 *
 * @spec §7.1, §7.5, §10
 */

import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { FAKE_ADJUDICATOR_MODULE, FAKE_EMBEDDINGS_MODULE, repo, withStore } from './cli-fixtures.js';
import { connectMcp, type McpSession } from './mcp-fixtures.js';
import { CLAIM_ID, ENTITY_ID, makeClaim, makeEntity } from '../../../store/__tests__/fixtures.js';
import { QueryResponse } from '../../../schema/index.js';

describe('querying a seeded workspace over kgmem mcp', () => {
  let r: ReturnType<typeof repo>;
  let session: McpSession | undefined;
  let firstResult: unknown;
  let secondResult: unknown;

  beforeAll(async () => {
    r = repo();
    r.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });

    withStore(r.dbPath, (store) => {
      store.putEntity(makeEntity());
      store.putMention({
        surfaceForm: 'AuthService',
        referentId: ENTITY_ID,
        weight: 1,
      });
      store.putClaim(
        makeClaim({
          id: CLAIM_ID,
          status: 'active',
          evidence: { alpha: 8, beta: 2 },
        }),
      );
      store.putClaimEdge({
        from: CLAIM_ID,
        kind: 'ABOUT',
        to: ENTITY_ID,
      });
    });

    session = await connectMcp(r.root);

    const callQuery = async () =>
      session!.client.callTool({
        name: 'query',
        arguments: {
          task: 'how does AuthService refresh tokens',
        },
      });

    firstResult = await callQuery();
    secondResult = await callQuery();
  }, 180_000);

  afterAll(async () => {
    if (session) {
      await session.close();
    }
    r.close();
  });

  it('first query result has no error and parses as QueryResponse with anchor and claims', () => {
    const result = firstResult as { isError?: boolean; structuredContent?: unknown };
    expect(result.isError).not.toBe(true);

    const structuredContent = result.structuredContent;
    expect(structuredContent).toBeDefined();

    const parsed = QueryResponse.parse(structuredContent);

    expect(parsed.anchor).toStrictEqual({
      id: ENTITY_ID,
      name: 'AuthService',
      level: 'component',
    });

    expect(parsed.claims.map((c) => c.id)).toStrictEqual([CLAIM_ID]);
    expect(parsed.claims[0]!.status).toBe('active');
    expect(parsed.claims[0]!.posteriorMean).toBeCloseTo(0.8, 4);
  });

  it('first query result text content matches structured content when parsed', () => {
    const result = firstResult as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
    const contentArray = result.content ?? [];
    const text = contentArray
      .filter((item: { type?: string; text?: string }) => item.type === 'text')
      .map((item: { type?: string; text?: string }) => item.text ?? '')
      .join('');

    const parsedText = JSON.parse(text);
    expect(parsedText).toStrictEqual(result.structuredContent);
  });

  it('taint is recorded exactly once per session for the served claim', () => {
    expect(firstResult).toBeDefined();
    expect(secondResult).toBeDefined();

    const db = new Database(r.dbPath, { readonly: true, fileMustExist: true });
    const taintRows = db
      .prepare('SELECT episode_id, claim_id FROM taint')
      .all() as Array<{ episode_id: string; claim_id: string }>;
    db.close();

    expect(taintRows).toHaveLength(1);

    const taintRow = taintRows[0]!;
    expect(taintRow.claim_id).toBe(CLAIM_ID);
    expect(taintRow.episode_id).toMatch(/^mcp:/);
  });
});
