/**
 * `kgmem mcp` — §10's stdio server, with query and observe tools.
 *
 * The MCP server is a long-lived process per client session. It reads JSON-RPC
 * calls from stdin, answers them to stdout, and holds a workspace-bound store
 * through the session. The server mints one episode id per process lifecycle and
 * records taint rows under it for all served claims.
 *
 * ── The order the steps are in is the design ────────────────────────────────
 *
 * Workspace, then configuration, then the embedding model, the adjudicator,
 * then the store. Each step is cheaper than the one after it and can refuse on
 * its own, so a missing workspace costs no ONNX load and a bad configuration
 * opens no store. The server builds only the ports its tools use, so a
 * workspace configured for extraction serves without extraction credentials.
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

import { ObserveRequest, ObserveResponse, QueryRequest, QueryResponse } from '../../schema/index.js';
import { runQuery } from '../../retrieval/query.js';
import { openIngest } from '../../ingest/index.js';
import type { EmbeddingProvider } from '../../store/ports/embedding-provider.js';
import type { GraphStore } from '../../store/index.js';

import { ExitCode } from './commands.js';
import { openAdjudicator, openEmbeddings, readConfiguration } from './config.js';
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
  embeddings: EmbeddingProvider,
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
 * Registers the observe tool on the server.
 *
 * Every call writes one claim through the ingest port, the same door the CLI
 * uses. The claim lands `provisional` and the resolution ladder mints referents
 * it cannot find, so the caller gets back both what it wrote (the claim and its
 * status) and where the nouns went (the rungs they resolved at). Stage 0's
 * dedupe check suppresses evidence corroboration on replays of the same text
 * in the same episode; a replay still lands as a row and is returned, but
 * `duplicate: true` tells the agent not to expect a posterior change.
 *
 * A caller-supplied `provenance.episodes` is deliberately ignored — an agent
 * must not write under another episode's name.
 *
 * @spec §5.2, §7.1, §7.5, §10
 */
const registerObserveTool = (
  server: McpServer,
  store: GraphStore,
  ingest: ReturnType<typeof openIngest>,
  episodeId: string,
): void => {
  server.registerTool(
    'observe',
    {
      title: 'Observe',
      description:
        'Records a claim the agent believes, naming at least one subject in '
        + 'the about field; the claim lands provisional and is served back by query.',
      inputSchema: ObserveRequest.shape,
      outputSchema: ObserveResponse.shape,
    },
    async (args) => {
      try {
        const request = ObserveRequest.parse(args);
        const receipt = await ingest.submit({
          type: 'claim',
          text: request.claim,
          mentions: request.about,
          tier: request.tier,
          kind: 'fact',
          origin: {
            episodeId,
            channel: 'mcp-observe',
            ...(request.provenance.agent ? { agent: request.provenance.agent } : {}),
          },
        });

        const status = receipt.claimId === undefined ? 'provisional' : store.getClaim(receipt.claimId)?.status ?? 'provisional';
        const response: ObserveResponse = {
          ...(receipt.claimId === undefined ? {} : { claimId: receipt.claimId }),
          duplicate: receipt.duplicate,
          status,
          referents: receipt.resolutions.map((resolution) => ({
            surfaceForm: resolution.surfaceForm,
            referentId: resolution.referentId,
            rung: resolution.rung,
          })),
        };

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
    const embeddings = await openEmbeddings(configuration, workspace);
    const adjudicator = await openAdjudicator(configuration, workspace);
    store = openWorkspaceStore(workspace);

    const ingest = openIngest({ store, embeddings, adjudicator });

    const episodeId = mintEpisodeId();
    const server = new McpServer({ name: 'kgmem', version });

    registerQueryTool(server, store, embeddings, episodeId);
    registerObserveTool(server, store, ingest, episodeId);

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
