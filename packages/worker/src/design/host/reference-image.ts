/**
 * Reference images for a host page — bounded, untrusted, never read (M21-T12).
 *
 * Two kinds, and the difference is the whole point
 * (`docs/design-phase.md`, "Grounding the host page"):
 *
 * | Kind | Where from | Fidelity |
 * | --- | --- | --- |
 * | `repository` | an image the project's own docs or stories reference | `mapped` |
 * | `supplied` | a screenshot the person pasted | `proposed` |
 *
 * A supplied image is **untrusted data**: it is bounded in size, its type is
 * sniffed from its first bytes rather than believed from its header, its
 * label is stripped to plain text, and nothing in Laser reads what is written
 * inside it. There is no OCR here and there must never be one: text lifted
 * out of a screenshot would be model-visible content of unknown origin, which
 * is the definition of an injection channel ("Security, privacy and
 * resources"). The image is a picture to lay a design over, nothing else.
 */
import type { HostReference } from "@lasercode/protocol";
import { digestOf } from "../index/facts.js";
import { basenameOf, dirnameOf, joinPath, normalisePath, type HostFiles } from "./files.js";

/** A pasted screenshot is bounded: a page capture, not an asset library. */
export const REFERENCE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const REFERENCE_IMAGE_MIN_BYTES = 32;
export const REFERENCE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;
export type ReferenceImageMediaType = (typeof REFERENCE_IMAGE_MEDIA_TYPES)[number];
export const REFERENCE_LABEL_MAX = 120;
/** How many repository images one grounding lists. */
export const REPOSITORY_REFERENCES_MAX = 8;

export interface SuppliedImage {
  bytes: Uint8Array;
  /** What the sender says it is. Checked against the bytes, never trusted. */
  mediaType?: string;
  label?: string;
  /** The blob the bytes were stored as, when the caller stored them. */
  blobId?: string;
}

export interface ReferenceAccepted {
  ok: true;
  reference: HostReference;
  /** sha256 of the bytes, so the same paste twice is the same reference. */
  digest: string;
  mediaType: ReferenceImageMediaType;
}

export interface ReferenceRefused {
  ok: false;
  code: "image_too_large" | "image_too_small" | "image_unreadable" | "image_type_mismatch";
  message: string;
  next: string;
}

export type ReferenceDecision = ReferenceAccepted | ReferenceRefused;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** What the bytes actually are. The declared type is only cross-checked. */
export function sniffImageType(bytes: Uint8Array): ReferenceImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 4))) return "image/avif";
  return undefined;
}

/** Plain, bounded text. A label is a caption, never an instruction. */
export function sanitiseReferenceLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = label.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat.slice(0, REFERENCE_LABEL_MAX);
}

/**
 * Take a person-supplied screenshot, or say why not. The refusal carries the
 * sentence a person reads and the call that would work.
 */
export function acceptSuppliedImage(input: SuppliedImage): ReferenceDecision {
  const bytes = input.bytes;
  if (bytes.length > REFERENCE_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      code: "image_too_large",
      message: `That image is ${String(Math.round(bytes.length / 1024))} KB and a reference screenshot is kept under ${String(REFERENCE_IMAGE_MAX_BYTES / 1024 / 1024)} MB, because it is only shown behind the design.`,
      next: "attach a smaller screenshot — a single page capture, not a full-resolution export",
    };
  }
  if (bytes.length < REFERENCE_IMAGE_MIN_BYTES) {
    return {
      ok: false,
      code: "image_too_small",
      message: "That file is too small to be an image.",
      next: "attach the screenshot again; if it keeps failing, save it as PNG first",
    };
  }
  const sniffed = sniffImageType(bytes);
  if (sniffed === undefined) {
    return {
      ok: false,
      code: "image_unreadable",
      message: `That file is not one of the image kinds a reference can be (${REFERENCE_IMAGE_MEDIA_TYPES.join(", ")}).`,
      next: "attach a PNG, JPEG, GIF, WebP or AVIF screenshot",
    };
  }
  const declared = input.mediaType?.split(";")[0]?.trim().toLowerCase();
  if (declared !== undefined && declared !== "" && declared !== sniffed) {
    return {
      ok: false,
      code: "image_type_mismatch",
      message: `That file says it is ${declared} but its contents are ${sniffed}. A reference image is taken at face value only when the two agree.`,
      next: "re-export the screenshot and attach it again",
    };
  }
  const label = sanitiseReferenceLabel(input.label);
  return {
    ok: true,
    digest: digestOf(Buffer.from(bytes).toString("base64")),
    mediaType: sniffed,
    reference: {
      kind: "supplied",
      ...(label !== undefined ? { label } : {}),
      ...(input.blobId !== undefined ? { blobId: input.blobId } : {}),
      mediaType: sniffed,
      bytes: bytes.length,
      // A picture of the page is evidence of nothing the parse can check.
      fidelity: "proposed",
    },
  };
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)$/i;
const DOC_EXTENSION = /\.(md|mdx|html|htm|stories\.(tsx|jsx|ts|js))$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

export interface RepositoryReferenceOptions {
  /** Words that tie a document to this page: its route, its template name. */
  mentions?: readonly string[];
  limit?: number;
}

/**
 * Screenshots the repository already refers to — the `mapped` kind. A
 * document counts when it mentions this page, so grounding `/orders` does not
 * drag in every image in `docs/`.
 */
export function repositoryReferences(files: HostFiles, options: RepositoryReferenceOptions = {}): HostReference[] {
  const limit = options.limit ?? REPOSITORY_REFERENCES_MAX;
  const mentions = (options.mentions ?? []).map((value) => value.toLowerCase()).filter((value) => value.length > 2);
  const found: HostReference[] = [];
  for (const path of files.paths) {
    if (found.length >= limit) break;
    if (!DOC_EXTENSION.test(path)) continue;
    const text = files.read(path);
    if (text === undefined) continue;
    const lower = text.toLowerCase();
    if (mentions.length > 0 && !mentions.some((mention) => lower.includes(mention))) continue;
    for (const [pattern, group, altGroup] of [
      [MARKDOWN_IMAGE, 2, 1],
      [HTML_IMAGE, 1, -1],
    ] as const) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null && found.length < limit) {
        const source = match[group];
        if (source === undefined || !IMAGE_EXTENSION.test(source) || /^(?:https?:)?\/\//.test(source)) continue;
        const resolved = [joinPath(dirnameOf(path), source), normalisePath(source)].find((candidate) => files.has(candidate));
        if (resolved === undefined || found.some((reference) => reference.path === resolved)) continue;
        const alt = altGroup === -1 ? undefined : sanitiseReferenceLabel(match[altGroup]);
        const mediaType = mediaTypeOf(resolved);
        found.push({
          kind: "repository",
          label: alt ?? basenameOf(resolved),
          path: resolved,
          ...(mediaType !== undefined ? { mediaType } : {}),
          // Parsed out of the repository, like the template itself.
          fidelity: "mapped",
        });
      }
    }
  }
  return found;
}

function mediaTypeOf(path: string): ReferenceImageMediaType | undefined {
  const extension = IMAGE_EXTENSION.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    default:
      return undefined;
  }
}
