/**
 * Reading one bounded blob off a revision, in the window (M21-T13/T14).
 *
 * A sketch document and a foundation's token document are both stored as
 * blobs and both read the same way: page through `project/work/blob/read`
 * until the host says there is no next page, with a hard page budget so a
 * blob that keeps answering can never hold the window open. Nothing here
 * interprets the bytes — the caller decides what the text is.
 */

/** The single wire call this module needs, so a test can hand it a stub. */
export interface BlobRequest {
  request: <M extends "project/work/blob/read">(
    method: M,
    params: { projectId: string; blobId: string; offset?: number; limit?: number },
  ) => Promise<{ data?: string; nextOffset?: number; bytes: number; released?: { detail: string } }>;
}

/** What a read answers: the text, or the sentence saying why there is none. */
export type BlobReadOutcome = { ok: true; text: string } | { ok: false; message: string };

/**
 * A sketch is at most `SKETCH_MAX_BYTES`, which is one page; the budget is
 * for a foundation token document that grew past a page.
 */
export const BLOB_READ_MAX_PAGES = 8;

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function readBlob(client: BlobRequest, projectId: string, blobId: string): Promise<BlobReadOutcome> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let page = 0; page < BLOB_READ_MAX_PAGES; page += 1) {
    try {
      const result = await client.request("project/work/blob/read", { projectId, blobId, offset });
      if (result.released) return { ok: false, message: result.released.detail };
      if (result.data === undefined) return { ok: false, message: "This content is not stored on this machine." };
      chunks.push(decodeBase64(result.data));
      if (result.nextOffset === undefined) break;
      offset = result.nextOffset;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "This content could not be read." };
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
