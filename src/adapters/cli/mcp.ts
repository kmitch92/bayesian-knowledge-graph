/**
 * `kgmem mcp` — §10's stdio server, with one query tool.
 *
 * The MCP server is a long-lived process per client session. It reads JSON-RPC
 * calls from stdin, answers them to stdout, and holds a workspace-bound store
 * through the session. Each tool call answers with a NOT_IMPLEMENTED error,
 * which these implementations will replace once §7.1 and §7.3's retrieval work
 * is wired.
 *
 * ── The order the steps are in is the design ────────────────────────────────
 *
 * Workspace, then configuration, then the models, then the store. Each step is
 * cheaper than the one after it and can refuse on its own, so a missing
 * workspace costs no ONNX load and an uninitialised directory costs no file
 * read.
 *
 * ── Why stdin end is watched ────────────────────────────────────────────────
 *
 * The MCP SDK's StdioServerTransport reads from stdin until the read stream
 * errors or returns EOF, but does not close itself on EOF — it only listens for
 * 'data' and 'error', not 'end' or 'close'. The server must therefore watch
 * stdin itself and resolve when the client hangs up or closes the connection,
 * triggering an EOF. The process would otherwise hang waiting for a transport
 * that will never signal closure, and the client would wait for a server that
 * will never exit.
 *
 * @spec §7.1, §7.3, §7.6, §10
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { QueryRequest } from '../../schema/index.js';
import type { GraphStore } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { openModels, readConfiguration } from './config.js';
import { refuse } from './report.js';
import { openWorkspaceStore, requireWorkspace } from './workspace.js';

/**
 * Runs the MCP stdio server for the connected session.
 *
 * Connects, awaits client disconnect, closes, and returns Ok. Any throw before
 * the server connects is refused and produces a Config or Usage exit code.
 *
 * @spec §7.6, §10
 */
export const runMcp = async (cwd: string, version: string): Promise<ExitCode> => {
  let store: GraphStore | undefined;
  try {
    const workspace = requireWorkspace(cwd);
    const configuration = readConfiguration(workspace);
    await openModels(configuration, workspace); // Retrieval will take the embeddings from here
    store = openWorkspaceStore(workspace);

    const server = new McpServer({ name: 'kgmem', version });

    server.registerTool(
      'query',
      {
        title: 'Query',
        description: "Returns claims about the task's anchor scope and its ancestors, with confidence and status.",
        inputSchema: QueryRequest.shape,
      },
      async ({ modes }) => {
        const modesArray = modes ?? ['spine', 'ann'];

        if (modesArray.includes('traverse')) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'NOT_IMPLEMENTED: query mode traverse (spec §7.3) is gated and not built.',
              },
            ],
          };
        }

        return {
          isError: true,
          content: [{ type: 'text', text: 'NOT_IMPLEMENTED: query retrieval is not built yet.' }],
        };
      },
    );

    const transport = new StdioServerTransport();

    await server.connect(transport);

    // Wait for stdin to end or close. The SDK's StdioServerTransport does not
    // close itself on EOF, so we must watch stdin and trigger shutdown when the
    // client goes away.
    await new Promise<void>((resolve) => {
      process.stdin.on('end', () => resolve());
      process.stdin.on('close', () => resolve());
    });

    await server.close();

    return ExitCode.Ok;
  } catch (error) {
    return refuse(error);
  } finally {
    store?.close();
  }
};
