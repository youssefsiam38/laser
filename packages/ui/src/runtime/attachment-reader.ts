/**
 * Reading one file out of a prompt this window does not hold (RP-5b §2).
 *
 * The authority names the attachments inside a prompt; this reads one of them
 * back — its **stored** bytes, at one revision, in bounded slices, verified as
 * a whole against the digest that authority published — and only then undoes
 * the canonical escaping to give the file's own text. It also asks for the
 * pages of that naming, and falls back to finding them in the body itself when
 * an authority has never heard of the question.
 */
import { ATTACHMENT_MAX_BYTES, BODY_REGION_MAX_ITEMS, BODY_REGION_METADATA_MAX_BYTES, createAttachmentScanner, sameBodyComponent, utf8ByteLength, type AttachmentRegions, type ClientRequests } from "@lasercode/protocol";

import type { BodyRef } from "./body-excerpt.js";
import { BODY_SLICE_BYTES, BodyReplyRefused, BodyRevisionFence, DIGEST, checkRangeReply, streamBody, type RangeRequest, type RevisionRequest } from "./body-reader.js";
import { Sha256Stream } from "./sha256.js";

/**
 * Read one attachment out of a prompt this window does not hold (RP-5b §2).
 *
 * The region names the **stored, escaped** bytes of the file inside the
 * prompt's own byte space, so that is what is asked for, slice by slice, at one
 * revision, and that is what is hashed. Nothing is shown until the whole region
 * has been reconstructed and its digest is the one the authority published for
 * it; only then is the canonical escaping undone to give the file's own text.
 *
 * Bounded twice: a file is never larger than {@link ATTACHMENT_MAX_BYTES}
 * decoded, and the stored form is at most six times that — which this refuses
 * to exceed rather than reading on.
 */
export async function readAttachment(
  request: RangeRequest,
  path: string,
  ref: BodyRef & { entryId: string; region: { offset: number; bytes: number } },
  options: { environmentKey?: string; revision?: string; revisionOf?: RevisionRequest; signal?: { aborted: boolean } } = {},
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; reason: "short" | "corrupt" | "too-large" | "malformed" }> {
  if (!Number.isSafeInteger(ref.region.offset) || !Number.isSafeInteger(ref.region.bytes) || ref.region.bytes < 0) {
    return { ok: false, reason: "malformed" };
  }
  if (ref.region.bytes > ATTACHMENT_STORED_MAX_BYTES) return { ok: false, reason: "too-large" };
  const revisions = new BodyRevisionFence(path, ref.revision ?? options.revision, ref.contentDigest, options.revisionOf);
  const running = new Sha256Stream();
  const parts: string[] = [];
  let bytes = 0;
  let offset = ref.region.offset;
  let seenTotal: number | undefined = ref.totalBytes;
  let seenAuthority: "live" | "durable" | undefined;
  let digest: string | undefined = ref.contentDigest;
  for (;;) {
    if (options.signal?.aborted) return { ok: false, reason: "short" };
    const reply = await revisions.read(async (revision) => checkRangeReply(
      await request({
        path,
        environmentKey: options.environmentKey ?? "",
        revision,
        entryId: ref.entryId,
        component: ref.component,
        offset,
        limit: BODY_SLICE_BYTES,
        region: ref.region,
      }),
      { revision, entryId: ref.entryId, component: ref.component, offset, limit: BODY_SLICE_BYTES, totalBytes: seenTotal, region: ref.region, regionDigest: digest, ...(seenAuthority ? { authority: seenAuthority } : {}) },
    ), () => !options.signal?.aborted);
    seenTotal = reply.totalBytes;
    seenAuthority = reply.authority;
    digest = reply.regionDigest ?? digest;
    running.updateText(reply.text);
    parts.push(reply.text);
    bytes += reply.bytes;
    if (bytes > ATTACHMENT_STORED_MAX_BYTES) return { ok: false, reason: "too-large" };
    if (reply.next === undefined) break;
    offset = reply.next;
  }
  if (bytes !== ref.region.bytes) return { ok: false, reason: "short" };
  // The stored bytes are this file's, whole, before anything is shown.
  if (digest === undefined || running.digest() !== digest) return { ok: false, reason: "corrupt" };
  const stored = parts.join("");
  const text = unescapeAttachment(stored);
  if (text.includes("\0")) return { ok: false, reason: "malformed" };
  if (utf8ByteLength(text) > ATTACHMENT_MAX_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true, text, bytes: utf8ByteLength(text) };
}

/**
 * Ask an authority what attachments a body has, and if it has never heard of
 * the question, work it out from the body itself (RP-5b §2).
 *
 * The fallback is deliberately narrow: only a refusal that means "this
 * authority does not know about attachment regions" — an unknown method, or
 * invalid params naming that capability — leads to it. A stale regions page
 * may also fall back only when the body has an original digest, because the
 * range stream can prove that identity; authorization, digest and network
 * failures remain final.
 *
 * The fallback itself holds nothing: the parent is streamed through ordinary
 * range replies, each one verified, into the shared recogniser, which keeps a
 * bounded carry and never the body.
 */
export async function readAttachmentRegions(
  regions: (params: ClientRequests["session/entry_regions"]["params"]) => Promise<ClientRequests["session/entry_regions"]["result"]>,
  request: RangeRequest,
  path: string,
  ref: BodyRef & { entryId: string },
  options: { environmentKey?: string; revisionOf?: RevisionRequest; from?: number; limit?: number; signal?: { aborted: boolean } } = {},
): Promise<AttachmentRegions> {
  const revision = ref.revision ?? (options.revisionOf ? await options.revisionOf(path) : "");
  try {
    const page = await regions({
      path,
      environmentKey: options.environmentKey ?? "",
      revision,
      entryId: ref.entryId,
      component: ref.component,
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    return checkRegionsPage(page, {
      revision,
      component: ref.component,
      totalBytes: ref.totalBytes,
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  } catch (error) {
    const stale = (error as { code?: number } | null)?.code === -32007;
    // A regions page carries item digests but no whole-body digest echo, so it
    // cannot safely cross revisions itself. On a stale page, scan the body
    // through digest-fenced range replies instead. Digestless refs still fail.
    if (!lacksRegionSupport(error) && !(stale && options.revisionOf && ref.contentDigest && DIGEST.test(ref.contentDigest))) throw error;
  }
  // An authority from before this existed, or a stale regions page: read the
  // body and look, holding a bounded carry and nothing else.
  const scanner = createAttachmentScanner(
    () => { const running = new Sha256Stream(); return { update: (chunk: string) => running.updateText(chunk), digest: () => running.digest() }; },
    {
      // One page, bounded exactly as the authority's own page is: this never
      // returns an unbounded list of everything it found.
      ...(options.limit !== undefined ? { maxItems: options.limit } : {}),
      ...(options.from !== undefined ? { from: options.from } : {}),
    },
  );
  const outcome = await streamBody(request, path, ref, options, (slice) => { scanner.push(slice); });
  const found = scanner.end();
  // The parent was verified as a whole before anything found in it is used.
  if (!outcome.verified) throw new BodyReplyRefused("content-digest");
  return found;
}

/**
 * Everything about a page of attachments that can be checked before a person is
 * shown it: that it is the body and revision that was asked about, that every
 * number is a safe integer naming a part of that body, that the items are in
 * order and do not overlap, that each digest is a digest, that a cursor
 * strictly advances, and that the page is the size a page may be.
 */
export function checkRegionsPage(
  page: ClientRequests["session/entry_regions"]["result"],
  expected: { revision: string; component: BodyRef["component"]; totalBytes: number; from?: number; limit?: number },
): AttachmentRegions {
  const fail = (detail: string): never => { throw new BodyReplyRefused(detail); };
  if (page.revision !== expected.revision) fail("revision");
  if (!sameBodyComponent(page.component, expected.component)) fail("component");
  if (page.authority !== "live" && page.authority !== "durable") fail("authority");
  if (!Number.isSafeInteger(page.totalBytes) || page.totalBytes !== expected.totalBytes) fail("total");
  if (!Array.isArray(page.items)) fail("items");
  if (page.items.length > Math.min(expected.limit ?? BODY_REGION_MAX_ITEMS, BODY_REGION_MAX_ITEMS)) fail("over-limit");
  if (utf8ByteLength(JSON.stringify(page.items)) > BODY_REGION_METADATA_MAX_BYTES) fail("over-metadata");
  let previousEnd = expected.from ?? 0;
  for (const item of page.items) {
    if (!Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.bytes) || item.offset < 0 || item.bytes < 0) fail("region-bounds");
    const end = item.offset + item.bytes;
    if (!Number.isSafeInteger(end) || end > page.totalBytes) fail("region-past-end");
    if (item.offset < previousEnd && item.offset !== previousEnd) fail("region-order");
    if (typeof item.contentDigest !== "string" || !DIGEST.test(item.contentDigest)) fail("region-digest-shape");
    if (typeof item.name !== "string" || typeof item.mediaType !== "string") fail("region-shape");
    previousEnd = end;
  }
  if (page.next !== undefined) {
    if (!Number.isSafeInteger(page.next) || page.next > page.totalBytes) fail("next");
    // A cursor that does not move is a loop, not a page.
    if (expected.from !== undefined && page.next <= expected.from) fail("next-not-monotonic");
    if (page.items.length > 0 && page.next <= page.items[0]!.offset) fail("next-behind");
  }
  if (page.truncated && page.omitted !== undefined) fail("count-claimed");
  if (page.omitted !== undefined && (!Number.isSafeInteger(page.omitted) || page.omitted < 0)) fail("omitted");
  if (!Number.isSafeInteger(page.scannedBytes) || page.scannedBytes < 0) fail("scanned");
  return {
    items: page.items,
    ...(page.omitted !== undefined ? { omitted: page.omitted } : {}),
    ...(page.truncated ? { truncated: page.truncated } : {}),
    ...(page.next !== undefined ? { next: page.next } : {}),
    scannedBytes: page.scannedBytes,
  };
}

/** Whether a refusal means "this authority has no attachment regions". */
function lacksRegionSupport(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  if (code === -32601) return true; // unknown method
  return code === -32602 && /entry_regions|unknown (?:field|param)|unrecognized key/i.test(message);
}

/** The stored form of an attachment can be six times its decoded size. */
export const ATTACHMENT_STORED_MAX_BYTES = ATTACHMENT_MAX_BYTES * 6;

const ATTACHMENT_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#10": "\n", "#13": "\r", "#9": "\t" };

/** Undo exactly the escaping the composer applied, and nothing else. */
function unescapeAttachment(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#10|#13|#9);/g, (_, entity: string) => ATTACHMENT_ENTITIES[entity]!);
}
