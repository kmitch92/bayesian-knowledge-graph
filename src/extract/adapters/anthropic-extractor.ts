/**
 * §5.10's {@link Extractor}, against Anthropic's Messages API — the first
 * implementation of this port that is not a fixture.
 *
 * Everything upstream of here has been exercised against a scripted extractor:
 * the drain, the verbatim gate and §9's retry budget all have suites, and
 * *extraction itself* had none. Quality of extraction is this system's
 * precision ceiling, so the reviewable artefact in this file is
 * {@link EXTRACTION_PROMPT} — the code around it is a translation layer and
 * deliberately thin.
 *
 * ── `fetch` and Zod, not the SDK ────────────────────────────────────────────
 *
 * Node 22 ships `fetch` and this repo already depends on Zod, so the whole
 * adapter is one POST and one parse. An SDK would add a dependency whose main
 * value — retry and backoff — is the one thing this adapter must *not* have:
 * §9 puts the retry policy in the caller's hands, `extraction.ts` is that
 * caller, and it caps attempts at `MAX_ATTEMPTS`. A client retrying underneath
 * that cap would multiply the budget by a number the drain cannot see.
 *
 * `fetch` is injectable so the suite can drive hand-built {@link Response}s; a
 * test that could spend money is a test CI cannot run.
 *
 * ── Where the malformed line falls ──────────────────────────────────────────
 *
 * **Shape is this adapter's business; substance is the gate's.**
 *
 * A field that is absent, wrongly typed, or outside a closed vocabulary is
 * malformed and throws — `extraction.ts` reads a throw as transient and hands
 * the job back for another sampling, which can genuinely succeed where the
 * first call produced junk. A field that is present and well typed but *empty*
 * goes through untouched, because the gate and the rejection log are what judge
 * substance: a blank quote is `refusalFor`'s `quoteAbsent` arm and §13 counts
 * it, so swallowing it here would delete the evidence that the model is broken.
 *
 * That holds for `mentions` too, and E8b considered tightening it and refused.
 * The one ingest door demands at least one referent (§5.2), and it would be easy
 * to advertise `minItems: 1` in {@link CLAIM_TOOL}'s `input_schema` — the schema
 * is generated from {@link ProposedClaim}, so a `.min(1)` there would reach the
 * model for free. It would also make an empty list *malformed*, which throws the
 * **whole batch**: one claim naming nobody would again cost every sibling in the
 * answer and burn the call, which is exactly the E7d failure mode this cycle
 * exists to close. The floor stays at the drain, where `doorRefusalFor` refuses
 * one proposal, logs `mentionsAbsent` against it and lets the rest through. What
 * this adapter owes §5.2 is the *prompt*, and it pays it there.
 *
 * An empty `claims` array is likewise an answer, not a failure — a paragraph
 * with nothing worth claiming is the common case. Returning `[]` for an
 * *unreadable* answer would instead call `completeJob` and mark the chunk mined
 * of nothing, permanently.
 *
 * A batch with one spoiled claim throws whole. Dropping the bad sibling is the
 * only outcome that leaves no trace anywhere: the gate logs what it refuses and
 * §13 counts it, but nothing logs a proposal this adapter never handed over.
 *
 * ── What a refusal says ─────────────────────────────────────────────────────
 *
 * Every message here becomes a job's `last_error`, the only thing an operator
 * will read about the failure. So a refusal carries what it saw: an HTTP
 * failure names the status *and* the body, and an unreadable answer names the
 * offending value. *"Malformed response"* costs a re-run to diagnose.
 *
 * @spec §3.2, §5.2, §5.10, §6.3, §7.6, §9, §11, §12, §13, §15
 */

import { z } from 'zod';

import { ClaimKind, ClaimTier } from '../../schema/index.js';
import type { ExtractedClaim, ExtractionRequest, Extractor } from '../extraction.js';

/**
 * The model v1 measured extraction against.
 *
 * §13 groups the rejection log by model, so this string is an audit key before
 * it is a configuration default: the value here, the value in the request body
 * and the value in {@link AnthropicExtractor.modelId} are one string or the
 * audit attributes one model's failures to another.
 *
 * @spec §11, §13, §15
 */
export const ANTHROPIC_MODEL_ID = 'claude-haiku-4-5-20251001';

/** The Messages endpoint. @spec §11 */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * The API version this adapter was written against.
 *
 * Sent on every request because Anthropic requires it, and pinned rather than
 * floated because the response shape this file parses is the one this version
 * promises.
 *
 * @spec §11
 */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Output budget for one chunk.
 *
 * Generous rather than tight: a chunk is a paragraph or two, and a truncated
 * tool call is an unreadable answer that costs a whole retry — far more than
 * the tokens saved by trimming this.
 *
 * @spec §9, §15
 */
const MAX_TOKENS = 4096;

/** The one tool the model is forced into. @spec §5.10 */
const TOOL_NAME = 'record_claims';

/**
 * How much of an offending value a refusal quotes.
 *
 * The message lands in `jobs.last_error`, so it has to be diagnostic without
 * being a place a proxy's HTML error page gets stored in full.
 *
 * @spec §9, §12
 */
const SEEN_LIMIT = 1_000;

/**
 * §3.2's six kinds, each in one line the model can choose on.
 *
 * Keyed by the enum rather than written as loose prose so the compiler refuses
 * a vocabulary that has drifted: a kind added to `src/schema/` and not
 * described here fails to typecheck, instead of silently becoming a value the
 * model is asked for and never told about.
 *
 * @spec §3.2
 */
const KIND_GUIDE: Readonly<Record<ClaimKind, string>> = {
  fact: 'how something is or behaves — a property of the world the chunk reports.',
  convention:
    'a rule, standard or agreed practice people are expected to follow, whether or not they do.',
  rationale:
    'why a choice was made — the reasoning behind a decision, including alternatives considered and rejected.',
  risk: 'a hazard, a known failure mode, a caveat, or something that could go wrong.',
  intent:
    'what someone means to do — a goal, a plan, a commitment, something not yet carried out.',
  coupling:
    'a dependency or constraint tying two things together, such that changing one forces a change in the other.',
};

/**
 * §6.3's three rungs, in privilege order, as §5.10's tier rule reads them.
 *
 * The rule for *choosing* between rungs cannot live in a JSON-schema enum, and
 * getting it wrong is not a cosmetic error: a model that files reasoning as
 * measurement makes inference indistinguishable from evidence, and §4's whole
 * apparatus is downstream of that distinction.
 *
 * ── What these three lines had to stop saying ───────────────────────────────
 *
 * Each rung is now a statement about **what produced the characters in the
 * quote**, and about nothing else. The version before it defined `observed` by
 * what the claim *rests on* — *"tool output that is visible in this chunk"* —
 * and `inferred` by the shape of the writing, *"an argument, a conclusion, an
 * explanation"*. Both halves leak. The first is a judgement the model makes
 * about its own grounds, and a model that has just read a sentence sincerely
 * believes its claim rests on something visible in the chunk; the second leaves
 * a flat declarative assertion — most of any document — belonging to no rung at
 * all, and a taxonomy with a hole in it gets resolved upward. E8c's live run:
 * 35 of 225 proposals from a chunked prose design note came back `observed`,
 * with no tool output anywhere in the document.
 *
 * So `inferred` now claims that ground explicitly — *any prose at all, however
 * certainly asserted* — and `observed` is defined by provenance of text rather
 * than by grounds: characters a machine emitted, which the quote is copied from
 * the inside of. That is a question about the chunk a model can answer by
 * looking, rather than one it answers by introspecting.
 *
 * @spec §5.10, §6.3, §15
 */
const TIER_GUIDE: Readonly<Record<ClaimTier, string>> = {
  verified:
    'the chunk contains the recorded result of a check that ran, printed by whatever ran it — a test runner’s output, a CI job’s log, a validator’s report — and your quote is copied from that result. The chunk shows the run itself, not an account of a run.',
  observed:
    'the chunk contains the output of a tool, and your quote is copied from inside that output — the printed result of a command, a log line, a diff, a file listing, a stack trace, a returned payload. Characters a machine emitted and somebody pasted in.',
  inferred:
    'the characters you quoted are ones a person wrote. Any prose at all, whatever it asserts and however certainly — an argument, an explanation, a specification, a definition, a plain statement of fact you have no reason to doubt. Nearly every claim taken from a written document belongs here.',
};

const kindLines = ClaimKind.options.map((kind) => `- ${kind}: ${KIND_GUIDE[kind]}`).join('\n');
const tierLines = ClaimTier.options.map((tier) => `- ${tier}: ${TIER_GUIDE[tier]}`).join('\n');

/**
 * The system prompt, exported because it is the reviewable half of this phase.
 *
 * Exported *and* sent: this exact string is what the request carries, so a
 * reviewer reading it here is reading what runs. Three things it has to carry
 * that no `input_schema` can:
 *
 * 1. **§5.10's tier rule.** An enum lists the rungs; only prose says which one
 *    a given claim earns, and which way to fall when two look arguable.
 * 2. **Byte-for-byte copying.** The gate is `chunkText.includes(quote)` and
 *    nothing else — no trim, no fold — so a model that tidies its span loses
 *    the claim to `extraction_rejections`.
 * 3. **Mentions specific enough for §5.2's ladder, and at least one of them.**
 *    `exact name → mention index → embedding → LLM tiebreak` resolves a precise
 *    surface form onto the right referent and a generic one onto whichever
 *    referent got there first. *"it"* and *"the system"* are how referents
 *    over-merge — but an *empty* list is worse than a vague one, because the
 *    door refuses it outright.
 *
 * That last rule is the one this prompt got backwards, and it is worth the space
 * to say how. It read *"if a claim genuinely names no specific entity, give an
 * empty list — an empty list is honest where a placeholder is not"*, which is
 * sound advice about placeholders attached to an instruction the one ingest door
 * cannot obey: `ClaimMessage.mentions` is `.min(1)` under §5.2's *"forces every
 * claim to name its referents explicitly"*. E7d's first live run answered 37% of
 * its unique claims with an empty list and lost 14 paid calls to the
 * contradiction.
 *
 * Both halves of the replacement are load-bearing. *Demand a mention* alone
 * would drop that 37% of claims on the floor, and most of them were not
 * mention-less at all — *"The epistemics including evidence, taint, lifecycle,
 * consolidation, clocks, and verticals are domain-invariant"* names six things
 * the model simply did not list. So the prompt makes the demand, shows what
 * looking harder finds, and only then says what §5.2 says to do with the
 * residue: a claim that truly names no referent should not be recorded at all.
 * Teaching the model to look is the win; the escape hatch is there so the
 * alternative to looking is silence rather than a placeholder.
 *
 * ── Why the tier section is shaped the way it is ────────────────────────────
 *
 * E8c's live run fed a prose design note — no tool output in it anywhere —
 * through this prompt and got 35 of 225 proposals back at `observed`, 23% of
 * member claims and 69 auto-minted spine claims (§5.2's ladder passes the
 * message's tier into every referent it mints, so one inflated label is never
 * one inflated row). The instructive part is that the prompt it ran under
 * already said every correct thing: *"Quote the output itself, not the prose
 * describing it"*, *"inferred is the default"*, *"When two rungs both look
 * arguable, take the lower one"*. Saying them again, louder, was never going to
 * work, so this section does four things that are not repetition:
 *
 * 1. **It moves the question from grounds to provenance of text.** *"Tool output
 *    the claim rests on"* asks the model to audit its own grounds, and a model
 *    that has just read a sentence in the chunk answers honestly that its claim
 *    rests on something in front of it. *"Did a machine print the characters I
 *    copied, or did a person type them"* is a question about the page.
 * 2. **It fills the hole `inferred` used to leave.** Defined as *"an argument, a
 *    conclusion, an explanation"*, `inferred` visibly does not cover the flat
 *    declarative sentence that most of a document is made of — *"Nothing caps
 *    the cone's height"* is not an argument — and the rung directly above is
 *    named with a word that also means *I can see it*. A gap in a taxonomy is
 *    resolved upward. So `inferred` now claims prose outright, including the
 *    sentence the model is certain of.
 * 3. **It answers the criterion the model actually used.** *The chunk states
 *    this directly* is true of every claim that carries a quote, which makes it
 *    useless as a discriminator — and the prompt now says so, because a model
 *    will keep reaching for a reason nobody has disqualified.
 * 4. **It shows the failure rather than forbidding it.** One live claim promoted
 *    on the words *"test executed, CI observed"* with no check having run. The
 *    section carries that sentence family as a worked negative, paired with a
 *    runner's actual output on the same subject, so the only variable between
 *    the two examples is the one that decides the rung.
 *
 * A per-chunk gate carries the rest: *find the tool output before reaching for
 * `observed` at all, and if the chunk has none, nothing in it can be observed or
 * verified.* That is one judgement per chunk rather than one per proposal, and
 * on the document that produced this defect it is answered `no` once and
 * disposes of all 35.
 *
 * None of it is checkable offline — the saved transcript holds the old prompt's
 * answers, and a rewritten prompt has no answers until a live run makes some. So
 * no test asserts this worked, and the suite pins only that the prompt and the
 * one ingest door name the same rung as the default.
 *
 * @spec §3.2, §4.2, §5.2, §5.10, §6.3, §15
 */
export const EXTRACTION_PROMPT = `You are the extraction step of a knowledge graph. You are shown one chunk of one document, and you record the claims that chunk supports by calling the ${TOOL_NAME} tool exactly once.

Record only what the chunk itself says. Do not draw on knowledge from outside it, and do not record what you merely suspect: a claim you cannot quote is a claim you must not record. When the chunk carries nothing worth recording — a heading, boilerplate, narration, a fragment of a table — call the tool with an empty list. That is a normal answer and a common one. A missed claim costs one paragraph; an invented one corrupts the graph in both directions, because a refuted invention marks a sound paragraph stale and a corroborated one buys unearned confidence.

## text — one self-contained proposition

Write each claim as a single declarative sentence that still means the same thing with the chunk taken away. Resolve every pronoun and every "this" or "that" first: "the handler retries twice" is useless later, "the payment webhook handler retries twice" is a claim. One assertion per claim — a sentence carrying two goes in as two claims.

## quote — copied character for character

Every claim carries the span of the chunk that supports it, copied exactly. Exactly means exactly: the same characters in the same order, with the same capitalisation, the same punctuation, the same curly or straight quotation marks and apostrophes, the same internal line breaks, and any leading or trailing spaces that fall inside the span you chose. Do not tidy, re-wrap, straighten, translate, expand abbreviations, correct spelling, or join lines.

Copy a span; do not compose one. The quote must be one contiguous run of characters taken from the chunk — never two fragments stitched together, never a paraphrase. Keep it to the shortest run that carries the claim, and rarely longer than a sentence or two.

Your span is checked by testing whether the chunk literally contains it. A span you improved is not found, and the claim is thrown away.

## kind — what sort of thing the claim is

${kindLines}

Pick the single best fit. A claim reporting how something behaves is a fact even when it appears inside an argument; the sentence explaining why that behaviour was chosen is a separate claim, and a rationale.

## tier — what produced the text you quoted

${tierLines}

The rung is a fact about the characters in your quote. It is not a measure of how sure you are, how important the claim is, or how plainly the chunk puts it. Ask one question and answer it literally: did a machine print the run of text I copied, or did a person type it? A person typed it, so the claim is inferred.

Before reaching for observed at all, look over the whole chunk and find the tool output in it. You will know it on sight: a command with what it printed underneath, a log with timestamps or levels, a diff with + and - down the margin, a directory listing, a JSON or XML body, a stack trace, a table a program formatted. Most documents contain none of this anywhere in them. If this chunk contains none of it, then no claim from this chunk can be observed and none can be verified, whatever the chunk is about and however it is worded — file every one of them as inferred.

Words about tools are not tool output. A sentence is prose whether it discusses the weather or a test suite, so the words test, log, CI, checked, measured, confirmed, verified and observed appearing in a chunk are the author's vocabulary and are not evidence of anything. Take a chunk containing this line:

> The rotation job was tested against 400 fixtures and CI observed no regressions.

Every claim from it is inferred. The chunk holds one person's report that a check happened; it does not hold the check. A chunk containing this instead:

> $ pnpm test src/rotation
> ✓ src/rotation/__tests__/job.test.ts (400 tests) 2.41s
> Test Files  1 passed (1)

is showing you the run, and a claim quoting those printed lines is verified. Same subject, different rung, and the thing that moved it was the presence of the machine's own output — never the sincerity or the wording of the sentence.

Nor does observed mean that the chunk states the claim outright. Everything you record is stated in the chunk somewhere; that is what the quote is for. So the chunk says so directly cannot be what separates the rungs, because it is equally true of every inferred claim you will file. A flat, confident, unarguable sentence is still a person writing prose.

Prose is inferred, and inferred is the default.

These three are a privilege ladder, and the cost of inflating a rung is paid somewhere you will never see it: everything downstream weighs measurement above reasoning, so reasoning filed as measurement becomes reasoning that can never be told from evidence again. When two rungs both look arguable, take the lower one.

## mentions — the nouns the claim is about

List the entities the claim names, in the chunk's own words. Use the most specific surface form the chunk gives you: a file path, a function or type name, a command, a service, a table, a product, a named person or team. These strings are matched against the entities the graph already holds — by exact name first, then by known aliases, then by meaning — so a precise name lands on the right entity and a vague one lands on the wrong one.

Never list a generic placeholder. "it", "the system", "the code", "the file", "the team", "the user" name nothing in particular, and every claim carrying one is pulled onto the same entity as every other. Do not invent an identifier the chunk does not use, and do not expand an abbreviation into a name the author never wrote.

Every claim carries at least one mention. The list is never empty: a claim attached to no entity can never be retrieved, corroborated or refuted again, so it is refused on arrival and the work of finding it is thrown away.

Before deciding a claim names nothing, read the claim you just wrote and look for its nouns in the chunk — they are almost always there. The subject of your sentence is a mention. So is anything the sentence asserts a relationship to. A claim about several things at once names all of them: "The epistemics including evidence, taint, lifecycle, consolidation, clocks, and verticals are domain-invariant" mentions evidence, taint, lifecycle, consolidation, clocks and verticals — six mentions, not none. A claim about a rule, a section, a process, a decision, a format or a document names that thing, in whatever words the chunk uses for it.

If you have done that and genuinely cannot name one specific entity the claim is about, do not record the claim at all. Dropping it costs one claim; a placeholder costs every claim that shares it.`;

/**
 * `input_schema` read off a Zod object, not declared beside it.
 *
 * Before this, {@link CLAIM_TOOL}'s `input_schema` and {@link ToolInput} were
 * two independent object literals naming the same six fields, and nothing in
 * the type system tied them together. Renaming one alone still typechecked
 * and still passed the suite: the model would answer perfectly to the
 * contract it was handed, `ToolInput.safeParse` would refuse every single
 * answer, and every chunk would burn `MAX_ATTEMPTS` and park — a 100%
 * extraction failure with no error naming why, because nothing was ever
 * malformed *relative to what the model was told*. Generating the schema from
 * the Zod object makes that rename one edit instead of two that have to stay
 * in step by discipline alone.
 *
 * Deliberately narrow: this file's claim shape is two strings, one enum
 * pair, one array of strings and — at {@link ToolInput}'s own level — one
 * array of objects, so a hand-rolled reader for exactly those five shapes is
 * smaller and more auditable than a dependency that handles Zod's whole
 * surface for a translation this size. A field added later in a shape this
 * function does not recognise throws at import time, naming the constructor
 * it choked on — before a single chunk is ever sent, not after five silent
 * refusals.
 *
 * @spec §5.10, §11, §12
 */
type JsonSchema = Record<string, unknown>;

/** `{ description }` if the Zod node carries one via `.describe()`, else nothing to spread. */
const describedAs = (field: z.ZodTypeAny): JsonSchema =>
  field.description === undefined ? {} : { description: field.description };

/** One Zod node's JSON Schema — recursively, for the object-of-object case. */
const jsonSchemaOf = (field: z.ZodTypeAny): JsonSchema => {
  if (field instanceof z.ZodEnum)
    return { type: 'string', enum: [...field.options], ...describedAs(field) };
  if (field instanceof z.ZodArray)
    return { type: 'array', items: jsonSchemaOf(field.element), ...describedAs(field) };
  if (field instanceof z.ZodString) return { type: 'string', ...describedAs(field) };
  if (field instanceof z.ZodObject)
    return { type: 'object', ...objectSchemaOf(field), ...describedAs(field) };
  throw new Error(`jsonSchemaOf: no JSON-Schema mapping for a ${field.constructor.name} field`);
};

/**
 * An object node's `properties` / `required` / `additionalProperties` — the
 * three keys both {@link jsonSchemaOf}'s object branch and {@link CLAIM_TOOL}
 * need, read off {@link z.ZodObject.shape} in field-declaration order.
 */
const objectSchemaOf = (object: z.ZodObject<z.ZodRawShape>): JsonSchema => {
  const entries = Object.entries(object.shape) as ReadonlyArray<[string, z.ZodTypeAny]>;
  return {
    properties: Object.fromEntries(entries.map(([name, field]) => [name, jsonSchemaOf(field)])),
    required: entries.filter(([, field]) => !field.isOptional()).map(([name]) => name),
    additionalProperties: false,
  };
};

/**
 * One proposal, parsed rather than cast.
 *
 * Nothing here transforms: `z.string()` on `quote` is a type check and not a
 * normalization, which is the whole point — the gate tests the span the model
 * offered, byte for byte, and a `.trim()` anywhere on this path silently moves
 * claims into `extraction_rejections`. `.describe()` below is the one
 * addition, and it is inert at parse time — Zod stores it as metadata on the
 * node and neither `.parse()` nor `.safeParse()` ever reads it back. It
 * exists so {@link jsonSchemaOf} has somewhere to read the model-facing prose
 * from, instead of a second copy of it living in a schema object declared
 * separately.
 *
 * @spec §3.2, §5.10, §6.3
 */
const ProposedClaim = z.object({
  text: z
    .string()
    .describe('The claim as one self-contained declarative sentence, with every pronoun resolved.'),
  quote: z
    .string()
    .describe(
      'One contiguous run of characters copied from the chunk exactly as written, supporting this claim.',
    ),
  kind: ClaimKind.describe('What sort of thing the claim is.'),
  // The schema's one word on the rung, and it says the same thing the prompt's
  // tier section says: the rung is decided by what produced the characters in
  // the quote. The field description is the last prose the model reads before it
  // answers, so a description phrased as *how strongly the chunk supports this*
  // would reopen at the point of decision the door the prompt spent a section
  // closing. @spec §6.3, §15
  tier: ClaimTier.describe(
    'What produced the text quoted above: prose a person wrote, or output a tool printed.',
  ),
  mentions: z
    .array(z.string())
    .describe(
      'The entities the claim names, in the chunk’s own words, as specifically as the chunk names them.',
    ),
});

/** The forced tool's argument object. @spec §5.10 */
const ToolInput = z.object({
  claims: z
    .array(ProposedClaim)
    .describe(
      'One entry per claim the chunk supports, in the order the chunk makes them. Empty when the chunk supports none.',
    ),
});

/**
 * The forced tool.
 *
 * Its `input_schema` is {@link objectSchemaOf} applied to {@link ToolInput}:
 * the fields the model is told to fill in and the fields
 * `ToolInput.safeParse` will accept are one read of one Zod object, not two
 * literals written to match today. See {@link jsonSchemaOf} for why that
 * matters and how far the reader goes.
 *
 * @spec §3.2, §5.10, §6.3
 */
const CLAIM_TOOL = {
  name: TOOL_NAME,
  description:
    'Records the claims one chunk of a document supports. Called exactly once per chunk, with an empty list when the chunk supports none.',
  input_schema: { type: 'object', ...objectSchemaOf(ToolInput) },
};

/** @spec §12 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A value as a refusal should quote it: readable, and bounded.
 *
 * @spec §9, §12
 */
const seen = (value: unknown): string => {
  const rendered = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  if (rendered.length === 0) return '(empty)';
  return rendered.length <= SEEN_LIMIT ? rendered : `${rendered.slice(0, SEEN_LIMIT)}… (truncated)`;
};

/** Zod's complaint, flattened into one line an operator reads in `last_error`. @spec §12 */
const issuesOf = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length === 0 ? 'input' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');

/**
 * Everything that goes wrong between the socket and a list of claims.
 *
 * One class rather than a transient/permanent split, because the adapter does
 * not own that distinction: §9 gave the retry policy to the drain, and a 401
 * that burns five attempts still parks with a message naming the key. What the
 * adapter owes is a message an operator can act on without re-running anything.
 *
 * @spec §9, §12
 */
export class AnthropicExtractorError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AnthropicExtractorError';
  }
}

/** @spec §11 */
export interface AnthropicExtractorOptions {
  /**
   * The model to call. Defaults to {@link ANTHROPIC_MODEL_ID}.
   *
   * A default rather than a weld: §13's audit is grouped by model precisely so
   * a later phase can measure a second one.
   *
   * @spec §13, §15
   */
  readonly model?: string;
  /**
   * The `fetch` to reach the API through. Defaults to the platform's.
   *
   * @spec §11
   */
  readonly fetch?: typeof globalThis.fetch;
}

/** What the drain tells the model, beyond the prompt. @spec §5.10 */
const userMessage = (request: ExtractionRequest): string => {
  const context = request.context;
  const where =
    context === undefined || context.length === 0 ? '' : `Where this chunk sits: ${context}\n\n`;
  return `${where}The chunk, between the markers and nowhere else:\n\n<chunk>\n${request.chunkText}\n</chunk>`;
};

/**
 * The Messages answer, down to the forced tool's argument object.
 *
 * A narrated tool call is still a tool call — a model that comments before it
 * answers has answered — so the first `tool_use` block wins and any prose
 * around it is ignored. Prose *instead* of a tool call is not an empty answer,
 * it is no answer, and it throws.
 *
 * ── The answer that ran out of room ─────────────────────────────────────────
 *
 * `stop_reason: 'max_tokens'` says the answer was cut off at `budget`, and a
 * tool call cut off mid-write is the one unreadable answer that does not look
 * unreadable. Every other malformed answer here announces itself and the
 * *"throw whole, never claim by claim"* rule catches it. A guillotined batch
 * defeats that rule from the other side: a list of claims severed mid-list
 * commonly still parses, as a perfectly well-formed but **shorter**
 * `{ claims: [...] }`. Handed over, it calls `completeJob` and marks the chunk
 * mined — every claim past the cut lost for good, no `extraction_rejections`
 * row, no trace anywhere, and a chunk that gave up one claim of three
 * indistinguishable from one that only ever held one. That is strictly worse
 * than the spoiled sibling this adapter already refuses, which at least throws.
 *
 * So the check runs *before* `ToolInput.safeParse`, both because the cleanly
 * parsing ending would never reach a parse failure at all, and because when the
 * cut does land mid-claim the honest diagnosis is the budget, not Zod's
 * *"claims.1.mentions: Required"* — that symptom sends an operator hunting a
 * prompt bug the model never had.
 *
 * **Last block, not any block.** Content blocks arrive in order and the budget
 * cuts whichever one was being written, so only the last block can be
 * half-written; a `tool_use` with another block after it was finished, and what
 * the budget took was the narration that followed. Which is the same rule the
 * first-`tool_use`-wins reading states from the other end: refuse exactly when
 * the block this function would have read is the one that got cut.
 *
 * @spec §5.10, §9, §12, §15
 */
const toolInputOf = (payload: unknown, budget: number): unknown => {
  if (!isRecord(payload) || !Array.isArray(payload.content))
    throw new AnthropicExtractorError(
      `the Messages API answered with no content blocks: ${seen(payload)}`,
    );

  const blocks: readonly unknown[] = payload.content;
  const last = blocks[blocks.length - 1];
  if (payload.stop_reason === 'max_tokens' && isRecord(last) && last.type === 'tool_use')
    throw new AnthropicExtractorError(
      `the Messages API stopped on max_tokens part-way through the ${TOOL_NAME} call, so the claims that arrived are not all of them — raise the output budget above ${String(budget)} and extract this chunk again: ${seen(payload)}`,
    );

  for (const block of blocks) if (isRecord(block) && block.type === 'tool_use') return block.input;

  throw new AnthropicExtractorError(
    `the model answered without calling ${TOOL_NAME}: ${seen(payload)}`,
  );
};

/**
 * The answer's body as JSON, or a refusal that quotes what came back instead.
 *
 * @spec §12
 */
const jsonOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new AnthropicExtractorError(
      `the Messages API answered with a body that is not JSON: ${seen(raw)}`,
      cause,
    );
  }
};

/**
 * §5.10's extractor: one chunk in, the model's proposals out.
 *
 * @spec §5.10, §11
 */
export class AnthropicExtractor implements Extractor {
  /** §13's grouping key, and exactly the string the request asks for. @spec §13 */
  readonly modelId: string;

  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;

  /**
   * Reads the key at construction, and refuses without one.
   *
   * `reflect` builds every port through `openModels` *before* it opens the
   * store or claims a job, so a misconfigured repository costs one immediate
   * error and nothing off §9's queue. An adapter that waited until `extract`
   * would claim a job, re-derive the whole document's chunking through
   * `chunksOf`, and only then discover it has no key — five times, on the way
   * to being parked.
   *
   * An empty variable is the same misconfiguration a missing one is: a shell
   * that exported nothing is not a repository that configured a blank key.
   *
   * @spec §7.6, §9, §11, §12
   */
  constructor(options: AnthropicExtractorOptions = {}) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key === undefined || key.length === 0)
      throw new AnthropicExtractorError(
        'no ANTHROPIC_API_KEY in the environment: set ANTHROPIC_API_KEY to an Anthropic API key before running an extraction',
      );

    this.#apiKey = key;
    // Bound, because a bare `globalThis.fetch` invoked as a method of this
    // instance is a footgun on any runtime whose implementation reads `this`.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.modelId = options.model ?? ANTHROPIC_MODEL_ID;
  }

  /** @spec §5.10, §9, §12 */
  async extract(request: ExtractionRequest): Promise<readonly ExtractedClaim[]> {
    // One call, and no retry of any status: §9 gave the backoff to the drain,
    // which counts attempts against a cap this adapter cannot see.
    const response = await this.#fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        // The Messages API authenticates on `x-api-key`; a bearer token is
        // silently unauthenticated rather than rejected as malformed.
        'x-api-key': this.#apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: MAX_TOKENS,
        // No `temperature`: left at the API default rather than set blind.
        // This adapter's output is graded byte-for-byte by the verbatim gate,
        // so sampling noise lands on `quote` — a coin flip on whether a claim
        // survives — and a value picked without replay data is nobody's
        // considered choice. §13's audit is the tool for choosing one.
        system: EXTRACTION_PROMPT,
        tools: [CLAIM_TOOL],
        // Forced: an unforced tool leaves "the model chose to narrate" and "the
        // chunk holds nothing" indistinguishable, and those two answers are a
        // retry apart.
        tool_choice: { type: 'tool', name: TOOL_NAME },
        // Verbatim, and nowhere folded: the gate tests the model's span against
        // the unfolded original, so a chunk that arrives tidied cannot produce
        // a quote that survives.
        messages: [{ role: 'user', content: userMessage(request) }],
      }),
    });

    const raw = await response.text();
    if (!response.ok)
      throw new AnthropicExtractorError(
        `the Messages API refused with ${String(response.status)}: ${seen(raw)}`,
      );

    // The budget travels with the answer it truncated: a refusal naming a
    // number the request did not send sends an operator to raise the wrong one.
    const input = toolInputOf(jsonOf(raw), MAX_TOKENS);
    const parsed = ToolInput.safeParse(input);
    if (!parsed.success)
      // Whole, never claim by claim. Dropping the spoiled sibling would leave
      // no trace anywhere: the gate logs what it refuses, but nothing logs a
      // proposal that was never handed over.
      throw new AnthropicExtractorError(
        `the model’s ${TOOL_NAME} call does not read as claims — ${issuesOf(parsed.error)} — in ${seen(input)}`,
        parsed.error,
      );

    return parsed.data.claims;
  }
}

/**
 * What `loadPort` calls: a no-argument factory returning the port.
 *
 * @spec §7.6, §11
 */
export default (): Extractor => new AnthropicExtractor();
