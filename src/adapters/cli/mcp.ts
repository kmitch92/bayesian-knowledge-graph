/**
 * `kgmem mcp` — §10's stdio server, with one query tool.
 *
 * The MCP server is a long-lived process per client session. It reads JSON-RPC
 * calls from stdin, answers them to stdout, and holds a workspace-bound store
 * through the session. The server mints one episode id per process lifecycle and
 * records taint rows under it for all served claims.
 *
 * ── The order the steps are in is the design ────────────────────────────────
 *
 * Workspace, then configuration, then the models, then the store. Each step is
 * cheaper than the one after it and can refuse on its own, so a missing
 * workspace costs no ONNX load and a bad configuration opens no store.
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

import { QueryRequest, QueryResponse } from '../../schema/index.js';
import { runQuery } from '../../retrieval/query.js';
import type { GraphStore } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { openModels, readConfiguration, type Models } from './config.js';
import { refuse, report } from './report.js';
import { openWorkspaceStore, requireWorkspace } from './workspace.js';

/**
 * Mints an episode id for the server session.
 *
 * One host session is one episode (v1 specification §4.3, §7.5); the stdio
 * server process is the session, so one episode id per process lifetime.
 *
 * @spec §4.3, §7.5
 */
const mintEpisodeId = (): string => `mcp:${new Date().toISOString()}`;

/**
 * Registers the query tool on the server.
 *
 * Every call reads the one store the process holds and records what it served
 * under the process's episode. Mode C (`traverse`) is refused until it ships.
 *
 * @spec §7.1, §7.3, §7.5, §10
 */
const registerQueryTool = (
  server: McpServer,
  store: GraphStore,
  embeddings: Models['embeddings'],
  episodeId: string,
): void => {
  server.registerTool(
    'query',
    {
      title: 'Query',
      description:
        'Returns claims about the task\'s anchor scope and its containing '
        + 'scopes, or the nearest claims by meaning when no anchor resolves; '
        + 'each claim carries status (provisional claims are unconfirmed) and '
        + 'posterior mean/width; contradicting claims are returned together.',
      inputSchema: QueryRequest.shape,
      outputSchema: QueryResponse.shape,
    },
    async (args) => {
      try {
        if (args.modes?.includes('traverse')) {
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

        const request = QueryRequest.parse(args);
        const response = await runQuery(
          { store, embeddings, episodeId },
          request,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        report(message);
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  );
};

/**
 * Runs the MCP stdio server for the connected session.
 *
 * Connects, awaits client disconnect, closes, and returns Ok. Any throw before
 * the server connects is refused with the exit code refuse() assigns (Config,
 * Usage, or Failed).
 *
 * @spec §7.6, §10
 */
export const runMcp = async (cwd: string, version: string): Promise<ExitCode> => {
  let store: GraphStore | undefined;
  try {
    const workspace = requireWorkspace(cwd);
    const configuration = readConfiguration(workspace);
    const models = await openModels(configuration, workspace);
    store = openWorkspaceStore(workspace);

    const episodeId = mintEpisodeId();
    const server = new McpServer({ name: 'kgmem', version });

    registerQueryTool(server, store, models.embeddings, episodeId);

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
