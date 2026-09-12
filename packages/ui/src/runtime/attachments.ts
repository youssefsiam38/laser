import { SimpleImageAttachmentAdapter, type AttachmentAdapter } from "@assistant-ui/react";
import { toast } from "sonner";
import type { ContentBlock, ImageContent, ProjectFileContent } from "@lasercode/protocol";

import type { ThreadComposerRuntime } from "@assistant-ui/react";

/** Restore accepted prompt content as prose plus attachments, appending without losing a draft. */
export async function appendAttachedPrompt(composer: Pick<ThreadComposerRuntime, "setText" | "addAttachment"> & { getState(): { text: string } }, content: string | readonly ContentBlock[]): Promise<void> {
  const rawText = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
  const { text, files } = splitAttachedFiles(rawText);
  const current = composer.getState().text;
  if (text) composer.setText(current ? `${current}\n${text}` : text);
  await Promise.all([
    ...files.map(file => composer.addAttachment({ id: crypto.randomUUID(), type: "document", name: file.name, contentType: file.mediaType, content: [{ type: "text", text: wrapFileAttachment(file) }] })),
    ...imagesOfContent(content).map((image, index) => composer.addAttachment({ id: crypto.randomUUID(), type: "image", name: `Image ${index + 1}`, contentType: image.mimeType, content: [{ type: "image", image: `data:${image.mimeType};base64,${image.data}` }] })),
  ]);
}

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
  return Array.isArray(content) ? content.filter((part): part is ImageContent => part?.type === "image" && typeof part.mimeType === "string" && part.mimeType.startsWith("image/") && typeof part.data === "string") : [];
}

/** Text uploads: browsers often omit MIME types for source files. */
export function attachmentMediaType(type: string, name: string): string | undefined {
  const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (["application/pdf", "application/zip"].includes(base)) return undefined;
  const markdownName = /\.(md|markdown|mdx)$/i.test(name);
  const specificNonMarkdown = ["application/octet-stream", "text/x-diff", "text/x-patch", "application/x-patch"].includes(base);
  if (/^text\/(markdown|x-markdown|md)$/.test(base) || (markdownName && !specificNonMarkdown)) return "text/markdown";
  if (base.startsWith("text/") || /^application\/(json|xml|yaml|toml|x-patch)$/.test(base) || /\+(json|xml|yaml)$/.test(base)) return base;
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  const types: Record<string, string> = { md: "text/markdown", markdown: "text/markdown", json: "application/json", yaml: "application/yaml", yml: "application/yaml", toml: "application/toml", diff: "text/x-diff", patch: "text/x-patch" };
  if (types[extension]) return types[extension];
  if (/^(txt|csv|tsv|xml|html|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|go|rs|sh|bash|zsh|java|c|h|cpp|hpp|rb|php|sql|svelte|vue|ini|conf|log|mdx)$/.test(extension) || /^(readme|license|dockerfile|makefile)$/i.test(name)) return "text/plain";
  return undefined;
}

/**
 * Stateless and shared by every thread: assistant-ui only reads `accept` and
 * calls `add`/`send`/`remove`, and a stable identity keeps `capabilities` from
 * churning on each render.
 */
/** Images retain the native adapter; bounded text files become canonical prompt text. */
export class ConversationAttachmentAdapter implements AttachmentAdapter {
  accept = "*";
  private images = new SimpleImageAttachmentAdapter();
  async add({ file }: { file: File }) {
    if (file.type.startsWith("image/")) return this.images.add({ file });
    const refuse = (message: string): never => { toast.error(message); throw new Error(message); };
    const mediaType = attachmentMediaType(file.type, file.name);
    if (!mediaType) return refuse("This file format can’t be attached. Attach an image or a text file instead.");
    if (file.size > MAX_ATTACHMENT_BYTES) return refuse(ATTACHMENT_SIZE_MESSAGE);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
    catch { return refuse("This file isn’t UTF-8 text. Save a text copy and attach it again."); }
    if (content.includes("\0")) return refuse("Binary files can’t be attached. Attach an image or a text file instead.");
    return { id: crypto.randomUUID(), type: "document" as const, name: file.name, contentType: mediaType, file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
      content: [{ type: "text" as const, text: wrapFileAttachment({ name: file.name, mediaType, size: new TextEncoder().encode(content).length, content }) }] };
  }
  async send(attachment: Parameters<AttachmentAdapter["send"]>[0]) {
    if (attachment.type === "image") return this.images.send(attachment);
    return { ...attachment, status: { type: "complete" as const }, content: attachment.content ?? [] };
  }
  async remove() { /* Files remain owned by the browser; there is no upload to delete. */ }
}
