/**
 * End-to-end test for the `kgmem mcp`'s `observe` tool.
 *
 * The observe tool writes a claim into the workspace graph under the server
 * session's episode, using the same ingest door the CLI uses. A new claim lands
 * `provisional` and an unknown name mints a referent at rung `minted`. The tool
 * serves both read and write paths: the same session can query what it just wrote.
 *
 * @spec §1, §5.2, §5.10, §10
 */

import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { FAKE_ADJUDICATOR_MODULE, FAKE_EMBEDDINGS_MODULE, repo } from './cli-fixtures.js';
import { connectMcp, type McpSession } from './mcp-fixtures.js';

describe('writing a claim through kgmem mcp\'s observe tool', () => {
  let r: ReturnType<typeof repo>;
  let session: McpSession | undefined;
  let claimId: string;
  let referentId: string;
  let firstClaimAlpha: number;
  let firstClaimBeta: number;
  let duplicateClaimId: string;

  beforeAll(async () => {
    r = repo();
    r.configure({
      embeddings: FAKE_EMBEDDINGS_MODULE,
      adjudicator: FAKE_ADJUDICATOR_MODULE,
    });

    session = await connectMcp(r.root);
  }, 180_000);

  afterAll(async () => {
    if (session) {
      await session.close();
    }
    r.close();
  });

  it('writing a claim succeeds and returns provisional status with minted referent', async () => {
    const result = await session!.client.callTool({
      name: 'observe',
      arguments: {
        claim: 'The retry budget is five attempts.',
        tier: 'observed',
        about: ['RetryPolicy'],
        provenance: {},
      },
    });

    expect(result.isError).not.toBe(true);

    const structuredContent = result.structuredContent;
    expect(structuredContent).toBeDefined();

    const response = structuredContent as Record<string, unknown>;
    expect(response.duplicate).toBe(false);
    expect(response.status).toBe('provisional');

    // claimId should be a 26-character ULID-shaped string
    const returnedClaimId = response.claimId;
    expect(typeof returnedClaimId).toBe('string');
    expect(returnedClaimId).toMatch(/^[0-9A-Z]{26}$/);
    claimId = returnedClaimId as string;

    // referents should have one entry with the shape we expect
    const referents = response.referents as Array<Record<string, unknown>>;
    expect(Array.isArray(referents)).toBe(true);
    expect(referents).toHaveLength(1);

    const referent = referents[0]!;
    expect(referent.surfaceForm).toBe('RetryPolicy');
    expect(typeof referent.referentId).toBe('string');
    expect(referent.rung).toBe('minted');
    referentId = referent.referentId as string;

    // Capture the first claim's evidence for later verification
    const db = new Database(r.dbPath, { readonly: true, fileMustExist: true });
    try {
      const claimsRows = db
        .prepare('SELECT alpha, beta FROM claims WHERE id = ?')
        .all(claimId) as Array<{ alpha: number | null; beta: number | null }>;
      expect(claimsRows).toHaveLength(1);
      const evidence = claimsRows[0]!;
      expect(typeof evidence.alpha).toBe('number');
      expect(typeof evidence.beta).toBe('number');
      firstClaimAlpha = evidence.alpha as number;
      firstClaimBeta = evidence.beta as number;
    } finally {
      db.close();
    }
  });

  it('the claim reached the store with correct status and edges', () => {
    const db = new Database(r.dbPath, { readonly: true, fileMustExist: true });
    try {
      // Check claims row
      const claimsRows = db
        .prepare('SELECT id, status, text FROM claims WHERE id = ?')
        .all(claimId) as Array<{ id: string; status: string; text: string }>;

      expect(claimsRows).toHaveLength(1);
      const claimsRow = claimsRows[0]!;
      expect(claimsRow.status).toBe('provisional');
      expect(claimsRow.text).toBe('The retry budget is five attempts.');

      // Check claim_edges row
      const edgesRows = db
        .prepare('SELECT from_id, kind, to_id FROM claim_edges WHERE from_id = ? AND kind = ?')
        .all(claimId, 'ABOUT') as Array<{ from_id: string; kind: string; to_id: string }>;

      expect(edgesRows).toHaveLength(1);
      const edgesRow = edgesRows[0]!;
      expect(edgesRow.from_id).toBe(claimId);
      expect(edgesRow.to_id).toBe(referentId);
    } finally {
      db.close();
    }
  });

  it('duplicate claim creates a new row but suppresses facet attachment and evidence corroboration', async () => {
    const result = await session!.client.callTool({
      name: 'observe',
      arguments: {
        claim: 'The retry budget is five attempts.',
        tier: 'observed',
        about: ['RetryPolicy'],
        provenance: {},
      },
    });

    expect(result.isError).not.toBe(true);

    const structuredContent = result.structuredContent;
    const response = structuredContent as Record<string, unknown>;

    // Verify duplicate flag is true
    expect(response.duplicate).toBe(true);

    // claimId should be a 26-character ULID different from the first claim
    const returnedClaimId = response.claimId;
    expect(typeof returnedClaimId).toBe('string');
    expect(returnedClaimId).toMatch(/^[0-9A-Z]{26}$/);
    duplicateClaimId = returnedClaimId as string;
    expect(duplicateClaimId).not.toBe(claimId);

    // Verify exactly two claims rows with this text (not one, but two)
    const db = new Database(r.dbPath, { readonly: true, fileMustExist: true });
    try {
      const claimsRows = db
        .prepare('SELECT id, alpha, beta FROM claims WHERE text = ? ORDER BY id')
        .all('The retry budget is five attempts.') as Array<{ id: string; alpha: number | null; beta: number | null }>;

      expect(claimsRows).toHaveLength(2);

      // First claim's evidence must be unchanged
      const firstRow = claimsRows.find((r) => r.id === claimId);
      expect(firstRow).toBeDefined();
      expect(firstRow!.alpha).toBe(firstClaimAlpha);
      expect(firstRow!.beta).toBe(firstClaimBeta);
    } finally {
      db.close();
    }
  });

  it('a call with no about field is refused and writes nothing', async () => {
    let result: unknown;
    try {
      result = await session!.client.callTool({
        name: 'observe',
        arguments: {
          claim: 'Something unattributed.',
          tier: 'observed',
          provenance: {},
        },
      });
    } catch (error) {
      // The SDK may reject the promise
      result = error;
    }

    // Assert the call was refused
    const refused = result instanceof Error || (result as { isError?: boolean }).isError === true;
    expect(refused).toBe(true);

    // Verify no claims row with this text
    const db = new Database(r.dbPath, { readonly: true, fileMustExist: true });
    try {
      const claimsRows = db
        .prepare('SELECT id FROM claims WHERE text = ?')
        .all('Something unattributed.') as Array<{ id: string }>;

      expect(claimsRows).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('the written claim is served back through query in the same session', async () => {
    const result = await session!.client.callTool({
      name: 'query',
      arguments: {
        task: 'what is the RetryPolicy retry budget',
      },
    });

    expect(result.isError).not.toBe(true);

    const structuredContent = result.structuredContent as Record<string, unknown>;
    const claimIds = (structuredContent.claims as Array<Record<string, unknown>>)
      .map((claim) => claim.id as string);

    expect(claimIds).toContain(claimId);
  });
});
