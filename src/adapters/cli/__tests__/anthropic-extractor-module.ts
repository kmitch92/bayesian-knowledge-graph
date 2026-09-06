/**
 * §5.10's port, as `.kgmem/config.json` names it — and this time the **real**
 * adapter, with only the socket faked.
 *
 * `fake-extractor-module.ts` is this file's precedent and its opposite number:
 * it hands the CLI a scripted {@link Extractor}, so everything E5 measures runs
 * against an answer the test wrote. E7b measured the other half — the real
 * adapter's parse, request shape and refusals — but against an injected `fetch`
 * inside one process, never through `loadPort`, never through the drain, and
 * never against the verbatim gate. The parse and the gate have never met.
 *
 * So this module is the real {@link AnthropicExtractor}, constructed the way
 * `openModels` constructs one, with a `fetch` that answers instead of dialling.
 * Everything between the request body and `refusalFor` is production code.
 *
 * ── Deterministic, not scripted ─────────────────────────────────────────────
 *
 * `loadPort` calls this factory with no arguments, from a dynamic `import()` of
 * a file URL, inside a child process the test only sees the exit code of. A
 * test holding a handle on a scripted fake is not holding the instance the CLI
 * loaded — and could not reach it across the process boundary if it were.
 *
 * The way past that is to need no coordination at all: the fake `fetch` reads
 * the chunk **out of the request body it was handed** and answers with a quote
 * cut from that chunk. The quote is verbatim by construction rather than by
 * agreement, which is also the composition under test — an adapter that
 * mangled the chunk on the way out would produce a "quote" the gate cannot find
 * in the chunk it holds, and the claim would land in `extraction_rejections`
 * instead of the graph.
 *
 * ── The key, and the socket ─────────────────────────────────────────────────
 *
 * {@link AnthropicExtractor} reads `ANTHROPIC_API_KEY` at construction, and
 * `runCli` hands the child this process's environment minus `KGMEM*` — so a
 * developer with a real key exported would have the child inherit it. The
 * factory therefore sets an obvious dummy **over** whatever arrived: a run of
 * this suite must not be able to authenticate against anything, whoever is
 * running it.
 *
 * The platform's own `fetch` is replaced for the life of the child for the same
 * reason `anthropic-extractor.test.ts` installs `refuseTheNetwork`: the adapter
 * falls back on `globalThis.fetch` when it is handed none, and a fixture that
 * merely happens not to take that branch today is one edit from spending money.
 * Nothing restores either, because the child exits.
 *
 * Deliberately *not* named `*.test.ts`, so vitest's `include` globs never
 * collect it.
 *
 * @spec §5.10, §7.6, §9, §11, §12, §13
 */

import { AnthropicExtractor } from '../../../extract/adapters/anthropic-extractor';
import type { ExtractedClaim, Extractor } from '../../../extract/index';

/**
 * The key the child runs under.
 *
 * Spelled so that a key found in a log, a core dump or a stray `env` is
 * unmistakably this fixture's and not somebody's.
 */
export const DUMMY_API_KEY = 'sk-ant-DUMMY-KEY-e7c-offline-fixture-do-not-use';

/** How `userMessage` frames the chunk. Read rather than assumed — see {@link chunkIn}. */
const CHUNK_OPEN = '<chunk>';

/** @see CHUNK_OPEN */
const CHUNK_CLOSE = '</chunk>';

/**
 * What the fake API could work out about one request.
 *
 * Three facts and no more, each read off the wire rather than written down
 * here: the paragraph under extraction, the tool the request forced, and the
 * model it asked for. `anthropic-extractor.test.ts` echoes the same three for
 * the same reason — a fixture that spells the tool name itself goes on
 * answering after a rename that would have broken production.
 *
 * @spec §5.10, §11
 */
export interface SeenRequest {
  /** The chunk, recovered from the turn the adapter sent. @spec §3.6, §5.10 */
  readonly chunk: string;
  /** The tool the request forced, echoed back so the answer is one it asked for. @spec §5.10 */
  readonly tool: string;
  /** The model the request named, echoed back so the fixture never lies about it. @spec §13 */
  readonly model: unknown;
}

/** What a scenario answers one request with. */
export type Responder = (seen: SeenRequest) => Response;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The user turn's text, or a failure naming what arrived instead. */
const userTurnOf = (body: unknown): string => {
  const messages = isRecord(body) ? body.messages : undefined;
  const first = Array.isArray(messages) ? (messages as readonly unknown[])[0] : undefined;
  const content = isRecord(first) ? first.content : undefined;
  if (typeof content !== 'string')
    throw new Error(
      `the E7c fixture found no user turn in the request the adapter sent: ${JSON.stringify(body)}`,
    );
  return content;
};

/**
 * The chunk, out of the turn that carried it.
 *
 * `.trim()` is what makes this exact rather than approximate: `chunkText`
 * trims every paragraph it cuts, so a chunk never begins or ends in
 * whitespace, and trimming whatever sits between the markers recovers it byte
 * for byte however the adapter chooses to frame it. A missing marker throws
 * rather than guessing — the throw reaches §9 as a `last_error`, where an
 * assertion about a graph nobody wrote would leave a reader guessing at the
 * cause.
 *
 * @spec §3.6, §5.10
 */
const chunkIn = (content: string): string => {
  const open = content.indexOf(CHUNK_OPEN);
  const close = content.lastIndexOf(CHUNK_CLOSE);
  if (open < 0 || close < open)
    throw new Error(
      `the E7c fixture found no ${CHUNK_OPEN}…${CHUNK_CLOSE} chunk in the turn the adapter sent: ${content}`,
    );
  return content.slice(open + CHUNK_OPEN.length, close).trim();
};

/** The tool the request forced, or the only one it offered. */
const forcedToolIn = (body: unknown): string => {
  const choice = isRecord(body) ? body.tool_choice : undefined;
  const forced = isRecord(choice) ? choice.name : undefined;
  if (typeof forced === 'string') return forced;
  const tools = isRecord(body) ? body.tools : undefined;
  const first = Array.isArray(tools) ? (tools as readonly unknown[])[0] : undefined;
  const named = isRecord(first) ? first.name : undefined;
  if (typeof named === 'string') return named;
  throw new Error(
    `the E7c fixture found no tool in the request the adapter sent: ${JSON.stringify(body)}`,
  );
};

/** How a forced tool call ordinarily ends. */
const STOPPED_ON_TOOL_USE: Readonly<Record<string, unknown>> = { stop_reason: 'tool_use' };

/** The API's own report that the answer was cut off at the output budget. @spec §9, §15 */
export const AT_THE_BUDGET: Readonly<Record<string, unknown>> = { stop_reason: 'max_tokens' };

/**
 * A Messages API answer carrying one tool call.
 *
 * `stopped` is spread early rather than last so that `stop_reason` sits well
 * inside the first thousand characters of the rendered payload: the adapter
 * bounds what a refusal quotes, and a signal quoted only in the half that got
 * cut is a signal a test cannot tell from one the adapter invented.
 *
 * @spec §5.10, §12
 */
export const toolCallAnswer = (
  seen: SeenRequest,
  claims: readonly ExtractedClaim[],
  stopped: Readonly<Record<string, unknown>> = STOPPED_ON_TOOL_USE,
): Response =>
  new Response(
    JSON.stringify({
      id: 'msg_01E7cOfflineFixture',
      type: 'message',
      role: 'assistant',
      ...stopped,
      model: seen.model,
      content: [
        { type: 'tool_use', id: 'toolu_01E7cOfflineFixture', name: seen.tool, input: { claims } },
      ],
      stop_sequence: null,
      usage: { input_tokens: 512, output_tokens: 96 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * The span this fixture cites: everything after the chunk's first line break.
 *
 * Awkward on purpose, and structurally rather than by a constant the corpus
 * would have to keep in step with. On the corpus these modules are driven over
 * it begins in an indent, carries a curly apostrophe, holds trailing spaces
 * before an interior newline, and runs across that newline — every character
 * class a helpful normalizer eats, and the gate is `chunkText.includes(quote)`
 * with no trim, no fold and no straightening. A chunk with no line break in it
 * yields the whole chunk, which is still verbatim; the suite asserts the
 * awkwardness it relies on rather than assuming it.
 *
 * @spec §5.10, §12
 */
export const awkwardQuoteOf = (chunk: string): string => chunk.slice(chunk.indexOf('\n') + 1);

/** A chunk's first line, which is what makes each member's text distinct. */
export const openingOf = (chunk: string): string => {
  const firstBreak = chunk.indexOf('\n');
  return (firstBreak < 0 ? chunk : chunk.slice(0, firstBreak)).trim();
};

/** The tail every member proposed here carries. @spec §5.10 */
export const MEMBER_MARK = 'recorded in the fitter’s own hand';

/**
 * One member per chunk, its text a function of the chunk's own opening line.
 *
 * Distinct across chunks, because stage 0 keys on `(episode, text)` and §5.10
 * makes a whole document one episode: a repeated text would arrive as a replay,
 * move no posterior, and make "both chunks were mined" indistinguishable from
 * "one was mined twice".
 *
 * @spec §4.2, §5.1, §5.10
 */
export const memberTextFor = (chunk: string): string =>
  `${openingOf(chunk)} That entry is ${MEMBER_MARK}.`;

/**
 * The noun every member here names.
 *
 * Undeclared in the fake provider's semantic space, so it sits in its own
 * private plane: the first chunk mints a provisional referent and the second
 * resolves onto it at rung 0 by exact name, with no tiebreak in between.
 *
 * @spec §5.2
 */
export const MENTIONED = 'the winter overhaul ledger';

/** What a model that copied its span exactly proposes for one chunk. @spec §5.10 */
export const verbatimClaimFor = (chunk: string): ExtractedClaim => ({
  text: memberTextFor(chunk),
  quote: awkwardQuoteOf(chunk),
  kind: 'fact',
  tier: 'observed',
  mentions: [MENTIONED],
});

/** A `fetch` that would rather fail than reach api.anthropic.com. */
const refuseTheNetwork = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
  throw new Error(
    `an E7c fixture reached the network instead of answering from the request: ${String(args[0] as unknown)}`,
  );
};

/**
 * The real adapter, wired to a fake API that answers from what it was asked.
 *
 * @spec §7.6, §11
 */
export const realExtractorAnswering = (respond: Responder): Extractor => {
  // Over whatever the child inherited, not beside it: no run of this suite may
  // hold a key that could authenticate.
  process.env.ANTHROPIC_API_KEY = DUMMY_API_KEY;
  globalThis.fetch = refuseTheNetwork;

  const call: typeof globalThis.fetch = async (input, init) => {
    const raw =
      input instanceof Request
        ? await input.text()
        : typeof init?.body === 'string'
          ? init.body
          : '';
    const body: unknown = raw.length === 0 ? undefined : JSON.parse(raw);
    return respond({
      chunk: chunkIn(userTurnOf(body)),
      tool: forcedToolIn(body),
      model: isRecord(body) ? body.model : undefined,
    });
  };

  return new AnthropicExtractor({ fetch: call });
};

/** @spec §5.10, §7.6 */
export default (): Extractor =>
  realExtractorAnswering((seen) => toolCallAnswer(seen, [verbatimClaimFor(seen.chunk)]));
