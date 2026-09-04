/**
 * Text as the universal ingress, and both halves of §5.10's bargain.
 *
 * *"Ingest is cheap: chunk, embed, anchor — the document serves whole
 * immediately. Extraction is lazy."* The two halves are two modules, because
 * they are two costs paid at two times by two callers:
 *
 * ```
 * submitText(source) → chunk + embed + anchor → one job per chunk on §9's queue
 *                                                        ↓
 * drainOnce()        → extractor → verbatim gate → openIngest.submit() → claims
 *                                               ↘ refused → extraction_rejections
 * ```
 *
 * `./chunking.ts` is the pure chunker both sides stand on. `./text-ingest.ts` is
 * the cheap half, which claims no job and proposes no member. `./extraction.ts`
 * is the expensive half, which does nothing but. This file is the seam they are
 * read through, so a caller holding a {@link TextSource} or a
 * {@link DrainOutcome} needs one import rather than four; nothing is declared
 * here.
 *
 * **Nothing below knows a programming language.** §5.10's document is an ADR, a
 * philosophy notebook, a runbook, a transcript or a repository, and the core
 * cannot tell which it is holding.
 *
 * @spec §3.6, §5.10, §9, §11
 */

export { chunkText, hashChunk } from './chunking.js';
export type { ChunkAnchor, ChunkView } from './chunking.js';

export {
  ContentRefDivergedError,
  EXTRACT_JOB_KIND,
  EmptyDocumentError,
  openTextIngest,
} from './text-ingest.js';
export type {
  DocumentOrigin,
  Resolution,
  TextIngestOptions,
  TextIngestPort,
  TextReceipt,
  TextSource,
} from './text-ingest.js';

export { openExtraction } from './extraction.js';
export type {
  DrainOutcome,
  ExtractedClaim,
  ExtractionOptions,
  ExtractionPort,
  ExtractionRequest,
  Extractor,
} from './extraction.js';
