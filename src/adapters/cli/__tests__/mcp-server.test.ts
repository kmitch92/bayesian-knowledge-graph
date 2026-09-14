/**
 * `kgmem mcp`, the stdio MCP server — spec §10.
 *
 * The server is a long-lived process that reads JSON-RPC messages from stdin and
 * writes responses to stdout. It reads end of input when its client goes away and
 * closes its store gracefully, returning Ok (0). A run in a non-workspace refuses
 * with Config (3). The server is a stub today: it exits NotImplemented (2) on stderr,
 * which these tests assert against to ensure the implementation later changes the
 * behaviour.
 *
 * @spec §7.6, §10
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../commands';

import {
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  bareWorkspace,
  repo,
  runCli,
  type CliRun,
} from './cli-fixtures';

describe('mcp server', () => {
  describe('serving from a directory that is not a workspace', () => {
    let run: CliRun;
    let workspace: ReturnType<typeof bareWorkspace>;

    beforeAll(async () => {
      workspace = bareWorkspace();
      run = await runCli(['mcp'], workspace.root);
    }, 180_000);

    afterAll(() => {
      workspace.close();
    });

    it('refuses with Config exit code', () => {
      expect({
        code: run.code,
        stdout: run.stdout,
        unimplemented: run.stderr.includes('NOT_IMPLEMENTED'),
      }).toStrictEqual({
        code: ExitCode.Config,
        stdout: '',
        unimplemented: false,
      });
    });
  });

  describe('serving when the client has already gone', () => {
    let run: CliRun;
    let workspace: ReturnType<typeof repo>;

    beforeAll(async () => {
      workspace = repo();
      workspace.configure({
        embeddings: FAKE_EMBEDDINGS_MODULE,
        adjudicator: FAKE_ADJUDICATOR_MODULE,
      });
      run = await runCli(['mcp'], workspace.root);
    }, 180_000);

    afterAll(() => {
      workspace.close();
    });

    it('closes its store and returns when the client goes away', () => {
      // The server reads end of input immediately from stdin and closes gracefully,
      // rather than hanging or ending on an unsettled top-level await.
      expect({
        code: run.code,
        stdout: run.stdout,
      }).toStrictEqual({
        code: ExitCode.Ok,
        stdout: '',
      });
    });
  });
});
