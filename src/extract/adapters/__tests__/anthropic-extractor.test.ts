/**
 * §5.10's port, implemented rather than faked for the first time:
 * `claude-haiku-4-5` reading one chunk through the Anthropic Messages API.
 *
 * Every extraction suite up to here scripts an {@link Extractor} —
 * `extraction-fixtures.ts` hands the drain the answer it wants — so the drain,
 * the verbatim gate and §9's retry budget are all covered and *extraction
 * itself* is covered nowhere at all. Quality of extraction is this system's
 * precision ceiling (`fake-extractor-module.ts` says so in as many words), and
 * a ceiling nothing measures is a ceiling nobody knows the height of. This is
 * the first suite with an opinion about what a real model call must translate
 * into.
 *
 * ── No network, ever ────────────────────────────────────────────────────────
 *
 * `fetch` is injected through the constructor's options and driven from
 * hand-built {@link Response}s. Nothing below reaches api.anthropic.com, and
 * the one test that builds the adapter its default way — the factory
 * `loadPort` calls — only inspects its shape and never calls `extract`. A suite
 * that could spend money is a suite CI cannot run.
 *
 * The store, the ingest port and the embedding provider are all absent here on
 * purpose: this adapter's whole surface is `(chunk) → claims`, so
 * `../../__tests__/fixtures`'s `refusalFrom` is restated locally rather than
 * imported. Importing it would drag `better-sqlite3` and `sqlite-vec` onto the
 * import graph of a suite that opens no database.
 *
 * ── Where the "malformed" line falls, and the one rule that draws it ────────
 *
 * **Shape is the adapter's business; substance is the gate's.**
 *
 * A field that is *absent, or present with the wrong type or an out-of-
 * vocabulary value*, is malformed: the adapter throws, and §9 hands the job
 * back for another sampling. A field that is *present and well typed but empty
 * or useless* is passed through untouched, for the verbatim gate and the
 * rejection log to judge.
 *
 * So a claim with no `quote` key throws, and a claim whose quote is `'   '`
 * does not — the second is precisely `refusalFor`'s `quoteAbsent` arm, a
 * *"model broken in a way no threshold fixes"*, and §13 counts it in one query
 * over `extraction_rejections`. Swallowing it here would delete the evidence
 * that the model is broken. The same line puts an empty `mentions` array
 * through and refuses a missing one, and puts an empty `claims` array through
 * as `[]` — a paragraph with nothing worth claiming is the common case, not an
 * error.
 *
 * ── Why every unreadable answer throws instead of returning nothing ─────────
 *
 * `extraction.ts` treats a throw as transient: the job returns to `pending`
 * with the attempt counted, capped at `MAX_ATTEMPTS`. Sampling varies, so a
 * retry can genuinely succeed where the first call produced junk. A returned
 * `[]` would instead call `completeJob` and mark the chunk `done` — mined,
 * silently, of nothing, and never looked at again. The two answers are not
 * near neighbours; one of them loses a paragraph permanently.
 *
 * ── What a refusal has to say ───────────────────────────────────────────────
 *
 * The message becomes a job's `last_error`, which is the only thing an
 * operator will ever read about the failure. So a refusal carries what it saw:
 * an HTTP failure names the status **and** the response body, and an
 * unreadable answer names the offending value. *"Malformed response"* costs a
 * re-run to diagnose and tells nobody which half is broken.
 *
 * ── What GREEN's prompt must carry (§5.10, §5.2 — not this suite's to change) ─
 *
 * The prompt is E7b's real deliverable and this file deliberately does not
 * dictate its prose. It pins only that the prompt is exported for review, that
 * the exported text is the text that actually runs, and that it names every
 * value of both closed vocabularies the model has to answer with — a selection
 * *rule* cannot live in a JSON-schema enum, and a model asked for a `kind` it
 * was never told about will invent one. Recorded here for whoever writes it:
 *
 * | Source of the claim                                   | Tier       |
 * |-------------------------------------------------------|------------|
 * | Reasoning only — the model's or the transcript's       | `inferred` |
 * | Grounded in tool output visible in the chunk           | `observed`, quoted **from the tool result** |
 * | A recorded test execution                              | `verified` |
 *
 * (§5.10: *"Reasoning-only assertions → inferred; claims grounded in tool
 * output visible in the transcript → observed, claim-with-quote against the
 * tool result; recorded test executions → verified-at-T."*)
 *
 * Plus: copy the span character for character — the gate is
 * `chunkText.includes(quote)` and nothing else; and name mentions specific
 * enough to resolve on §5.2's ladder but not so generic (*"it"*, *"the
 * system"*) that referents over-merge.
 *
 * ── The wire shape these tests assume ───────────────────────────────────────
 *
 * One tool, forced; claims read from a `tool_use` block's `input.claims`; each
 * claim carrying `text`, `quote`, `kind`, `tier`, `mentions` under those
 * names. `input` has to be an object because an `input_schema` has to be one,
 * and the claim's field names are {@link ExtractedClaim}'s so that the
 * translation is an identity and there is no second vocabulary to keep in
 * step. The fixtures echo back whichever tool name the request forced, so the
 * adapter is free to call it whatever it likes.
 *
 * @spec §3.2, §3.6, §5.2, §5.10, §6.3, §7.6, §9, §11, §12, §13, §15
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `../../../ingest/messages` and not `../../../ingest`: the door's own schema
// module imports zod and `src/schema/` and nothing else, so the prompt can be
// held against the shape it has to fit through without putting
// `better-sqlite3` on the import graph of a suite that opens no database.
import { TIER_WEIGHT } from '../../../ingest/evidence';
import { ClaimMessage } from '../../../ingest/messages';
import { ClaimKind, ClaimTier } from '../../../schema/index';
import type { ExtractedClaim } from '../../index';

import makeExtractor, {
  ANTHROPIC_MODEL_ID,
  AnthropicExtractor,
  AnthropicExtractorError,
  EXTRACTION_PROMPT,
} from '../anthropic-extractor';

/*
 * ---------------------------------------------------------------------------
 * A fake Anthropic, and the way requests are read back.
 * ---------------------------------------------------------------------------
 */

/** One outgoing call, as the fake API saw it. */
interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  /** Lower-cased, the way `Headers` iterates them. */
  readonly headers: Readonly<Record<string, string>>;
  /** The request body, JSON-parsed, or `undefined` when there was none. */
  readonly body: unknown;
}

/** What the fake API answers one request with. */
type Responder = (request: RecordedRequest) => Response;

/** An injectable `fetch` and the log of what went through it. */
interface FakeApi {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly RecordedRequest[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A `fetch`-shaped function that records and answers, and never opens a socket.
 *
 * Accepts either call style — `(url, init)` or `(Request)` — so the adapter is
 * not forced into one by the harness.
 */
const fakeApi = (respond: Responder): FakeApi => {
  const requests: RecordedRequest[] = [];

  const call: typeof globalThis.fetch = async (input, init) => {
    const fromRequest = input instanceof Request ? input : undefined;
    const url =
      fromRequest !== undefined ? fromRequest.url : input instanceof URL ? input.href : String(input);
    const raw =
      fromRequest !== undefined
        ? await fromRequest.text()
        : typeof init?.body === 'string'
          ? init.body
          : '';
    const recorded: RecordedRequest = {
      url,
      method: fromRequest !== undefined ? fromRequest.method : (init?.method ?? 'GET'),
      headers: Object.fromEntries(
        (fromRequest !== undefined ? fromRequest.headers : new Headers(init?.headers)).entries(),
      ),
      body: raw.length === 0 ? undefined : (JSON.parse(raw) as unknown),
    };
    requests.push(recorded);
    return respond(recorded);
  };

  return { fetch: call, requests };
};

/** The single call the adapter should have made, or a failure that says otherwise. */
const onlyRequest = (api: FakeApi): RecordedRequest => {
  const [request, ...rest] = api.requests;
  if (request === undefined) throw new Error('the adapter reached the API not at all');
  if (rest.length > 0)
    throw new Error(`the adapter reached the API ${String(api.requests.length)} times, not once`);
  return request;
};

/** The request body as an object, or a failure naming what was sent instead. */
const bodyOf = (request: RecordedRequest): Record<string, unknown> => {
  if (!isRecord(request.body))
    throw new Error(`the adapter sent no JSON object body: ${String(request.body)}`);
  return request.body;
};

/**
 * Every string anywhere in a value.
 *
 * How the request-shape tests ask *"did the chunk reach the model"* without
 * pinning where in the body it sits — the prompt's own layout is GREEN's, and
 * a snapshot of the body would freeze it.
 */
const stringsIn = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return (value as readonly unknown[]).flatMap(stringsIn);
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn);
  return [];
};

/** Whether some string in the request carries `text` verbatim. */
const carries = (request: RecordedRequest, text: string): boolean =>
  stringsIn(request.body).some((found) => found.includes(text));

/** The tool the request forced, so the fixture answers with the one that was asked for. */
const forcedTool = (request: RecordedRequest): string => {
  const body = isRecord(request.body) ? request.body : {};
  const choice = isRecord(body.tool_choice) ? body.tool_choice.name : undefined;
  if (typeof choice === 'string') return choice;
  const first = Array.isArray(body.tools) ? (body.tools as readonly unknown[])[0] : undefined;
  const named = isRecord(first) ? first.name : undefined;
  return typeof named === 'string' ? named : 'extract_claims';
};

/** The model the request asked for, echoed back so the fixture never lies about it. */
const modelOf = (request: RecordedRequest): unknown =>
  isRecord(request.body) ? request.body.model : undefined;

/** Whether the prompt travelled in the request's own `system` parameter. */
const systemCarries = (request: RecordedRequest, text: string): boolean =>
  stringsIn(bodyOf(request).system).some((found) => found.includes(text));

/** Every tool name the request offered, in the order it offered them. */
const offeredTools = (request: RecordedRequest): readonly unknown[] =>
  (Array.isArray(bodyOf(request).tools) ? (bodyOf(request).tools as readonly unknown[]) : [])
    .filter(isRecord)
    .map((tool) => tool.name);

/**
 * The blocks the request's `system` parameter carries, whichever form it took.
 *
 * `system` is either a bare string or a list of content blocks, and only the
 * second has anywhere to hang a cache breakpoint — `cache_control` attaches to
 * a *block*, and a string is not one. Read as a list either way, so the tests
 * below can ask which block carries the marker without each of them first
 * having to re-assert the form. The form is pinned once, on its own.
 */
const systemBlocks = (request: RecordedRequest): readonly unknown[] => {
  const system = bodyOf(request).system;
  return Array.isArray(system) ? (system as readonly unknown[]) : [system];
};

/** One `cache_control` marker, and the path through the body it was found at. */
interface CacheMarker {
  /** Dotted path from the body's root, array indices included. */
  readonly at: string;
  /** Whatever the marker carried — the TTL lives in here. */
  readonly control: unknown;
}

/**
 * Every `cache_control` marker anywhere in the request, with where it sits.
 *
 * Walked rather than read off a known key, because *where* the marker goes is
 * the entire question. A breakpoint on the last `system` block caches the tool
 * definitions and the prompt together; one on a tool caches the tools alone;
 * one on the user turn caches the chunk, which is different on every call and
 * so writes a fresh entry per chunk that nothing ever reads back. All three
 * requests are well formed and the API accepts all three. A test that looked
 * only where it expected the marker could not tell them apart, and the failure
 * is silent in every direction — no error, just a bill.
 *
 * Recursion stops at the marker rather than descending into it, so a TTL
 * nested inside is reported as part of `control` and never as a second marker.
 */
const cacheMarkersIn = (value: unknown, at = ''): readonly CacheMarker[] => {
  const under = (name: string): string => (at === '' ? name : `${at}.${name}`);
  if (Array.isArray(value))
    return (value as readonly unknown[]).flatMap((item, index) =>
      cacheMarkersIn(item, `${at}[${String(index)}]`),
    );
  if (isRecord(value))
    return Object.entries(value).flatMap(([name, child]) =>
      name === 'cache_control' ? [{ at: under(name), control: child }] : cacheMarkersIn(child, under(name)),
    );
  return [];
};

const cacheMarkers = (request: RecordedRequest): readonly CacheMarker[] =>
  cacheMarkersIn(bodyOf(request));

/**
 * The bytes a cache hit is decided on: `tools`, then `system`, in that order.
 *
 * Anthropic's documentation fixes both the order and the strictness. Order:
 * *"Cache prefixes are created in the following order: `tools`, `system`, then
 * `messages`."* Strictness: *"Cache hits require 100% identical prompt
 * segments, including all text and images up to and including the block marked
 * with cache control."*
 *
 * So the cached prefix is these two serialised in that order, and it has to
 * come out as the same bytes on every chunk of a document. Anything that
 * varies inside it — a timestamp, a chunk ordinal, a key whose order is not
 * fixed — turns every call into a fresh cache *write* at a premium rather than
 * a read at a discount, which is worse than not marking it at all.
 */
const cachedPrefix = (request: RecordedRequest): string =>
  JSON.stringify([bodyOf(request).tools, bodyOf(request).system]);

/**
 * Whether `text` appears anywhere inside the bytes a cache hit is decided on.
 *
 * Asked of the parsed body, deliberately, and never of {@link cachedPrefix}'s
 * string. `JSON.stringify` escapes as it serialises: a newline inside a value
 * comes out as the two characters `\` and `n`, and the output holds no raw
 * newline anywhere. {@link PUMP_CHUNK} is three sentences joined by newlines,
 * so `cachedPrefix(request).includes(PUMP_CHUNK)` is `false` however
 * completely the chunk has leaked — it is `false` even when the chunk is the
 * *entire* prefix. A leak check written against the serialised form is not a
 * weak test, it is an assertion with no failing case at all, and it reports
 * the all-clear for precisely the mutant it exists to catch.
 *
 * {@link stringsIn} walks the structure instead, so the comparison is made
 * against the same unescaped text the fixture holds.
 */
const prefixCarries = (request: RecordedRequest, text: string): boolean =>
  stringsIn([bodyOf(request).tools, bodyOf(request).system]).some((found) =>
    found.includes(text),
  );

/** The `input_schema` of the tool the request forced — the contract the model is handed. */
const forcedToolSchema = (request: RecordedRequest): Record<string, unknown> => {
  const tools = bodyOf(request).tools;
  const named = (Array.isArray(tools) ? (tools as readonly unknown[]) : []).filter(isRecord);
  const forced = forcedTool(request);
  const tool = named.find((one) => one.name === forced) ?? named[0];
  const schema = tool === undefined ? undefined : tool.input_schema;
  if (!isRecord(schema)) throw new Error('the request offered no tool carrying an input_schema');
  return schema;
};

/**
 * The claim list the tool schema advertises: the name of the array parameter and
 * the per-claim fields inside it, both read off the wire rather than written
 * down here.
 */
const advertisedClaimList = (
  schema: Record<string, unknown>,
): { readonly listName: string; readonly fields: Record<string, unknown> } => {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const list = Object.entries(properties).find(
    ([, value]) => isRecord(value) && value.type === 'array',
  );
  if (list === undefined) throw new Error('the tool schema advertises no list for the claims');

  const [listName, listSchema] = list;
  const items = isRecord(listSchema) && isRecord(listSchema.items) ? listSchema.items : {};
  return { listName, fields: isRecord(items.properties) ? items.properties : {} };
};

/** Whether a field's advertised JSON Schema carries prose the model can read. */
const isDescribed = (field: unknown): boolean =>
  isRecord(field) && typeof field.description === 'string' && field.description.trim().length > 0;

/**
 * A tool call built from the schema the request advertised, field for field.
 *
 * The point of reading the names back off the wire rather than writing them
 * down here: the schema is the *only* thing that tells the model what to call
 * its fields, and the Zod object is the only thing that decides what the
 * adapter will accept. Nothing in the type system ties the two together, so a
 * rename on one side and not the other is a silent 100% extraction failure —
 * every answer well formed by the contract the model was given, every answer
 * refused, every chunk parked at `MAX_ATTEMPTS`. A fixture that spells the
 * field names itself cannot see that; one that obeys the advertised schema can.
 */
const conformingTo = (schema: Record<string, unknown>): Record<string, unknown> => {
  const { listName, fields } = advertisedClaimList(schema);

  const claim = Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      const options = isRecord(field) ? field.enum : undefined;
      if (Array.isArray(options) && options.length > 0) return [name, options[0]];
      if (isRecord(field) && field.type === 'array') return [name, ['the feed pump']];
      return [name, 'The valve seat was lapped rather than replaced'];
    }),
  );

  return { [listName]: [claim] };
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * How the answer stopped, spread over the fixture rather than passed as a value.
 *
 * A record so a test can send `{}` — the field *absent altogether*, which is a
 * third case from `'end_turn'` and from `null`, and the one a guard reading
 * `stop_reason` is likeliest to mistake for something. A plain parameter
 * cannot express it: `undefined` would take the default.
 */
type StopReport = Readonly<Record<string, unknown>>;

/** How a forced tool call ordinarily ends, and what every fixture here said before. */
const STOPPED_ON_TOOL_USE: StopReport = { stop_reason: 'tool_use' };

/**
 * The API's own report that the answer ran out of room.
 *
 * `max_tokens` is set when the response was cut off at the output budget, and
 * Anthropic's guidance is explicit about what follows: *"If Claude's response
 * is cut off because it hit the max_tokens limit, and the truncated response
 * contains an incomplete tool use block, you'll need to retry the request with
 * a higher max_tokens value to get the full tool use."*
 */
const AT_THE_BUDGET: StopReport = { stop_reason: 'max_tokens' };

/** A Messages API answer carrying the content blocks given. */
const messageResponse = (
  request: RecordedRequest,
  content: readonly unknown[],
  stopped: StopReport = STOPPED_ON_TOOL_USE,
): unknown => ({
  id: 'msg_01ExtractorFixture',
  type: 'message',
  role: 'assistant',
  model: modelOf(request),
  content,
  stop_sequence: null,
  usage: { input_tokens: 480, output_tokens: 96 },
  ...stopped,
});

const toolUse = (name: string, input: unknown): unknown => ({
  type: 'tool_use',
  id: 'toolu_01ExtractorFixture',
  name,
  input,
});

/** Answers every call with these claims — well formed or not, as the case needs. */
const answering =
  (claims: readonly unknown[]): Responder =>
  (request) =>
    jsonResponse(messageResponse(request, [toolUse(forcedTool(request), { claims })]));

/**
 * The same, guillotined: these claims are all of the tool call that arrived
 * before the output budget ran out.
 *
 * The model was mid-list when it was cut off, so whatever it had not yet
 * written is not coming, and nothing in the answer says how much that was.
 */
const answeringUntilTheBudgetRanOut =
  (claims: readonly unknown[]): Responder =>
  (request) =>
    jsonResponse(
      messageResponse(request, [toolUse(forcedTool(request), { claims })], AT_THE_BUDGET),
    );

/** The model narrating instead of calling the tool it was given. */
const chatting: Responder = (request) =>
  jsonResponse(
    messageResponse(request, [
      { type: 'text', text: 'I could not find anything worth recording in that paragraph.' },
    ]),
  );

/*
 * ---------------------------------------------------------------------------
 * The chunk, and what a model might say about it.
 * ---------------------------------------------------------------------------
 */

const PUMP_CHUNK = [
  'The feed pump was stripped on the second of March.',
  'The valve seat was lapped rather than replaced, because the spare was three weeks out.',
  'A rig run at 4 bar held the seal for an hour.',
].join('\n');

/** Three proposals over {@link PUMP_CHUNK}: three kinds, all three rungs, in order. */
const PUMP_CLAIMS: readonly ExtractedClaim[] = [
  {
    text: 'The feed pump’s valve seat was lapped rather than replaced.',
    quote: 'The valve seat was lapped rather than replaced',
    kind: 'fact',
    tier: 'observed',
    mentions: ['feed pump', 'valve seat'],
  },
  {
    text: 'The seat was lapped because the spare had a three-week lead time.',
    quote: 'because the spare was three weeks out',
    kind: 'rationale',
    tier: 'inferred',
    mentions: ['valve seat'],
  },
  {
    text: 'The lapped seat holds at 4 bar for an hour.',
    quote: 'A rig run at 4 bar held the seal for an hour.',
    kind: 'fact',
    tier: 'verified',
    mentions: ['feed pump'],
  },
];

/** One well-formed proposal, with whatever this case needs broken about it. */
const proposed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...PUMP_CLAIMS[0]!,
  ...overrides,
});

/** The same proposal with one key gone entirely, which is a different thing from empty. */
/**
 * The same tool input with its list of claims emptied, the field's name still
 * read off the advertised schema rather than spelled out here.
 *
 * The worst ending a guillotine has. `{ claims: [] }` parses, and `[]` is the
 * one answer this adapter is built to read as *the model's verdict that the
 * chunk holds nothing worth claiming* — so a cut that lands here does not
 * merely lose claims, it forges that verdict, and the chunk is marked mined
 * with the forgery recorded as the finding.
 */
const emptied = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(input).map(([name, value]) => [name, Array.isArray(value) ? [] : value]),
  );

const without = (field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(proposed()).filter(([name]) => name !== field));

/**
 * A paragraph carrying every character class a helpful normalizer eats.
 *
 * Trailing spaces before a newline, a leading indent, a curly apostrophe, and
 * a sentence that runs across a line break.
 */
const AWKWARD_CHUNK =
  'The inlet gauge reads 4 bar at idle.  \n' +
  '  The fitter’s note says the seat was lapped, not replaced,\n' +
  'and the ledger agrees.';

/** Indented, curly-apostrophed, and spanning a newline — and a real substring. */
const LEADING_AND_NEWLINE =
  '  The fitter’s note says the seat was lapped, not replaced,\nand the ledger agrees.';

/** Ends in the two spaces the author left before the line break. A real substring. */
const TRAILING_SPACES = 'reads 4 bar at idle.  ';

/**
 * Case-folded away from the paragraph, so *not* a substring.
 *
 * The gate will file it `quoteNotVerbatim`; an adapter that "helpfully"
 * corrected the case would launder a span the document does not contain.
 */
const WRONG_CASE = 'The Inlet Gauge reads';

/** What the drain might tell the model about where the paragraph sits. */
const DRAIN_CONTEXT = 'docs/adr/0007-lapping-policy.md, paragraph 3 of 9';

/**
 * The sentence E7d's live run acted on, 17 calls out of 37.
 *
 * Kept as one exact phrase rather than a family of near-misses, because a
 * negated form of an instruction contains the instruction: a prompt reading
 * *"never give an empty list"* would fail a check for *"give an empty list"*
 * while being exactly right. Nothing negates this one — a prohibition does not
 * call the thing it forbids honest.
 *
 * @spec §5.2, §5.10
 */
const EMPTY_MENTIONS_SANCTION = 'an empty list is honest';

/**
 * The prompt's worked example, located by its shape rather than by its words.
 *
 * A quoted specimen sentence, followed by the mentions the prompt says that
 * sentence yields. Read out of the prompt instead of restated beside it, so a
 * rewording of the example does not fail this test while a *deletion* of it
 * does — and so the nouns checked below are the prompt's own claim about its own
 * specimen, never a copy of them kept here.
 *
 * `[^"]+` cannot cross a quotation mark, so the only run this can capture is the
 * one immediately preceding the prompt's single occurrence of `" mentions "`.
 *
 * @spec §5.2, §5.10
 */
const WORKED_EXAMPLE = /"([^"]+)" mentions ([^—]+)—/;

/**
 * The rung §15 weighs least, read off the weights instead of written down here.
 *
 * §6.3's ladder is a ranking of weights before it is a list of words, so "the
 * rung a producer who says nothing earns" is *the one §15 weighs least*. Read
 * this way, a replay that retunes the weights (§5.8) retunes the test with them,
 * and the assertion below cannot pass by agreeing with a word this file kept a
 * copy of.
 *
 * @spec §4.2, §6.3, §15
 */
const LOWEST_RUNG = (Object.keys(TIER_WEIGHT) as ReadonlyArray<keyof typeof TIER_WEIGHT>).reduce(
  (lowest, rung) => (TIER_WEIGHT[rung] < TIER_WEIGHT[lowest] ? rung : lowest),
);

/** Every sentence of the prompt that says anything about a default. @spec §5.10, §6.3 */
const sentencesAboutTheDefault = (): readonly string[] =>
  EXTRACTION_PROMPT.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('default'));

/** A model this phase did not pin, used only to prove the pin is not welded shut. */
const OTHER_MODEL = 'claude-sonnet-4-5-20250929';

const API_KEY = 'sk-ant-not-a-real-key-0000';

/*
 * ---------------------------------------------------------------------------
 * Refusals, read as values.
 * ---------------------------------------------------------------------------
 */

/**
 * The refusal an act produced, or `undefined` if it did not refuse.
 *
 * Returned rather than matched with a bare `rejects.toThrow()`, for the reason
 * `../../__tests__/fixtures` gives: with the module absent, a bare throw
 * assertion is satisfied by a `TypeError` and the test passes for a reason
 * that has nothing to do with its name.
 */
const refusalFrom = async (act: () => Promise<unknown>): Promise<unknown> => {
  try {
    await act();
    return undefined;
  } catch (error) {
    return error;
  }
};

/**
 * Both halves of what an act did: the refusal it threw, or the value it handed
 * back instead.
 *
 * {@link refusalFrom} drops the returned value, which is the wrong half to
 * lose for a defect whose entire shape is *"it handed back something plausible
 * where it should have refused"*. A bare `{ refused: false }` says the test
 * failed; it does not say that one claim of three was quietly mined and the
 * chunk marked done.
 */
interface Outcome {
  readonly refusal: unknown;
  readonly returned: unknown;
}

const outcomeOf = async (act: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { refusal: undefined, returned: await act() };
  } catch (error) {
    return { refusal: error, returned: undefined };
  }
};

/** The same, for a constructor. */
const refusalOf = (act: () => unknown): unknown => {
  try {
    act();
    return undefined;
  } catch (error) {
    return error;
  }
};

const messageOf = (refusal: unknown): string =>
  refusal instanceof Error ? refusal.message : String(refusal);

/**
 * Whether the refusal names `token` *in its own words*, rather than only
 * inside the answer it quotes.
 *
 * Every refusal here ends by quoting what came back, and the answer a
 * truncation refusal quotes is by definition one carrying
 * `"stop_reason":"max_tokens"`. So a bare `includes('max_tokens')` is already
 * satisfied by the echo, and would go on passing for an adapter whose own
 * prose diagnosed nothing at all — the assertion would read as a promise the
 * test never checks. Removing the JSON rendering leaves the diagnosis, which
 * is the half an operator reads before the payload and the half that has to
 * carry the signal.
 */
const namesInItsOwnWords = (refusal: unknown, token: string): boolean =>
  messageOf(refusal).split(JSON.stringify(token)).join('').includes(token);

/*
 * ---------------------------------------------------------------------------
 * The adapter under test.
 * ---------------------------------------------------------------------------
 */

interface Harness {
  readonly extractor: AnthropicExtractor;
  readonly api: FakeApi;
}

const harnessFor = (respond: Responder, model?: string): Harness => {
  const api = fakeApi(respond);
  const extractor = new AnthropicExtractor(
    model === undefined ? { fetch: api.fetch } : { fetch: api.fetch, model },
  );
  return { extractor, api };
};

let savedKey: string | undefined;

/**
 * The platform's own `fetch`, put back the moment this file is done with it.
 *
 * Held so the guard below can be installed over it without leaking into any
 * other suite sharing this worker.
 */
const platformFetch = globalThis.fetch;

/**
 * A `fetch` that spends money is one keystroke from a `fetch` that does not.
 *
 * Every test here injects its own through the constructor, but "every test"
 * is a claim about the file as it stands, not about the next test added to it.
 * So the guard is installed rather than asserted: an adapter built without a
 * `fetch` falls back on the platform's, and for the length of this file the
 * platform's refuses by name instead of reaching api.anthropic.com. The one
 * test that exercises the fallback deliberately puts its own fake here first.
 */
const refuseTheNetwork = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
  throw new Error(
    `a test reached the network instead of injecting a fetch: ${String(args[0] as unknown)}`,
  );
};

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = API_KEY;
  globalThis.fetch = refuseTheNetwork;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  globalThis.fetch = platformFetch;
});

describe('a well-formed answer from the model', () => {
  it('becomes one ExtractedClaim per proposal, every field mapped, in the order given', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect(claims).toStrictEqual(PUMP_CLAIMS);
  });

  it('takes the whole of §3.2’s kind vocabulary and §6.3’s three rungs', async () => {
    const offered = ClaimKind.options.map((kind, at) =>
      proposed({
        text: `a ${kind} the model read`,
        kind,
        tier: ClaimTier.options[at % ClaimTier.options.length]!,
      }),
    );
    const harness = harnessFor(answering(offered));

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect(claims.map((claim) => `${claim.kind}/${claim.tier}`)).toStrictEqual(
      offered.map((claim) => `${String(claim.kind)}/${String(claim.tier)}`),
    );
  });

  it('reads a narrated tool call, since a model that comments first has still answered', async () => {
    const harness = harnessFor((request) =>
      jsonResponse(
        messageResponse(request, [
          { type: 'text', text: 'Two of these are grounded in the rig run.' },
          toolUse(forcedTool(request), { claims: PUMP_CLAIMS }),
        ]),
      ),
    );

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect(claims).toStrictEqual(PUMP_CLAIMS);
  });

  it('answers with nothing when a paragraph holds nothing worth claiming', async () => {
    const harness = harnessFor(answering([]));

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect(claims).toStrictEqual([]);
  });
});

/**
 * The quote is the one field the adapter must not touch.
 *
 * `refusalFor` is `chunkText.includes(quote)` and nothing else — no trim, no
 * case fold, no whitespace collapse, no typographic-quote straightening — so a
 * single helpful normalization here does not fail loudly, it moves claims into
 * `extraction_rejections` and moves on. §5.10's testimony decay then re-runs
 * the same exact search later and disagrees with whatever this adapter
 * decided.
 *
 * @spec §5.10, §12, §13
 */
describe('the quote, which the gate will test byte for byte', () => {
  it('passes leading space, curly apostrophes and newlines through untouched', async () => {
    const offered = [
      proposed({ text: 'The seat was lapped rather than replaced.', quote: LEADING_AND_NEWLINE }),
      proposed({ text: 'The inlet gauge reads 4 bar at idle.', quote: TRAILING_SPACES }),
      proposed({ text: 'The inlet gauge is the one that was read.', quote: WRONG_CASE }),
    ];
    const harness = harnessFor(answering(offered));

    const claims = await harness.extractor.extract({ chunkText: AWKWARD_CHUNK });

    expect({
      quotes: claims.map((claim) => claim.quote),
      // Exactly the gate's own test, run here so a normalization cannot pass
      // this suite and then quietly change the verdict downstream.
      survivesTheGate: claims.map((claim) => AWKWARD_CHUNK.includes(claim.quote)),
    }).toStrictEqual({
      quotes: [LEADING_AND_NEWLINE, TRAILING_SPACES, WRONG_CASE],
      survivesTheGate: [true, true, false],
    });
  });

  it('hands a blank quote and an empty mentions list on, rather than judging them here', async () => {
    const offered = [
      proposed({ text: 'A claim the model cited nothing for.', quote: '   ' }),
      proposed({ text: 'A claim the model named nobody in.', mentions: [] }),
    ];
    const harness = harnessFor(answering(offered));

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect(claims.map((claim) => ({ quote: claim.quote, mentions: claim.mentions }))).toStrictEqual([
      { quote: '   ', mentions: PUMP_CLAIMS[0]!.mentions },
      { quote: PUMP_CLAIMS[0]!.quote, mentions: [] },
    ]);
  });
});

/**
 * Everything here throws, and throwing is the ruling.
 *
 * `extraction.ts` reads a throw as transient and hands the job back with the
 * attempt counted, bounded by `MAX_ATTEMPTS`; sampling varies, so the next
 * call over the same paragraph may well parse. A returned `[]` would call
 * `completeJob` instead — the chunk marked mined, of nothing, for good.
 *
 * @spec §9, §12, §15
 */
describe('an answer the adapter cannot read', () => {
  const UNREADABLE: ReadonlyArray<[string, Responder]> = [
    ['prose where the forced tool call should be', chatting],
    ['an answer with no content blocks at all', (request) => jsonResponse(messageResponse(request, []))],
    [
      'a tool call whose input is not an object',
      (request) => jsonResponse(messageResponse(request, [toolUse(forcedTool(request), 'fact')])),
    ],
    [
      'a tool call carrying no claims at all',
      (request) =>
        jsonResponse(messageResponse(request, [toolUse(forcedTool(request), { members: [] })])),
    ],
    [
      'claims given as a sentence rather than a list',
      (request) =>
        jsonResponse(messageResponse(request, [toolUse(forcedTool(request), { claims: 'none' })])),
    ],
    ['a claim with no text', answering([without('text')])],
    ['a claim with no quote', answering([without('quote')])],
    ['a claim with no mentions', answering([without('mentions')])],
    ['a claim with no kind', answering([without('kind')])],
    ['a claim with no tier', answering([without('tier')])],
    ['a kind outside §3.2’s six', answering([proposed({ kind: 'guess' })])],
    ['a tier outside §6.3’s three', answering([proposed({ tier: 'probably' })])],
    ['mentions given as a sentence', answering([proposed({ mentions: 'the valve seat' })])],
    ['a quote that is not a string', answering([proposed({ quote: 42 })])],
    ['a body that is not JSON at all', () => new Response('<html>502 from a proxy</html>')],
    ['a 200 with no body on it', () => new Response('')],
  ];

  it.each(UNREADABLE)('refuses %s, so §9 can spend an attempt on another sampling', async (_why, respond) => {
    const harness = harnessFor(respond);

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    expect(refusal instanceof AnthropicExtractorError).toBe(true);
  });

  it('says what it saw, because the message is the job’s last_error', async () => {
    const harness = harnessFor(answering([proposed({ kind: 'guess' })]));

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheOffendingValue: messageOf(refusal).includes('guess'),
    }).toStrictEqual({ named: true, namesTheOffendingValue: true });
  });

  it('quotes the answer even where the validator’s own complaint does not', async () => {
    const harness = harnessFor(answering([proposed({ mentions: 'the valve seat' })]));

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    // Out-of-vocabulary values are the one case a validator tends to echo back
    // ("received 'guess'"), so a refusal can look diagnostic while quoting
    // nothing of its own. A wrongly typed field is the honest test: the
    // complaint here is "expected array, received string" and the string is
    // nowhere in it, so the operator learns what the model actually said only
    // if the adapter puts it there.
    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheOffendingValue: messageOf(refusal).includes('the valve seat'),
    }).toStrictEqual({ named: true, namesTheOffendingValue: true });
  });

  it('refuses a batch one claim spoiled rather than dropping that claim quietly', async () => {
    const harness = harnessFor(answering([PUMP_CLAIMS[0]!, proposed({ tier: 'probably' })]));

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    // The gate logs the proposals it refuses and §13 counts them; nothing logs
    // a proposal this adapter never handed over, so a silent drop is the one
    // outcome with no trace anywhere.
    expect(refusal instanceof AnthropicExtractorError).toBe(true);
  });

  it('tells an empty answer from an unreadable one, since only one is the model’s verdict', async () => {
    const empty = harnessFor(answering([]));
    const unreadable = harnessFor(chatting);

    const claims = await empty.extractor.extract({ chunkText: PUMP_CHUNK });
    const refusal = await refusalFrom(() =>
      unreadable.extractor.extract({ chunkText: PUMP_CHUNK }),
    );

    expect({ claims, refused: refusal instanceof AnthropicExtractorError }).toStrictEqual({
      claims: [],
      refused: true,
    });
  });
});

/**
 * The one unreadable answer that does not look unreadable.
 *
 * Everything in the block above arrives visibly broken, and the adapter's
 * *"throw whole, never claim by claim"* rule is what stops a spoiled sibling
 * taking its well-formed neighbours down quietly. A **guillotined** batch
 * defeats that rule from the other side. The Messages API sets
 * `stop_reason: 'max_tokens'` when the answer was cut off at the output
 * budget, and a list of objects cut off mid-write has two possible endings:
 *
 * 1. The half that arrived does not parse — the last claim lost `mentions`,
 *    say. The adapter throws, §9 spends an attempt, and that is the right
 *    outcome reached by luck, on a message that blames the wrong thing.
 * 2. The half that arrived **parses perfectly** as a shorter `{ claims: [] }`.
 *    Nothing about it is malformed. The adapter hands it over,
 *    `extraction.ts` calls `completeJob`, and the chunk is marked mined — with
 *    every claim past the cut lost for good, no `extraction_rejections` row,
 *    and no trace anywhere. A chunk that gave up one claim of three is
 *    indistinguishable from a chunk that only ever held one.
 *
 * The second is the failure the adapter's own design goes furthest out of its
 * way to prevent, and the only one it cannot currently see: a spoiled batch
 * announces itself and a guillotined batch does not.
 *
 * ── Last block, not any block ───────────────────────────────────────────────
 *
 * The API appends content blocks in order and the budget cuts whichever one
 * was being written, so *the last block* is the documented signal and the only
 * block that can be half-written. A `tool_use` that is **not** last was
 * finished before the budget ran out: the claims in it are all the claims
 * there were, and the thing the budget truncated was the narration after them.
 * That reading is also the one consistent with the adapter reading the *first*
 * `tool_use` it finds — a narrated tool call is still a tool call — because
 * between them the two rules say the same thing: the adapter refuses exactly
 * when the block it would have read is the one that got cut.
 *
 * @spec §5.10, §9, §12, §15
 */
describe('an answer the token budget cut off', () => {
  /** Both endings where the half that arrived is, on its own terms, valid. */
  const PARSING_CLEANLY: ReadonlyArray<
    [string, (input: Record<string, unknown>) => Record<string, unknown>]
  > = [
    ['a shorter list than the model set out to write', (input) => input],
    ['a list emptied altogether, which forges the model’s verdict', emptied],
  ];

  it.each(PARSING_CLEANLY)(
    'refuses a truncated tool call whose surviving half parses cleanly: %s',
    async (_ending, cut) => {
      // Built from the `input_schema` the request advertised, so the batch is
      // well formed by construction and by the adapter's own contract rather
      // than by this fixture's guess at it. There is nothing here to reject on
      // shape; the only thing wrong with this answer is that it is not all of
      // the answer.
      const harness = harnessFor((request) =>
        jsonResponse(
          messageResponse(
            request,
            [toolUse(forcedTool(request), cut(conformingTo(forcedToolSchema(request))))],
            AT_THE_BUDGET,
          ),
        ),
      );

      const outcome = await outcomeOf(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

      expect({
        refused: outcome.refusal instanceof AnthropicExtractorError,
        handedOver: outcome.returned,
      }).toStrictEqual({ refused: true, handedOver: undefined });
    },
  );

  it('refuses a truncated tool call the model narrated its way into', async () => {
    const harness = harnessFor((request) =>
      jsonResponse(
        messageResponse(
          request,
          [
            {
              type: 'text',
              text: 'Three things in this paragraph look claimable. Taking them in turn:',
            },
            toolUse(forcedTool(request), conformingTo(forcedToolSchema(request))),
          ],
          AT_THE_BUDGET,
        ),
      ),
    );

    const outcome = await outcomeOf(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    // The other half of *"a narrated tool call is still a tool call"*. The
    // adapter reads this call, so the budget cutting it loses exactly what
    // cutting an unnarrated one loses — and the preamble makes that likelier,
    // not less: prose spent before the call is budget the call no longer has.
    // A guard that keys on the *lone* block, rather than the last one, reads
    // this answer as safe and hands over the surviving fragment.
    expect({
      refused: outcome.refusal instanceof AnthropicExtractorError,
      handedOver: outcome.returned,
    }).toStrictEqual({ refused: true, handedOver: undefined });
  });

  it('names the budget it asked for, which is the number an operator has to raise', async () => {
    const harness = harnessFor(answeringUntilTheBudgetRanOut([PUMP_CLAIMS[0]!]));

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));
    const budget = bodyOf(onlyRequest(harness.api)).max_tokens;

    // The same standard the HTTP refusals are held to — status *and* body —
    // applied to the two facts this failure turns on: the signal the API sent,
    // and the budget the request had set when it sent it. Read off the wire
    // rather than written down, because `MAX_TOKENS` is deliberately unpinned
    // by this suite and a message quoting a number this test invented would be
    // worse than no number at all.
    //
    // The signal is checked against the refusal's *own words*: this answer's
    // payload carries `"stop_reason":"max_tokens"`, and the refusal quotes the
    // payload, so the plain substring is there whether or not the adapter
    // diagnosed anything.
    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheSignal: namesInItsOwnWords(refusal, 'max_tokens'),
      namesTheBudget: messageOf(refusal).includes(String(budget)),
    }).toStrictEqual({ named: true, namesTheSignal: true, namesTheBudget: true });
  });

  it('blames the budget, not the missing field, when the cut landed mid-claim', async () => {
    const harness = harnessFor(
      answeringUntilTheBudgetRanOut([PUMP_CLAIMS[0]!, without('mentions')]),
    );

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));
    const budget = bodyOf(onlyRequest(harness.api)).max_tokens;

    // Ending 1, and the reason it is only accidentally right. Zod's complaint
    // — *"claims.1.mentions: Required"* — is the symptom; the budget is the
    // cause. An operator handed the symptom goes looking for a prompt bug,
    // because a model omitting a required field is what that message describes
    // and it is not what happened.
    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheBudget: messageOf(refusal).includes(String(budget)),
    }).toStrictEqual({ named: true, namesTheBudget: true });
  });

  it('still reads a max_tokens answer with no tool call as narration, not as truncation', async () => {
    const harness = harnessFor((request) =>
      jsonResponse(
        messageResponse(
          request,
          [{ type: 'text', text: 'Reading the paragraph about the feed pump, the first thing' }],
          AT_THE_BUDGET,
        ),
      ),
    );

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));
    const budget = bodyOf(onlyRequest(harness.api)).max_tokens;

    // Both answers are unreadable and both throw, so the ruling here is about
    // the *message*: a `stop_reason` guard written too broadly would relabel
    // every one of these as a truncation and lose the diagnosis that the model
    // narrated instead of calling the tool at all — which no larger budget
    // fixes. The tool name is read back off the request, never spelled twice.
    //
    // Naming the tool is not on its own enough to tell the two messages apart,
    // because the truncation refusal names the tool too. What separates them
    // is the advice: only one of these is fixed by a bigger number, and
    // sending an operator to raise a budget on an answer that ran out of
    // nothing costs them the whole diagnosis.
    expect({
      named: refusal instanceof AnthropicExtractorError,
      diagnosesTheMissingToolCall: messageOf(refusal).includes(
        forcedTool(onlyRequest(harness.api)),
      ),
      blamesTheBudget: messageOf(refusal).includes(String(budget)),
    }).toStrictEqual({
      named: true,
      diagnosesTheMissingToolCall: true,
      blamesTheBudget: false,
    });
  });

  it('reads a finished tool call whose trailing narration is what the budget cut', async () => {
    const harness = harnessFor((request) =>
      jsonResponse(
        messageResponse(
          request,
          [
            toolUse(forcedTool(request), { claims: PUMP_CLAIMS }),
            { type: 'text', text: 'Two of those rest on the rig run, and the thir' },
          ],
          AT_THE_BUDGET,
        ),
      ),
    );

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    // Blocks arrive in order, so a block with another block after it was
    // finished. The tool call is whole and its claims are all the claims there
    // were; the budget took the commentary. Refusing here would burn an
    // attempt, and five of them, on an answer that was complete.
    expect(claims).toStrictEqual(PUMP_CLAIMS);
  });

  /** Answers where there is no last block to read, or nothing readable in it. */
  const NO_LAST_BLOCK: ReadonlyArray<[string, readonly unknown[]]> = [
    ['no content blocks at all', []],
    ['a null where a content block should be', [null]],
  ];

  it.each(NO_LAST_BLOCK)(
    'refuses a max_tokens answer carrying %s as a missing tool call, not by crashing',
    async (_shape, content) => {
      const harness = harnessFor((request) =>
        jsonResponse(messageResponse(request, content, AT_THE_BUDGET)),
      );

      const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

      // An empty `content` is what the API sends when the budget was spent
      // before a single block was opened — the shape a misconfigured budget
      // reaches first, and the one place the truncation guard runs with
      // nothing to look at. Reading `.type` off that missing last block throws
      // a `TypeError` out of the adapter instead of an
      // `AnthropicExtractorError`, and §9's drain classifies what it is given:
      // a refusal it can record, or a crash it cannot.
      expect({
        named: refusal instanceof AnthropicExtractorError,
        diagnosesTheMissingToolCall: messageOf(refusal).includes(
          forcedTool(onlyRequest(harness.api)),
        ),
      }).toStrictEqual({ named: true, diagnosesTheMissingToolCall: true });
    },
  );
});

/**
 * The mutation this defect's fix is one keystroke from becoming.
 *
 * A guard on `stop_reason` that reads any value but `'max_tokens'` as
 * truncation refuses every successful extraction there is — 100% failure, on a
 * path with no test between it and production. The field is not always sent
 * either: a fixture that omits it, or an answer that carries it as `null`, has
 * to come through as untruncated and not as *"absent, so suspicious"*.
 *
 * @spec §9, §12, §15
 */
describe('every other way an answer can stop', () => {
  const UNTRUNCATED: ReadonlyArray<[string, StopReport]> = [
    ['end_turn, the ordinary finish', { stop_reason: 'end_turn' }],
    ['tool_use, which is what a forced tool answers with', STOPPED_ON_TOOL_USE],
    ['stop_sequence, from a sequence this adapter never sets', { stop_reason: 'stop_sequence' }],
    ['a null stop_reason', { stop_reason: null }],
    ['no stop_reason field at all', {}],
  ];

  it.each(UNTRUNCATED)('hands the claims over on %s', async (_why, stopped) => {
    const harness = harnessFor((request) =>
      jsonResponse(
        messageResponse(request, [toolUse(forcedTool(request), { claims: PUMP_CLAIMS })], stopped),
      ),
    );

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect(claims).toStrictEqual(PUMP_CLAIMS);
  });
});

/**
 * Every HTTP failure throws, and the drain decides what that means.
 *
 * The adapter draws no transient/permanent line of its own: §9 puts the retry
 * policy in the caller's hands, `extraction.ts` is that caller, and a 401 that
 * burned five attempts still parks with an error naming the key. What the
 * adapter owes is a message an operator can act on without re-running
 * anything — the status, and what the API actually said.
 *
 * @spec §9, §12
 */
describe('what the API said went wrong', () => {
  const FAILURES: ReadonlyArray<[number, string, string]> = [
    [
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than 0"}}',
      'max_tokens: must be greater than 0',
    ],
    [
      401,
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'invalid x-api-key',
    ],
    [
      429,
      '{"type":"error","error":{"type":"rate_limit_error","message":"number of requests has exceeded your rate limit"}}',
      'number of requests has exceeded your rate limit',
    ],
    [
      500,
      '{"type":"error","error":{"type":"api_error","message":"internal server error"}}',
      'internal server error',
    ],
    [
      529,
      '{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
      'overloaded',
    ],
  ];

  it.each(FAILURES)('refuses a %i naming both the status and what came back', async (status, body, said) => {
    const harness = harnessFor(
      () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    );

    const refusal = await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheStatus: messageOf(refusal).includes(String(status)),
      namesTheBody: messageOf(refusal).includes(said),
    }).toStrictEqual({ named: true, namesTheStatus: true, namesTheBody: true });
  });

  it('does not retry a 429 itself, because §9 gave the backoff to the drain', async () => {
    const harness = harnessFor(() => new Response('{"type":"error"}', { status: 429 }));

    await refusalFrom(() => harness.extractor.extract({ chunkText: PUMP_CHUNK }));

    expect(harness.api.requests.length).toBe(1);
  });
});

/**
 * A secret belongs in the environment, and a misconfiguration belongs before
 * the work starts.
 *
 * `reflect` builds every port through `openModels` *before* it opens the store
 * or claims a job, so an adapter that refuses at construction costs a
 * misconfigured repository one immediate error and nothing off §9's queue. One
 * that waited until `extract` would claim a job, re-chunk the whole document
 * through `chunksOf`, and only then discover it has no key — five times, on
 * the way to being parked.
 *
 * @spec §7.6, §9, §11
 */
describe('a repository with no ANTHROPIC_API_KEY', () => {
  it('refuses at construction, naming the variable to set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const api = fakeApi(answering(PUMP_CLAIMS));

    const refusal = refusalOf(() => new AnthropicExtractor({ fetch: api.fetch }));

    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheVariable: messageOf(refusal).includes('ANTHROPIC_API_KEY'),
      calls: api.requests.length,
    }).toStrictEqual({ named: true, namesTheVariable: true, calls: 0 });
  });

  it('reads an empty variable as the same misconfiguration a missing one is', () => {
    process.env.ANTHROPIC_API_KEY = '';
    const api = fakeApi(answering(PUMP_CLAIMS));

    const refusal = refusalOf(() => new AnthropicExtractor({ fetch: api.fetch }));

    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheVariable: messageOf(refusal).includes('ANTHROPIC_API_KEY'),
    }).toStrictEqual({ named: true, namesTheVariable: true });
  });

  it('refuses from the factory too, which is the thing openModels calls', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const refusal = await refusalFrom(() => Promise.resolve(makeExtractor()));

    expect({
      named: refusal instanceof AnthropicExtractorError,
      namesTheVariable: messageOf(refusal).includes('ANTHROPIC_API_KEY'),
    }).toStrictEqual({ named: true, namesTheVariable: true });
  });
});

/**
 * §13 groups the rejection log by model. A `modelId` that disagrees with the
 * model in the request body is not a cosmetic mismatch — it is an audit
 * attributing one model's failures to another.
 *
 * @spec §11, §13, §15
 */
describe('the model under audit', () => {
  it('pins v1 to the model this phase measured', () => {
    expect(ANTHROPIC_MODEL_ID).toBe('claude-haiku-4-5-20251001');
  });

  it('reports the model the request actually asked for', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect({
      modelId: harness.extractor.modelId,
      asked: bodyOf(onlyRequest(harness.api)).model,
    }).toStrictEqual({ modelId: ANTHROPIC_MODEL_ID, asked: ANTHROPIC_MODEL_ID });
  });

  it('follows a model given to the constructor into the request and the audit key alike', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS), OTHER_MODEL);

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect({
      modelId: harness.extractor.modelId,
      asked: bodyOf(onlyRequest(harness.api)).model,
    }).toStrictEqual({ modelId: OTHER_MODEL, asked: OTHER_MODEL });
  });
});

/**
 * Only the parts of the request that carry meaning.
 *
 * The prompt's layout, the tool's schema and the token budget are GREEN's and
 * will change; the header the key travels in, the version the API is pinned
 * to, and the fact that the paragraph arrives unmodified will not.
 *
 * @spec §11, §12
 */
describe('what actually reaches the API', () => {
  it('sends the key in x-api-key and never as a bearer token', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const request = onlyRequest(harness.api);

    expect({
      key: request.headers['x-api-key'],
      bearer: request.headers.authorization,
      versioned: (request.headers['anthropic-version'] ?? '').length > 0,
      json: (request.headers['content-type'] ?? '').includes('application/json'),
      method: request.method,
      host: new URL(request.url).host,
      path: new URL(request.url).pathname,
    }).toStrictEqual({
      key: API_KEY,
      bearer: undefined,
      versioned: true,
      json: true,
      method: 'POST',
      host: 'api.anthropic.com',
      path: '/v1/messages',
    });
  });

  it('forces the one tool it offers, so narration and an empty chunk stay apart', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const body = bodyOf(onlyRequest(harness.api));
    const choice = isRecord(body.tool_choice) ? body.tool_choice : {};

    // Unforced, "the model chose to narrate" and "the chunk holds nothing"
    // arrive as the same answer, and those two are a retry apart. Forcing a
    // tool the request never offered is worse than not forcing one: the API
    // refuses the call outright, so every chunk parks without a single claim.
    expect({
      forcesATool: choice.type === 'tool',
      offersTheToolItForces: offeredTools(onlyRequest(harness.api)).includes(choice.name),
      tools: offeredTools(onlyRequest(harness.api)).length,
    }).toStrictEqual({ forcesATool: true, offersTheToolItForces: true, tools: 1 });
  });

  it('reads back exactly the claim its own tool schema told the model to send', async () => {
    const harness = harnessFor((request) =>
      jsonResponse(
        messageResponse(request, [
          toolUse(forcedTool(request), conformingTo(forcedToolSchema(request))),
        ]),
      ),
    );

    const claims = await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    // The schema names the fields for the model; the parser names them for the
    // adapter; nothing checks that those two lists are one list. Renaming a
    // field on either side alone leaves a model answering perfectly to the
    // contract it was given and an adapter refusing every answer it gets.
    expect({
      accepted: claims.length,
      fields: claims.map((claim) => Object.keys(claim).sort()),
    }).toStrictEqual({
      accepted: 1,
      fields: [Object.keys(PUMP_CLAIMS[0]!).sort()],
    });
  });

  /**
   * The schema carries prose for every field, not only the legal values.
   *
   * `jsonSchemaOf` spreads a `description` onto a node only when `.describe()`
   * put one there, so dropping one is a one-token edit that changes nothing the
   * type system can see and nothing the parser reads back — Zod keeps the text as
   * inert metadata. What it changes is the model's side: an enum with no prose
   * beside it is a field answered by vibe from three words, and for `tier` those
   * three words are a privilege ladder.
   *
   * Pinned as presence, never as wording. The sentences are GREEN's and no
   * assertion can check that prose says the right thing; that they reach the model
   * at all is exactly the half a string comparison can carry honestly.
   *
   * @spec §3.2, §5.10, §6.3
   */
  it('describes every field it asks the model to fill in, not just the values it will accept', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const { fields } = advertisedClaimList(forcedToolSchema(onlyRequest(harness.api)));

    expect({
      asksForFields: Object.keys(fields).length > 0,
      undescribed: Object.entries(fields)
        .filter(([, field]) => !isDescribed(field))
        .map(([name]) => name),
    }).toStrictEqual({ asksForFields: true, undescribed: [] });
  });

  it('asks for an output budget, since a truncated tool call is an unreadable answer', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const budget = bodyOf(onlyRequest(harness.api)).max_tokens;

    // `max_tokens` is required by the Messages API, so omitting it is a 400 on
    // every call. The number itself is GREEN's and deliberately unpinned.
    expect({
      asked: typeof budget === 'number',
      positive: typeof budget === 'number' && budget > 0,
    }).toStrictEqual({ asked: true, positive: true });
  });

  it('gives the model the paragraph unmodified, awkward characters and all', async () => {
    const harness = harnessFor(answering([proposed({ quote: LEADING_AND_NEWLINE })]));

    await harness.extractor.extract({ chunkText: AWKWARD_CHUNK });

    // A chunk that arrives folded cannot produce a quote that survives the
    // gate, because the gate tests against the unfolded original.
    expect(carries(onlyRequest(harness.api), AWKWARD_CHUNK)).toBe(true);
  });

  it('includes the drain’s context when there is one', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK, context: DRAIN_CONTEXT });

    expect(carries(onlyRequest(harness.api), DRAIN_CONTEXT)).toBe(true);
  });

  it('sends no placeholder when there is not, rather than the word undefined', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const request = onlyRequest(harness.api);

    expect({
      chunk: carries(request, PUMP_CHUNK),
      leakedPlaceholder: carries(request, 'undefined'),
    }).toStrictEqual({ chunk: true, leakedPlaceholder: false });
  });
});

/**
 * The prompt is E7b's real deliverable and its prose is GREEN's to write, so
 * this suite pins three things and no more: it is exported where a reviewer
 * can read it, the exported text is the text that runs, and it names every
 * value of the two closed vocabularies the model must answer with.
 *
 * The last one is the only content assertion that earns its place. A tool's
 * `input_schema` can enumerate the legal values but cannot carry the *rule*
 * for choosing between them — §5.10's tier table is prose or it is nowhere —
 * and a model asked for a `kind` it was never told the meaning of will pick
 * one by vibe. Asserting the prompt "contains the word verbatim" would be the
 * vacuous version of this test and is deliberately absent.
 *
 * @spec §3.2, §5.10, §6.3
 */
describe('the prompt', () => {
  it('is exported for review, is not empty, and is the text that actually runs', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    expect({
      written: EXTRACTION_PROMPT.trim().length > 0,
      reachesTheModel: carries(onlyRequest(harness.api), EXTRACTION_PROMPT),
    }).toStrictEqual({ written: true, reachesTheModel: true });
  });

  it('travels as the request’s own system parameter, not folded into the turn', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });

    // Deliberately weaker than "system is this string": `system` may be a bare
    // string or a list of blocks, and the block form is what a later phase
    // needs to mark the prompt cacheable across a document's chunks. What is
    // pinned is the parameter it arrives in — a prompt quietly folded into the
    // user turn still reaches the model, still passes the test above, and
    // cannot be cached at all.
    expect({
      inTheSystemParameter: systemCarries(onlyRequest(harness.api), EXTRACTION_PROMPT),
      reachesTheModel: carries(onlyRequest(harness.api), EXTRACTION_PROMPT),
    }).toStrictEqual({ inTheSystemParameter: true, reachesTheModel: true });
  });

  it('names every kind and every rung the model is allowed to answer with', () => {
    const unmentioned = [...ClaimKind.options, ...ClaimTier.options].filter(
      (term) => !EXTRACTION_PROMPT.includes(term),
    );

    expect(unmentioned).toStrictEqual([]);
  });

  /**
   * Each value is *defined* in the prompt, and not merely mentioned somewhere in
   * it.
   *
   * The test above is satisfied by the word appearing anywhere, and every one of
   * these words also appears in the surrounding prose — `inferred` alone occurs a
   * dozen times outside the list. So `kindLines` or `tierLines` could lose an
   * entry and the vocabulary check would go on passing while the model was asked
   * for a value it was never told the meaning of, which is the thing that suite's
   * own docblock says cannot live in a JSON-schema enum. E8c is the standing
   * demonstration of the cost: a taxonomy with a hole in it gets resolved upward,
   * and 35 of 225 live proposals came back one rung too high.
   *
   * Structure, never wording: what is pinned is that each value reaches the model
   * as `- <value>: <something>`, the shape `KIND_GUIDE` and `TIER_GUIDE` render
   * into. Everything after the colon stays GREEN's to write.
   *
   * @spec §3.2, §5.10, §6.3
   */
  it('defines each of them in the list it hands the model, not only in the prose around it', () => {
    const withoutADefinition = [...ClaimKind.options, ...ClaimTier.options].filter(
      (term) => !new RegExp(`^- ${term}: \\S`, 'm').test(EXTRACTION_PROMPT),
    );

    expect(withoutADefinition).toStrictEqual([]);
  });

  /**
   * The one instruction the prompt is not allowed to give, because the door
   * refuses what it asks for.
   *
   * `ClaimMessage.mentions` is `.min(1)` — §5.2 *"forces every claim to name its
   * referents explicitly"*, and the write is the only moment referents are
   * recoverable — while the prompt this adapter shipped said *"if a claim
   * genuinely names no specific entity, give an empty list — an empty list is
   * honest where a placeholder is not"*. E7d's first live run spent 14 paid
   * calls on that contradiction and left four chunks one failure short of
   * parking. The schema is right; the sentence is wrong.
   *
   * The floor is **probed, not restated**: `ClaimMessage` is parsed here, so the
   * day the door's rule changes this test changes with it rather than going on
   * asserting a number copied out of a file it no longer reads. That half is
   * green from the moment it is written, and is the guard that keeps the other
   * half legible.
   *
   * ── What this test is not ───────────────────────────────────────────────────
   *
   * It is necessary and not sufficient, and the limit is worth stating rather
   * than papering over. The replacement wording is GREEN's and no assertion can
   * check that prose says the right thing — §5.2's answer for a claim that names
   * no referent is that it should not be recorded at all, and *that* is pinned
   * where it is observable, in `extraction-drain.test.ts`, as a logged refusal
   * rather than a member. What is pinned here is the narrow thing a string can
   * carry: the sanction itself is gone. The phrase is chosen because it cannot
   * survive inside a correct prompt in any form — a prohibition does not read
   * *"an empty list is honest"* — where a check for *"give an empty list"* would
   * fire on a prompt that said *"never give an empty list"*, and a check for the
   * word *"mentions"* would pass on today's broken prompt, which is the vacuous
   * assertion E7b's VERIFY pass caught the last of.
   *
   * @spec §5.2, §5.10
   */
  it('does not sanction the empty mentions list the one ingest door refuses', () => {
    const atTheDoor = ClaimMessage.safeParse({
      type: 'claim',
      text: 'A claim the model named nobody in.',
      kind: 'fact',
      tier: 'inferred',
      mentions: [],
      origin: { episodeId: 'ep-prompt-contract', channel: 'doc-extraction' },
    });

    expect({
      theDoorTakesIt: atTheDoor.success,
      thePromptAsksForIt: EXTRACTION_PROMPT.includes(EMPTY_MENTIONS_SANCTION),
    }).toStrictEqual({ theDoorTakesIt: false, thePromptAsksForIt: false });
  });

  /**
   * The rule has an escape hatch, and the escape hatch needs the demonstration
   * that precedes it.
   *
   * Deleting the sanction above is only half the fix. What replaced it is a
   * demand — *"every claim carries at least one mention"* — followed by
   * permission to drop a claim that truly names nothing. The demand and the
   * permission alone would turn E7d's 37% of empty-`mentions` claims into 37% of
   * claims *dropped in the model*, which is the same work lost one stage
   * earlier and invisible to §13, because nothing logs a proposal the adapter
   * was never handed. The run's own transcript is the evidence the third
   * paragraph is load-bearing: most of those claims named things the model
   * simply did not list.
   *
   * ── What a string can and cannot carry here ─────────────────────────────────
   *
   * This suite pins the prompt's *content* in one place only, and deliberately:
   * a check that the prompt "contains the word verbatim" is the vacuous version
   * and is absent. So this test does not assert the demonstration is persuasive,
   * which no assertion could. It asserts the demonstration is **consistent with
   * the rule two paragraphs above it** — *"do not invent an identifier the chunk
   * does not use"*. An example whose claimed mentions are not in the sentence it
   * quotes teaches exactly the invention that rule forbids, and it teaches it by
   * worked demonstration, which is the most persuasive form a prompt has.
   *
   * Both halves come off the prompt itself: the specimen and the nouns the
   * prompt says it yields are read out of {@link WORKED_EXAMPLE}, never listed
   * here, so this cannot pass by echoing a copy kept in the test.
   *
   * @spec §5.2, §5.10
   */
  it('demonstrates the mentions rule with an example that invents no mention', () => {
    const shown = WORKED_EXAMPLE.exec(EXTRACTION_PROMPT);
    const specimen = shown?.[1] ?? '';
    const claimed = (shown?.[2] ?? '')
      .split(/,| and /)
      .map((noun) => noun.trim())
      .filter((noun) => noun.length > 0);

    expect({
      demonstrated: shown !== null,
      namesSomething: claimed.length > 0,
      invented: claimed.filter((noun) => !specimen.includes(noun)),
    }).toStrictEqual({ demonstrated: true, namesSomething: true, invented: [] });
  });

  /**
   * The rung the prompt calls the default and the rung the door hands out are one
   * rung, and it is §6.3's bottom one.
   *
   * The prompt says *"Reasoning is inferred, and inferred is the default"*;
   * `ClaimMessage.tier` defaults to `observed`, the middle rung. Both are read
   * here — the prompt's answer out of the prompt, the door's out of a parse — so
   * this cannot pass by echoing a copy of either, and it is three-way rather than
   * two-way on purpose: two artifacts agreeing on `observed` would be a pair of
   * matching mistakes, so the rung they agree on is checked against the one §15
   * weighs least.
   *
   * The extractor is why this pair has to agree at all. Every proposal it hands
   * over becomes a `ClaimMessage`, so the prompt is the instruction and the door
   * is the enforcement of one rule, and E7d is the standing demonstration of what
   * a contradiction between the two costs: a prompt asking for something the door
   * refuses spent 14 paid calls before anyone noticed.
   *
   * ── What this test is not ───────────────────────────────────────────────────
   *
   * It is **not** a test of E8c's first defect, and nothing in this file is. The
   * live run's 35 inflated `observed` proposals came of the model reading
   * *"tool output that is visible in this chunk"* as satisfied by prose that is
   * visible in this chunk, and the fix for that is prose in this prompt whose
   * effect only a live model can produce. The saved transcript holds the *old*
   * prompt's answers; a rewritten prompt has no offline answers at all. So what
   * is pinned here is the one half a string comparison can carry honestly — that
   * the prompt and the door do not contradict each other about the default — and
   * the inflation itself is measured by a live run or not at all.
   *
   * @spec §5.10, §6.3, §15
   */
  it('calls the same rung the default that the one ingest door hands a producer who names none', () => {
    const namedAsDefault = ClaimTier.options.filter((rung) =>
      sentencesAboutTheDefault().some((sentence) => sentence.includes(rung)),
    );
    const atTheDoor = ClaimMessage.parse({
      type: 'claim',
      text: 'A claim whose producer said nothing about how it knows.',
      kind: 'fact',
      mentions: ['the extraction prompt'],
      origin: { episodeId: 'ep-prompt-contract', channel: 'doc-extraction' },
    });

    expect({ namedAsDefault, theDoorSupplies: atTheDoor.tier }).toStrictEqual({
      namedAsDefault: [LOWEST_RUNG],
      theDoorSupplies: LOWEST_RUNG,
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * What the API says it charged for.
 * ---------------------------------------------------------------------------
 */

/**
 * The accounting an answer carries when the cache did engage.
 *
 * Four fields, four different numbers, and none of them reachable from the
 * others by adding or subtracting a pair. That is the point: an adapter that
 * reads `input_tokens` where it meant `cache_read_input_tokens` then reports a
 * number that is *wrong* rather than a number that happens to agree, and the
 * test says so. Identical placeholders would let a field-confusing mutant pass.
 */
const CACHE_ACCOUNTING = {
  input_tokens: 41,
  cache_creation_input_tokens: 2731,
  cache_read_input_tokens: 1289,
  output_tokens: 97,
} as const;

/**
 * The accounting both preserved live runs recorded, on every call of both.
 *
 * `/home/kiel/kgmem-live-e7d/transcript.jsonl` (37 calls) and
 * `/home/kiel/kgmem-live-e8d/transcript.jsonl` (23 calls) report
 * `cache_creation_input_tokens: 0` and `cache_read_input_tokens: 0` on all
 * sixty, with the whole prefix billed at full rate under `input_tokens`. These
 * zeros are the observation this cycle exists to make visible, so a fixture
 * carries them literally rather than describing them.
 */
const NOTHING_CACHED = {
  input_tokens: 2819,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 33,
} as const;

/** The pump claims, answered with the accounting given. */
const answeringWithAccounting =
  (usage: unknown): Responder =>
  (request) =>
    jsonResponse({
      ...(messageResponse(request, [
        toolUse(forcedTool(request), { claims: PUMP_CLAIMS }),
      ]) as Record<string, unknown>),
      usage,
    });

/** The same answer with no `usage` block at all — accounting that never arrived. */
const answeringWithNoAccounting: Responder = (request) =>
  jsonResponse(
    Object.fromEntries(
      Object.entries(
        messageResponse(request, [
          toolUse(forcedTool(request), { claims: PUMP_CLAIMS }),
        ]) as Record<string, unknown>,
      ).filter(([name]) => name !== 'usage'),
    ),
  );

/**
 * Guillotined at the output budget, and carrying the accounting given.
 *
 * The tool call arrived incomplete, so `extract` refuses it — but the call was
 * billed for every one of the output tokens it spent getting cut off.
 */
const truncatedWithAccounting =
  (usage: unknown): Responder =>
  (request) =>
    jsonResponse({
      ...(messageResponse(
        request,
        [toolUse(forcedTool(request), { claims: PUMP_CLAIMS })],
        AT_THE_BUDGET,
      ) as Record<string, unknown>),
      usage,
    });

/**
 * Narrating instead of calling the tool, and carrying the accounting given.
 *
 * The other refusal that was paid for in full: there is no tool call to read,
 * so no claims survive, and the prose was charged for like any other output.
 */
const narratedWithAccounting =
  (usage: unknown): Responder =>
  (request) =>
    jsonResponse({
      ...(messageResponse(request, [
        { type: 'text', text: 'I could not find anything worth recording in that paragraph.' },
      ]) as Record<string, unknown>),
      usage,
    });

/** An adapter built with somewhere to report its accounting to. */
const watchingAccounting = (
  respond: Responder,
): { readonly extractor: AnthropicExtractor; readonly api: FakeApi; readonly seen: unknown[] } => {
  const api = fakeApi(respond);
  const seen: unknown[] = [];
  const extractor = new AnthropicExtractor({
    fetch: api.fetch,
    onUsage: (usage: unknown) => {
      seen.push(usage);
    },
  });
  return { extractor, api, seen };
};

/**
 * The prefix that is identical on every call, and is billed as though it were not.
 *
 * One document of 23 chunks is 23 calls, and `tools` and `system` are the same
 * bytes in all 23 — {@link EXTRACTION_PROMPT} and {@link CLAIM_TOOL} are module
 * constants built once at import. Only the user turn changes. So the repeated
 * prefix is most of the input bill and all of it is avoidable in principle.
 *
 * ── What the API asks for, and where that was established ───────────────────
 *
 * From Anthropic's Messages API prompt-caching documentation, read this cycle
 * rather than recalled:
 *
 * - The marker is `cache_control`, and its one supported shape today is
 *   `{ "type": "ephemeral" }` — *"Currently, `ephemeral` is the only supported
 *   cache type, which by default has a 5-minute lifetime."*
 * - It attaches to a **content block**, so `system` has to become a list of
 *   blocks: a bare string has nowhere to put it.
 * - Prefixes are built in the order `tools`, `system`, `messages`, and a
 *   breakpoint caches *"the entire prompt — tools, system, and messages (in
 *   order) up to and including the block designated with cache_control."*
 * - The answer reports `cache_creation_input_tokens` and
 *   `cache_read_input_tokens` inside `usage`.
 *
 * ── Why the marker goes on the system block and nowhere else ────────────────
 *
 * The tool definitions are as constant as the prompt, and the obvious reading
 * is that they deserve a breakpoint of their own. They do not, and the ordering
 * rule is why: a breakpoint on the last `system` block already covers every
 * tool, because `tools` is built into the prefix ahead of `system`. A second
 * breakpoint on the last tool would spend one of the four the API allows in
 * order to create a *shorter* prefix — the tool schema alone, which this
 * request sends in about 1.3 kB — that is covered byte for byte by the system
 * breakpoint anyway and is far too small to be cacheable on its own. So: one
 * marker, on the last system block, and the tools are cached by preceding it.
 *
 * That makes the marker's *position* the assertion, not its presence. A marker
 * on a tool, or on the user turn, is a well-formed request the API accepts
 * without complaint; a marker on the user turn is actively worse than none,
 * because the chunk differs every call, so every call writes a new entry at the
 * cache-write premium and no call ever reads one back.
 *
 * @spec §11, §15
 */
describe('the stable prefix the model is re-sent on every chunk', () => {
  it('carries the prompt as a content block, since a bare string has nowhere to mark', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const request = onlyRequest(harness.api);

    // The block *count* is deliberately unpinned — one block or several is
    // GREEN's call. What is pinned is that they are blocks at all, that every
    // one is a text block, and that the exported prompt is still the text that
    // runs: `EXTRACTION_PROMPT` is imported from the module under test and
    // looked for in the bytes the adapter built, so a prompt quietly rewritten
    // on its way to the wire fails here.
    expect({
      isBlockList: Array.isArray(bodyOf(request).system),
      blockTypes: [
        ...new Set(systemBlocks(request).map((block) => (isRecord(block) ? block.type : typeof block))),
      ],
      carriesThePrompt: systemCarries(request, EXTRACTION_PROMPT),
    }).toStrictEqual({ isBlockList: true, blockTypes: ['text'], carriesThePrompt: true });
  });

  it('marks it cacheable exactly once, on the last block before the chunk', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    const request = onlyRequest(harness.api);
    const lastBlock = `system[${String(systemBlocks(request).length - 1)}].cache_control`;

    // Every marker in the whole body, not just the one in the expected place:
    // this is what rules out a second breakpoint on the tools, and rules out a
    // marker on `messages` that would cache the chunk instead of the prefix.
    expect({
      controls: cacheMarkers(request).map((marker) => marker.control),
      where: cacheMarkers(request).map((marker) => marker.at),
    }).toStrictEqual({ controls: [{ type: 'ephemeral' }], where: [lastBlock] });
  });

  it('sends the same prefix bytes for two different chunks, because a hit is an exact match', async () => {
    const harness = harnessFor(answering(PUMP_CLAIMS));

    await harness.extractor.extract({ chunkText: PUMP_CHUNK });
    await harness.extractor.extract({ chunkText: AWKWARD_CHUNK, context: DRAIN_CONTEXT });
    const [first, second] = harness.api.requests;
    if (first === undefined || second === undefined)
      throw new Error(`the adapter reached the API ${String(harness.api.requests.length)} times, not twice`);

    // `differentChunks` is a guard rather than a claim about the adapter: it
    // states that the two calls really were driven by different input, so
    // `prefixesMatch` cannot pass by both requests having come from the same
    // chunk. `leakedIntoThePrefix` compares the test's *input* against the
    // adapter's *output* — a chunk or a context folded in ahead of the
    // breakpoint invalidates the entry on every call, and turns the marker
    // from a saving into a surcharge. It goes through `prefixCarries`, which
    // searches the parsed body: the same question asked of `cachedPrefix`'s
    // serialised string cannot fail for `PUMP_CHUNK`, whose newlines
    // `JSON.stringify` escapes out of reach of a substring search.
    expect({
      differentChunks: PUMP_CHUNK !== AWKWARD_CHUNK,
      bothCarriedTheirOwnChunk: [carries(first, PUMP_CHUNK), carries(second, AWKWARD_CHUNK)],
      markedOnce: [cacheMarkers(first).length, cacheMarkers(second).length],
      prefixesMatch: cachedPrefix(first) === cachedPrefix(second),
      leakedIntoThePrefix: [
        prefixCarries(first, PUMP_CHUNK),
        prefixCarries(second, DRAIN_CONTEXT),
      ],
    }).toStrictEqual({
      differentChunks: true,
      bothCarriedTheirOwnChunk: [true, true],
      markedOnce: [1, 1],
      prefixesMatch: true,
      leakedIntoThePrefix: [false, false],
    });
  });
});

/**
 * Whether the cache engaged, where somebody can see it.
 *
 * This is the half that was missing, and the reason the miss survived two paid
 * runs. `extract` returns claims and nothing else; the answer's `usage` block
 * is read by nothing in this adapter and is dropped on the floor with the rest
 * of the parsed body. Both live runs were reconstructed afterwards from a
 * transcript written by an external proxy sitting under `fetch` — tooling that
 * is not in this repository and will not be there next time.
 *
 * The failure this instrument has to catch is silent by design. Anthropic's
 * documentation: *"Any requests to cache fewer than this number of tokens will
 * be processed without caching, and no error is returned. To verify whether a
 * prompt was cached, check the response usage fields: if both
 * `cache_creation_input_tokens` and `cache_read_input_tokens` are 0, the prompt
 * was not cached."* A marked request that is never cached is indistinguishable
 * from a cached one at every level except this block of numbers, so an adapter
 * that discards them cannot answer the only question this cycle asks.
 *
 * Reported through an `onUsage` option on the constructor rather than through
 * `extract`'s return: §5.10's port is `(chunk) → claims` and three
 * implementations satisfy it, so widening the port to carry one vendor's
 * billing fields would put Anthropic's accounting in the scripted extractor's
 * signature. The option is the adapter's own surface and costs the port
 * nothing.
 *
 * @spec §11, §13, §15
 */
describe('the accounting the answer came back with', () => {
  it('hands the caller the cache figures the API reported, field for field', async () => {
    const watched = watchingAccounting(answeringWithAccounting(CACHE_ACCOUNTING));

    const claims = await watched.extractor.extract({ chunkText: PUMP_CHUNK });

    // The four expected numbers are written out rather than read back off
    // `CACHE_ACCOUNTING`, which would be the same object the fixture answered
    // from and would agree with an adapter that echoed its input unread. They
    // are four distinct values, so reading the wrong wire field yields a wrong
    // number here; and the names are this adapter's, so an answer forwarded
    // verbatim under the API's own snake_case keys fails too.
    expect({ claims, seen: watched.seen }).toStrictEqual({
      claims: PUMP_CLAIMS,
      seen: [
        {
          inputTokens: 41,
          cacheCreationInputTokens: 2731,
          cacheReadInputTokens: 1289,
          outputTokens: 97,
        },
      ],
    });
  });

  it('reports the zeros a run gets when nothing was cached, rather than reporting nothing', async () => {
    const watched = watchingAccounting(answeringWithAccounting(NOTHING_CACHED));

    await watched.extractor.extract({ chunkText: PUMP_CHUNK });

    // Exactly what both preserved transcripts recorded on all sixty calls.
    // Zeros alone would also satisfy an adapter that hardcoded them, which is
    // why the test above exists: between the two, the only adapter that passes
    // both is one that reads the numbers off the answer it was given.
    expect(watched.seen).toStrictEqual([
      { inputTokens: 2819, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 33 },
    ]);
  });

  it('still returns the claims when the answer carried no accounting at all', async () => {
    const watched = watchingAccounting(answeringWithNoAccounting);

    const claims = await watched.extractor.extract({ chunkText: PUMP_CHUNK });

    // Silence is not zero. An answer with no `usage` block has not told us the
    // cache missed; it has told us nothing, and reporting zeros would forge the
    // observation this whole describe exists to make honest. Losing a chunk's
    // claims over absent billing telemetry would be the worse trade still: the
    // throw is transient, so §9 spends another paid attempt, and the second
    // answer has the same field missing.
    expect({ claims, seen: watched.seen }).toStrictEqual({ claims: PUMP_CLAIMS, seen: [] });
  });

  /**
   * An answer that reported some of its figures and not others.
   *
   * Every field of {@link AnthropicUsage} is optional, and until now both
   * accounting fixtures filled all four — so the optionality was a type-level
   * claim with no behaviour behind it, and an adapter that defaulted every
   * absent field to `0` passed the whole suite.
   *
   * That default is not a rounding error, it is the exact confusion this cycle
   * exists to end. A run where the cache genuinely missed reports
   * `cache_read_input_tokens: 0`; a response that simply did not mention the
   * field reports nothing. Substituting `0` for the second makes it
   * indistinguishable from the first, so the one number anyone would consult to
   * find out whether the marker ever engaged would read the same either way —
   * and would read as a definite *no* in a case where nothing was measured at
   * all.
   *
   * The rows are the shapes a trimmed answer plausibly takes, each with figures
   * distinct from the others so a field read out of the wrong slot yields a
   * wrong number rather than a coincidentally right one.
   */
  const PARTIAL_ACCOUNTING: readonly (readonly [string, unknown, unknown])[] = [
    ['only the input figure', { input_tokens: 1471 }, [{ inputTokens: 1471 }]],
    [
      'only the two cache figures',
      { cache_creation_input_tokens: 655, cache_read_input_tokens: 3302 },
      [{ cacheCreationInputTokens: 655, cacheReadInputTokens: 3302 }],
    ],
    [
      'everything but the cache read',
      { input_tokens: 812, output_tokens: 57, cache_creation_input_tokens: 2604 },
      [{ inputTokens: 812, outputTokens: 57, cacheCreationInputTokens: 2604 }],
    ],
    ['an empty usage block', {}, []],
    ['a usage block naming nothing this adapter reads', { service_tier: 'standard' }, []],
    ['a usage block that is not an object at all', 'metered', []],
  ];

  it.each(PARTIAL_ACCOUNTING)(
    'reports %s without inventing the figures the answer left out',
    async (_shape, sent, expected) => {
      const watched = watchingAccounting(answeringWithAccounting(sent));

      const claims = await watched.extractor.extract({ chunkText: PUMP_CHUNK });

      // `expected` is written out per row rather than derived from `sent`:
      // the keys are renamed between the two, and the whole claim is about
      // which keys are *absent*, which no transformation of `sent` could
      // assert against itself. The claims come back either way — billing
      // telemetry is never worth a chunk.
      expect({ claims, seen: watched.seen }).toStrictEqual({ claims: PUMP_CLAIMS, seen: expected });
    },
  );

  /**
   * The answers that cost the most and are refused anyway.
   *
   * A truncated answer spent the entire output budget before the guillotine
   * came down, and a narrated one was billed in full for prose the gate throws
   * away. Both are refused by {@link AnthropicExtractor.extract}, and both were
   * paid for. Accounting that only surfaced for answers that parsed would
   * under-report exactly the calls worth seeing, and would under-report them
   * silently — the operator reading the totals would see a cheap run.
   *
   * So the report is made on the strength of the answer having *arrived*, not
   * on its being usable, and these pin the order: the refusal still happens,
   * and the figures still reach the caller before it does.
   */
  // `output_tokens` is the adapter's whole `max_tokens` budget, because that is
  // what being cut off at it means. Written as a literal rather than read off
  // the request: the figure belongs to the answer the fixture is inventing, and
  // sourcing it from the request would make the assertion agree with itself if
  // the adapter ever echoed its own budget back as the cost.
  const BUDGET_SPENT = {
    input_tokens: 2804,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 4096,
  } as const;

  const REFUSED_BUT_BILLED: readonly (readonly [string, Responder])[] = [
    ['guillotined at the output budget', truncatedWithAccounting(BUDGET_SPENT)],
    ['narrating instead of calling the tool', narratedWithAccounting(BUDGET_SPENT)],
  ];

  it.each(REFUSED_BUT_BILLED)(
    'reports what an answer %s cost, though it refuses the answer itself',
    async (_shape, respond) => {
      const watched = watchingAccounting(respond);

      const refusal = await refusalFrom(() =>
        watched.extractor.extract({ chunkText: PUMP_CHUNK }),
      );

      // Both halves, in one assertion, because either alone is satisfied by a
      // defect: `refused` alone passes for an adapter that reports no
      // accounting at all, and `seen` alone passes for one that quietly
      // returns claims it should have rejected.
      expect({
        refused: refusal instanceof AnthropicExtractorError,
        seen: watched.seen,
      }).toStrictEqual({
        refused: true,
        seen: [
          {
            inputTokens: 2804,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 4096,
          },
        ],
      });
    },
  );
});

/**
 * The one path the injected `fetch` never covers: the `fetch` the adapter
 * reaches for when it is handed none.
 *
 * Every other test in this file supplies its own, so the default is the single
 * line of this adapter that production takes and the suite does not. It is
 * still exercised without a socket: the platform's `fetch` is replaced for the
 * length of one test by a fake that refuses to be called as anything but the
 * platform's own, which is how a `fetch` reading `this` behaves on the runtimes
 * that have one.
 *
 * @spec §11
 */
describe('the fetch the adapter falls back on', () => {
  it('calls the platform’s own, not a loose function borrowed onto the adapter', async () => {
    const platform = fakeApi(answering(PUMP_CLAIMS));
    const receivers: unknown[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = function thisSensitiveFetch(
      this: unknown,
      ...args: Parameters<typeof globalThis.fetch>
    ): Promise<Response> {
      receivers.push(this);
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return platform.fetch(...args);
    };

    try {
      const extractor = new AnthropicExtractor();

      const claims = await extractor.extract({ chunkText: PUMP_CHUNK });

      expect({
        claims,
        calledAsThePlatform: receivers.map((receiver) => receiver === globalThis),
      }).toStrictEqual({ claims: PUMP_CLAIMS, calledAsThePlatform: [true] });
    } finally {
      globalThis.fetch = saved;
    }
  });
});

/**
 * `loadPort` imports the module, takes its default export, calls it with no
 * arguments and checks the result has `extract` on it. Nothing else about this
 * module is reachable from `.kgmem/config.json`, so nothing else about it is
 * what makes it loadable.
 *
 * `modelId` is checked here too because `loadPort` does *not* check it —
 * `REQUIRED_METHOD.extractor` is `'extract'` alone — and a port that satisfies
 * the loader while leaving §13's grouping key undefined would be found out
 * only in the rejection log.
 *
 * @spec §7.6, §11, §13
 */
describe('the default export the configuration loads', () => {
  it('is a factory that takes no arguments and returns an Extractor', async () => {
    const made: unknown = await Promise.resolve(makeExtractor());

    expect({
      factory: typeof makeExtractor,
      extract: typeof (made as { extract?: unknown }).extract,
      modelId: (made as { modelId?: unknown }).modelId,
    }).toStrictEqual({ factory: 'function', extract: 'function', modelId: ANTHROPIC_MODEL_ID });
  });
});
