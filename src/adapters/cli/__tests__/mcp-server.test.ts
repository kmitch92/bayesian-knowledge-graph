/**
 * `kgmem mcp`, the stdio MCP server.
 *
 * A directory with no workspace refuses with Config (3) and nothing on stdout.
 * A server whose client has gone (stdin at end) closes its store and exits 0
 * with nothing on stdout.
 *
 * @spec §7.6, §10
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { ExitCode } from '../commands';

import {
  FAKE_ADJUDICATOR_MODULE,
  FAKE_EMBEDDINGS_MODULE,
  bareWorkspace,
  repo,
  runCli,
  type CliRun,
} from './cli-fixtures';

/** Reference to the throwing extractor module, built the same way as FAKE_EXTRACTOR_MODULE. */
const THROWING_EXTRACTOR_MODULE = fileURLToPath(
  new URL('./throwing-extractor-module.ts', import.meta.url),
);

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

  describe('serving from a workspace whose extractor cannot be built', () => {
    let run: CliRun;
    let workspace: ReturnType<typeof repo>;

    beforeAll(async () => {
      workspace = repo();
      workspace.configure({
        embeddings: FAKE_EMBEDDINGS_MODULE,
        adjudicator: FAKE_ADJUDICATOR_MODULE,
        extractor: THROWING_EXTRACTOR_MODULE,
      });
      run = await runCli(['mcp'], workspace.root);
    }, 180_000);

    afterAll(() => {
      workspace.close();
    });

    it('starts and exits 0 with nothing on stdout', () => {
      // query and observe never extract, so the server builds only the ports its tools use; an extractor whose construction fails must not stop it.
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
