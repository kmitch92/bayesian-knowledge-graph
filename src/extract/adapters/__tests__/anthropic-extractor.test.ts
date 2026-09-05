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
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const list = Object.entries(properties).find(
    ([, value]) => isRecord(value) && value.type === 'array',
  );
  if (list === undefined) throw new Error('the tool schema advertises no list for the claims');

  const [listName, listSchema] = list;
  const items = isRecord(listSchema) && isRecord(listSchema.items) ? listSchema.items : {};
  const fields = isRecord(items.properties) ? items.properties : {};

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

/** A Messages API answer carrying the content blocks given. */
const messageResponse = (request: RecordedRequest, content: readonly unknown[]): unknown => ({
  id: 'msg_01ExtractorFixture',
  type: 'message',
  role: 'assistant',
  model: modelOf(request),
  content,
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 480, output_tokens: 96 },
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
