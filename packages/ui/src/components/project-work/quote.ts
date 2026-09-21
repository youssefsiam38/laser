/**
 * Quote: put a piece of evidence into the composer (M21-T7).
 *
 * The workspace and the conversation are two surfaces of one window, and the
 * composer belongs to the conversation — so Quote is an *event*, not a reach
 * across the tree. The composer listens while it is mounted (it always is,
 * D-355: the conversation is never unmounted while the workspace is open),
 * folds the text into the draft it already holds, and nothing is lost if the
 * person is somewhere the composer cannot take it.
 *
 * The text is Markdown built by `project-work/research.ts`: the artifact's
 * key, the claim, the verbatim excerpt as a blockquote and the `[from …]`
 * provenance line. Foreign text therefore arrives in the conversation
 * carrying where it came from, exactly as it was read.
 */
export const WORK_QUOTE_EVENT = "work-quote";

export interface WorkQuoteDetail {
  /** Markdown, already provenanced. Never HTML, never a bare excerpt. */
  text: string;
  /** What it came from, for the confirmation the person sees. */
  workKey: string;
}

/** Ask the composer to take this quote. Returns nothing: the composer answers. */
export function quoteIntoComposer(detail: WorkQuoteDetail): void {
  window.dispatchEvent(new CustomEvent<WorkQuoteDetail>(WORK_QUOTE_EVENT, { detail }));
}

/** Subscribe to quotes. The composer is the one consumer. */
export function onWorkQuote(listener: (detail: WorkQuoteDetail) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<WorkQuoteDetail>).detail;
    if (detail && typeof detail.text === "string") listener(detail);
  };
  window.addEventListener(WORK_QUOTE_EVENT, handler);
  return () => window.removeEventListener(WORK_QUOTE_EVENT, handler);
}
