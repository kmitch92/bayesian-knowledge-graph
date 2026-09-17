/**
 * Protocol-level tests for the `kgmem mcp` server.
 *
 * @spec §10
 */

import { describe, beforeAll, afterAll, it, expect } from 'vitest';

import { FAKE_ADJUDICATOR_MODULE, FAKE_EMBEDDINGS_MODULE, repo } from './cli-fixtures.js';
import { connectMcp, type McpSession } from './mcp-fixtures.js';

describe('the tools kgmem mcp serves', () => {
  let r: ReturnType<typeof repo>;
  let session: McpSession | undefined;

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

  it('tool names are exactly [\'query\', \'observe\']', async () => {
    const result = await session!.client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);
    expect(toolNames).toStrictEqual(['query', 'observe']);
  });

  it('query tool inputSchema has the expected properties and required field', async () => {
    const result = await session!.client.listTools();
    const queryTool = result.tools.find((tool) => tool.name === 'query');
    expect(queryTool).toBeDefined();

    const properties = queryTool!.inputSchema.properties ?? {};
    const propertyNames = Object.keys(properties).sort();
    expect(propertyNames).toStrictEqual(['anchor', 'budgetTokens', 'hint', 'modes', 'task']);

    expect(queryTool!.inputSchema.required).toContain('task');
  });

  it('observe tool inputSchema has the expected properties and required fields', async () => {
    const result = await session!.client.listTools();
    const observeTool = result.tools.find((tool) => tool.name === 'observe');
    expect(observeTool).toBeDefined();

    const properties = observeTool!.inputSchema.properties ?? {};
    const propertyNames = Object.keys(properties).sort();
    expect(propertyNames).toStrictEqual(['about', 'claim', 'provenance', 'tier']);

    const required = observeTool!.inputSchema.required ?? [];
    expect(required).toContain('claim');
    expect(required).toContain('tier');
    expect(required).toContain('about');
  });

  it('query tool with Mode C (traverse) returns an error with NOT_IMPLEMENTED', async () => {
    const result = await session!.client.callTool({
      name: 'query',
      arguments: {
        task: 'how does the drain retry',
        modes: ['traverse'],
      },
    });

    expect(result.isError).toBe(true);

    const content = result.content as Array<{ type?: string; text?: string }>;
    const text = content
      .filter((item: { type?: string; text?: string }) => item.type === 'text')
      .map((item: { type?: string; text?: string }) => item.text ?? '')
      .join('');

    expect(text).toContain('NOT_IMPLEMENTED');
    expect(text).toContain('traverse');
  });
});
