/**
 * E4's first source: a session's messages, rendered into one {@link TextSource}
 * §5.10's door already knows how to swallow.
 *
 * This is an adapter and nothing more. It chunks nothing, embeds nothing,
 * anchors nothing, enqueues nothing and adjudicates nothing — `submitText` does
 * all of that, and only if the caller decides to hand the value over. A source
 * that did any of it would be doing E2's job a second time, in a second place,
 * against a second set of rules.
 *
 * ── The unit, which is derived and not chosen ───────────────────────────────
 *
 * **One session is one document, therefore one episode.** §5.10 makes a
 * document one episode; §5.11 makes a resumed session chain one episode and
 * makes documents one episode per artifact; E2 derives the episode from the
 * document id. Those three together leave exactly one unit available: the
 * session is the artifact. Forty assertions mined out of one conversation are
 * one source and not forty observations, which is what §4.2's episode cap says
 * — and the cap can only fire if all forty share an episode.
 *
 * ── Four properties of the rendering ────────────────────────────────────────
 *
 * **Verbatim.** E3's gate tests a quote by exact containment in the chunk, with
 * no trimming and no folding, so a turn reflowed, re-wrapped or summarised on
 * the way through silently destroys every quote that turn could have supported.
 * Every message therefore reaches the text byte for byte.
 *
 * **Cut at turns.** {@link chunkText} cuts on blank lines, so one turn is one
 * paragraph — {@link TURN_BREAK} between turns and nothing inside one. A chunk
 * carrying two speakers is a chunk whose members are attributable to neither.
 *
 * **The speaker travels inside the chunk.** E3 hands the extractor
 * `{ chunkText }` and nothing else, so a tier-faithful extractor can only tell
 * a tool result from an assistant thinking aloud if the role is in the same
 * paragraph as what was said. Hence {@link SPEAKER_MARK} *inline*, and
 * deliberately **no standalone header paragraph**: a banner or a bare label
 * would be a paragraph E2 embeds, anchors and parks a job for, and one E3 hands
 * to a model — so anything mined out of it is §12's phantom, manufactured by
 * the ingester rather than by the model.
 *
 * Which tier the extractor then assigns is the extractor's contract and not
 * this module's. Nothing here assigns one.
 *
 * **Append-only.** The rendering of a session's first N turns is a byte-level
 * *prefix* of the rendering of its first N+2, which is what makes a resumed
 * session cost only its new tail: E2 re-parks a job for a chunk whose hash it
 * has not seen, so an unchanged prefix is free. That property is fragile in a
 * way that does not show: a counted header, a per-turn number, a timestamp or a
 * footer would reflow the whole document on every resumption, decay every
 * member of it under §5.10's testimony decay and re-park every job — and the
 * transcript would still look like a transcript. So the rendering is a join,
 * with no preamble and no trailer, and no term in it that is a function of
 * anything but the turn it renders.
 *
 * ── The role is a string, and stays one ─────────────────────────────────────
 *
 * {@link TranscriptMessage.role} is free text. An allowlist of `user` and
 * `assistant` is precisely the mechanism by which a tool result gets silently
 * dropped, and §5.10's tier-faithfulness cannot survive that: a claim grounded
 * in tool output can only be `observed` if the tool output is in the document
 * for its quote to match against. A role this module has never heard of is
 * carried, labelled with itself, and left for the extractor to have an opinion
 * about.
 *
 * ── Flagged, and deliberately not resolved ──────────────────────────────────
 *
 * §5.10 wants a claim grounded in tool output to cite that output, but E3's
 * gate tests the quote against *the chunk under extraction*, and an assistant's
 * assertion and the tool result it rests on are different turns and therefore
 * different chunks. What is settled here is only the part both readings of that
 * need: the tool result reaches the model as a chunk of its own, carrying its
 * speaker, with a quote today's gate admits. Which turn a grounded claim is
 * extracted *from* is left open.
 *
 * ── Two costs, accepted rather than fixed ───────────────────────────────────
 *
 * A turn the author split with its own blank line renders as more than one
 * paragraph, but {@link SPEAKER_MARK} only opens the first: the paragraphs
 * after it reach the model with no speaker at all. Re-joining what the author
 * chose to break would cost the verbatim property every quote in this module
 * relies on, so the label loss on those later paragraphs stands.
 *
 * A turn that quotes text shaped like `role: content` — an assistant reading a
 * log back, say — renders byte-identical to a genuine turn from that role.
 * Escaping it would protect the label, but only by rewriting bytes E3's gate
 * must match verbatim, so the occasional false turn boundary is the price of
 * a true one everywhere else.
 *
 * @spec §3.6, §4.2, §4.4, §5.10, §5.11, §9, §11, §12
 */

import type { Origin } from '../ingest/index.js';

import type { TextSource } from './text-ingest.js';

/**
 * One turn of a session.
 *
 * @spec §5.10
 */
export interface TranscriptMessage {
  /**
   * Who spoke, as the session's host names them.
   *
   * A string and not a union, for the reason this module's head gives: a
   * renderer that recognises two roles and drops the rest fails silently, and
   * takes §5.10's `observed` tier down with the tool results it dropped.
   *
   * @spec §5.10
   */
  readonly role: string;
  /** What was said, exactly as it was said. @spec §3.6, §5.10 */
  readonly content: string;
}

/**
 * A session offered for ingest.
 *
 * @spec §5.10, §5.11
 */
export interface TranscriptSession {
  /**
   * How the session names itself.
   *
   * Not a ULID and not hashed from the messages: the id is what makes a resumed
   * session the *same* document, and therefore the same episode, as the one it
   * resumes. A content-keyed id would make every resumption a stranger that
   * corroborates its own earlier self, which is §4.4's independence failure.
   *
   * @spec §4.4, §5.10, §5.11
   */
  readonly id: string;
  /** The turns, in the order they were said. @spec §5.10 */
  readonly messages: readonly TranscriptMessage[];
  /** Who submitted it, over what pathway. The document's own episode is E2's. @spec §3.5, §4.7 */
  readonly provenance: Origin;
  /** What the host calls the session, if it calls it anything. @spec §3.6 */
  readonly title?: string | undefined;
  /** The noun the session is about, if the submitter names one. Never guessed. @spec §3.6, §5.2 */
  readonly anchor?: string | undefined;
}

/**
 * What separates a speaker from what it said.
 *
 * Inline rather than on its own line, so the label can never become a paragraph
 * of its own — see this module's head on §12's phantoms.
 *
 * @spec §5.10, §12
 */
const SPEAKER_MARK = ': ';

/**
 * What separates one turn from the next: the blank line {@link chunkText} cuts
 * on, so a turn boundary is a chunk boundary.
 *
 * @spec §3.6, §5.10
 */
const TURN_BREAK = '\n\n';

/**
 * What a session's document id is made of.
 *
 * Namespaced so a session and a file that happen to name themselves the same
 * string are two documents and two episodes, rather than one artifact that
 * silently revises the other away.
 *
 * @spec §3.6, §5.10
 */
const SESSION_ID_PREFIX = 'session:';

/**
 * Whether a turn said anything at all.
 *
 * A turn with nothing in it renders to its label alone, and a label alone is a
 * chunk nobody spoke. Dropped rather than rendered, so the turns either side of
 * it keep their own paragraphs and the document gains no phantom.
 *
 * @spec §5.10, §12
 */
const spoken = (turn: TranscriptMessage): boolean => turn.content.trim().length > 0;

/**
 * A run of whitespace in a role, which the label is not allowed to keep.
 *
 * The label is scaffolding this module writes, and a label carrying a line break
 * splits the turn it introduces: `tool\n\nresult` renders a paragraph reading
 * `tool` that nobody spoke, which E2 embeds, anchors and parks an extraction job
 * for — §12's phantom, manufactured by the ingester, and the same failure
 * {@link spoken} already refuses on the content side.
 *
 * Folded rather than dropped, because dropping the turn would take what was said
 * with it, and a tool result missing from the document is exactly how §5.10's
 * `observed` tier dies: there is nothing left for the quote to match against.
 * That is the silent drop {@link TranscriptMessage.role} is free text to avoid,
 * and an odd label is no better a reason to lose a turn than an unfamiliar one.
 *
 * Every whitespace run, not just the double break the chunker cuts on, so the
 * label occupies one line by construction rather than by agreement with a
 * pattern in another module.
 *
 * @spec §5.10, §12
 */
const ROLE_WHITESPACE = /\s+/gu;

/**
 * One turn, as one paragraph: its speaker, then what it said, verbatim — a
 * function of that turn and of nothing else, not of its position, how many
 * turns there are, or what any other turn said, which is what keeps the
 * append-only property described at the head of this file true.
 *
 * Only the label — this module's own scaffolding — is folded through {@link
 * ROLE_WHITESPACE}. The content passes through untouched, because E3's gate
 * quotes against what was said, never against who said it.
 *
 * @spec §5.10, §12
 */
const renderTurn = (turn: TranscriptMessage): string =>
  `${turn.role.replace(ROLE_WHITESPACE, ' ')}${SPEAKER_MARK}${turn.content}`;

/**
 * A session, as a document.
 *
 * Pure and synchronous: it reads nothing and writes nothing, and the same
 * session renders to the same bytes in any process. A session nobody has spoken
 * in renders to no text at all, which E2's door refuses on its own terms — this
 * module does not need a second opinion about it.
 *
 * @spec §3.6, §4.2, §5.10, §5.11
 */
export const transcriptSource = (session: TranscriptSession): TextSource => ({
  id: `${SESSION_ID_PREFIX}${session.id}`,
  title: session.title ?? session.id,
  text: session.messages.filter(spoken).map(renderTurn).join(TURN_BREAK),
  origin: 'authored',
  anchor: session.anchor,
  provenance: session.provenance,
});
