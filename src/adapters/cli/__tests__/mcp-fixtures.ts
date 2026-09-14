/**
 * Protocol-level client fixture for testing the `kgmem mcp` server.
 *
 * stdout belongs to JSON-RPC, so tests speak the protocol through the SDK
 * client rather than reading streams.
 *
 * @spec §7.6, §10
 */

import { Readable } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CLI_PATH, TSX_LOADER, hermeticEnv } from './cli-fixtures.js';

/** A connected MCP client session with its stderr buffer. */
export interface McpSession {
  /** The connected MCP client. */
  readonly client: Client;
  /** Accumulated stderr output from the child process. */
  stderr(): string;
  /** Close the client and transport. */
  close(): Promise<void>;
}

/**
 * Connect to the MCP server spawned as a child process.
 *
 * @param cwd The working directory for the child process.
 * @returns A promise resolving to the connected session.
 * @throws An Error including collected stderr if connection fails.
 */
export const connectMcp = async (cwd: string): Promise<McpSession> => {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX_LOADER, CLI_PATH, 'mcp'],
    cwd,
    env: Object.fromEntries(
      Object.entries(hermeticEnv()).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>,
    stderr: 'pipe',
  });

  let stderrText = '';

  // Attach stderr listener to capture output
  if (transport.stderr && transport.stderr instanceof Readable) {
    transport.stderr.setEncoding('utf8');
    transport.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
    });
  }

  // Race the connection against a timeout to detect early process exit
  const connectionPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timeout after 30s. stderr: ${stderrText}`));
    }, 30_000);
    // Clean up timer if connection succeeds
    connectionPromise.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
  });

  try {
    await Promise.race([connectionPromise, timeoutPromise]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect to MCP server: ${message}\nstderr: ${stderrText}`);
  }

  return {
    client,
    stderr: () => stderrText,
    close: async () => {
      await client.close();
    },
  };
};
