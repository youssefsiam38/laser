import type { ImageContent, ProjectFileContent } from "@lasercode/protocol";

export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const ATTACHMENT_SIZE_MESSAGE = "Files up to 256 KB can be attached; larger ones stay in the project — mention them with @";
export interface AttachedFile { name: string; mediaType: string; size: number; content: string }
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const escapeAttribute = (text: string) => escape(text).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");
const unescape = (text: string) => text.replace(/&(amp|lt|gt|quot|#10|#13|#9);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#10": "\n", "#13": "\r", "#9": "\t" })[entity]!);

/** Canonical, escaped UTF-8 text. Never HTML, never a filesystem identity. */
export function wrapFileAttachment(file: AttachedFile): string {
  return `<attached-file name="${escapeAttribute(file.name)}" type="${escapeAttribute(file.mediaType)}" size="${file.size}">\n${escape(file.content)}\n</attached-file>`;
}

/** Recognise only complete canonical wrappers separated from prose by blank lines. */
export function splitAttachedFiles(text: string): { text: string; files: AttachedFile[] } {
  const files: AttachedFile[] = [];
  const pattern = /(^|\n\n)(<attached-file name="([^"\n]*)" type="([^"\n]*)" size="(\d+)">\n([\s\S]*?)\n<\/attached-file>)(?=\n\n|$)/g;
  const rest = text.replace(pattern, (whole, _separator: string, wrapper: string, name: string, mediaType: string, size: string, content: string) => {
    const file = { name: unescape(name), mediaType: unescape(mediaType), size: Number(size), content: unescape(content) };
    if (!file.name || file.size > MAX_ATTACHMENT_BYTES || file.content.includes("\0") || new TextEncoder().encode(file.content).length !== file.size || wrapFileAttachment(file) !== wrapper) return whole;
    files.push(file);
    return "";
  });
  return { text: rest, files };
}

export function attachedFileContent(file: AttachedFile): ProjectFileContent {
  // name is only a format hint. An attachment has no path on the host.
  return { ...file, path: "", modifiedAt: "", encoding: "utf8", truncated: false };
}
export function imagesOfContent(content: unknown): ImageContent[] {
  return Array.isArray(content) ? content.filter((part): part is ImageContent => part?.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") : [];
}
