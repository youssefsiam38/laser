/**
 * Taking a whole large body out of the window: to the clipboard or to a file
 * (M16-T60). Both stream it from its authority a slice at a time and hold no
 * more than the operation needs, for no longer than it runs.
 */
import type { BodyRef } from "@/runtime/body-excerpt";
import { canCopyWholeBody, copyWholeBody, streamBody, type RangeRequest, type RevisionRequest } from "@/runtime/body-reader";
import { utf8ByteLength } from "@lasercode/protocol";

/**
 * The most a window without blob clipboard support assembles as one string to
 * copy. Past it the person is told to download instead; nothing is cut short
 * silently.
 */
export const COPY_TEXT_MAX_BYTES = 1024 * 1024;

/** Slice text kept in hand before it is folded into the blob being built. */
const FOLD_BYTES = 256 * 1024;

export type TransferOutcome =
  | { ok: true; bytes: number }
  | { ok: false; message: string }
  | { ok: false; cancelled: true };

interface Source {
  request: RangeRequest;
  path: string;
  ref: BodyRef & { entryId: string };
  environmentKey: string;
  revisionOf?: RevisionRequest | undefined;
}

const SHORT = "Only part of this could be read just now. Try again in a moment.";
const CORRUPT = "What came back was not this output. Open the conversation again.";

export async function copyWhole(source: Source, writeText: (text: string) => Promise<boolean>): Promise<TransferOutcome> {
  const options = { environmentKey: source.environmentKey, ...(source.revisionOf ? { revisionOf: source.revisionOf } : {}) };
  if (canCopyWholeBody()) {
    const outcome = await copyWholeBody(source.request, source.path, source.ref, options);
    if (outcome.ok) return outcome;
    return { ok: false, message: outcome.reason === "corrupt" ? CORRUPT : outcome.reason === "short" ? SHORT : TOO_LARGE_TO_COPY };
  }
  if (source.ref.totalBytes > COPY_TEXT_MAX_BYTES) return { ok: false, message: TOO_LARGE_TO_COPY };
  const parts: string[] = [];
  let bytes = 0;
  const outcome = await streamBody(source.request, source.path, source.ref, options, (slice) => {
    bytes += utf8ByteLength(slice);
    // The authority said how big it was; a body that grows past the cap on
    // the way is refused rather than assembled.
    if (bytes > COPY_TEXT_MAX_BYTES) throw new Error("over-cap");
    parts.push(slice);
  }).catch((error: unknown) => (error instanceof Error && error.message === "over-cap" ? undefined : Promise.reject(error)));
  if (!outcome) return { ok: false, message: TOO_LARGE_TO_COPY };
  if (outcome.bytes !== outcome.totalBytes) return { ok: false, message: SHORT };
  if (!outcome.verified) return { ok: false, message: CORRUPT };
  const copied = await writeText(parts.join(""));
  parts.length = 0;
  return copied ? { ok: true, bytes: outcome.bytes } : { ok: false, message: "The clipboard did not take it. Try Download instead." };
}

export const TOO_LARGE_TO_COPY = "This is too large to copy here. Download it as a file instead.";

interface WritableLike { write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
interface SavePicker {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable(): Promise<WritableLike> }>;
}

/**
 * Save the whole body as a text file. Where the window can write a file as a
 * stream, slices go straight to disk; otherwise they are folded into a `Blob`
 * as they arrive (the browser keeps that out of the script heap) and the blob
 * is handed to a download.
 */
export async function downloadWhole(source: Source, suggestedName: string): Promise<TransferOutcome> {
  const options = { environmentKey: source.environmentKey, ...(source.revisionOf ? { revisionOf: source.revisionOf } : {}) };
  const picker = (globalThis as SavePicker).showSaveFilePicker;
  if (typeof picker === "function") {
    let writable: WritableLike;
    try {
      const handle = await picker({ suggestedName, types: [{ description: "Text", accept: { "text/plain": [".txt"] } }] });
      writable = await handle.createWritable();
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") return { ok: false, cancelled: true };
      return blobDownload(source, options, suggestedName);
    }
    try {
      const outcome = await streamBody(source.request, source.path, source.ref, options, slice => writable.write(slice));
      if (outcome.bytes !== outcome.totalBytes || !outcome.verified) {
        await writable.abort().catch(() => {});
        return { ok: false, message: outcome.verified ? SHORT : CORRUPT };
      }
      await writable.close();
      return { ok: true, bytes: outcome.bytes };
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }
  return blobDownload(source, options, suggestedName);
}

async function blobDownload(source: Source, options: { environmentKey: string; revisionOf?: RevisionRequest }, suggestedName: string): Promise<TransferOutcome> {
  let blob = new Blob([], { type: "text/plain;charset=utf-8" });
  let pending: string[] = [];
  let pendingBytes = 0;
  const fold = (): void => {
    if (pending.length === 0) return;
    blob = new Blob([blob, ...pending], { type: "text/plain;charset=utf-8" });
    pending = [];
    pendingBytes = 0;
  };
  const outcome = await streamBody(source.request, source.path, source.ref, options, (slice) => {
    const size = utf8ByteLength(slice);
    if (pendingBytes + size > FOLD_BYTES) fold();
    pending.push(slice);
    pendingBytes += size;
  });
  fold();
  if (outcome.bytes !== outcome.totalBytes) return { ok: false, message: SHORT };
  if (!outcome.verified) return { ok: false, message: CORRUPT };
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // The download has taken its own reference by now; the window lets go.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return { ok: true, bytes: outcome.bytes };
}

/** A file name a person would recognise, from the tool or the body's noun. */
export function outputFileName(base: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return `${slug || "output"}.txt`;
}
