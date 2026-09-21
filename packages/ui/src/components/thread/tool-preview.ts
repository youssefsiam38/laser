/**
 * Reading a tool result that is a **preview**: what the call *would* do, not
 * what it did.
 *
 * `docs/agent-tool-contract.md` §2 requires a preview before every external or
 * destructive write — `preview: true` answers with the effect and a digest,
 * and the write itself is a second call carrying `confirmed: true` and that
 * digest — and it requires that "the person's UI shows the same preview".
 * This file is the UI half of that: the exact result shape the transcript
 * recognises, written down once so the producers (M21-T17, M25-T4) can match
 * it. The rendering is `ToolPreviewRow.tsx`, which draws the same card the
 * person's git actions draw (`source-control/change-preview.tsx`).
 *
 * The shape, as published in `docs/leap/m26-plan.md` "M26-T4":
 *
 * ```jsonc
 * {
 *   "preview": true,                       // the literal boolean, required
 *   "digest": "b8f0c1a4e93d5f17",         // opaque, required; the confirming call repeats it
 *   "summary": "Export SPEC-12 revision 4 to the tracker as a new issue.",
 *   "target": "acme/laser",               // optional: where it would land
 *   "branch": "main",                     // optional
 *   "remote": "origin",                   // optional
 *   "items": ["SPEC-12", "TASK-44"],      // optional: what it would write
 *   "confirmWith": "export_project_work"  // optional: the tool that takes the digest back
 * }
 * ```
 *
 * It is read from the result's `details` (a Laser tool's declared output), or
 * from the result object itself, or from JSON in the result text — a stored
 * transcript keeps whichever of those the session had. Nothing here trusts the
 * payload: every string is clamped, the list is bounded, and a field of the
 * wrong type is dropped rather than rendered.
 */

import { resultDetails, resultText } from "./tool-summary.js";

/** A digest is opaque: a bounded, printable token, never a path or a sentence. */
export const TOOL_PREVIEW_DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const TOOL_PREVIEW_SUMMARY_MAX = 400;
export const TOOL_PREVIEW_VALUE_MAX = 200;
export const TOOL_PREVIEW_ITEM_MAX = 400;
/** How many items are read out of the payload at all; the card paints fewer. */
export const TOOL_PREVIEW_ITEMS_MAX = 200;

/** A preview a transcript row can draw, with every field already bounded. */
export interface ToolPreview {
  /** The token the confirming call has to carry back. */
  readonly digest: string;
  /** One sentence of the exact effect, written for a person. */
  readonly summary: string;
  /** Where it would land: a repository, a project, a host. */
  readonly target?: string;
  readonly branch?: string;
  readonly remote?: string;
  /** What it would write: paths, keys, ids. */
  readonly items: readonly string[];
  /** The tool that takes the digest back, when it is not the one that previewed. */
  readonly confirmWith?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clamp = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

/** One candidate object read as a preview, or `undefined` when it is not one. */
export function readToolPreview(value: unknown): ToolPreview | undefined {
  if (!isRecord(value) || value["preview"] !== true) return undefined;
  const digest = clamp(value["digest"], TOOL_PREVIEW_VALUE_MAX);
  const summary = clamp(value["summary"], TOOL_PREVIEW_SUMMARY_MAX);
  // Without a digest there is nothing to confirm with, and without a sentence
  // there is nothing to show a person. Either missing and this is an ordinary
  // result, drawn the ordinary way.
  if (!digest || !TOOL_PREVIEW_DIGEST_PATTERN.test(digest) || !summary) return undefined;
  const target = clamp(value["target"], TOOL_PREVIEW_VALUE_MAX);
  const branch = clamp(value["branch"], TOOL_PREVIEW_VALUE_MAX);
  const remote = clamp(value["remote"], TOOL_PREVIEW_VALUE_MAX);
  const confirmWith = clamp(value["confirmWith"], TOOL_PREVIEW_VALUE_MAX);
  const raw = Array.isArray(value["items"]) ? value["items"] : [];
  const items = raw
    .slice(0, TOOL_PREVIEW_ITEMS_MAX)
    .map((item) => clamp(item, TOOL_PREVIEW_ITEM_MAX))
    .filter((item): item is string => item !== undefined);
  return {
    digest,
    summary,
    ...(target ? { target } : {}),
    ...(branch ? { branch } : {}),
    ...(remote ? { remote } : {}),
    ...(confirmWith ? { confirmWith } : {}),
    items,
  };
}

/**
 * The preview a tool result carries, if it carries one: from the result's
 * declared output (`details`), from the result object itself, or from JSON in
 * its text.
 */
export function toolPreview(result: unknown): ToolPreview | undefined {
  if (result === undefined || result === null) return undefined;
  const fromDetails = readToolPreview(resultDetails(result));
  if (fromDetails) return fromDetails;
  const direct = readToolPreview(result);
  if (direct) return direct;
  const text = resultText(result);
  // A preview is small and structured; a body big enough to be paged is not
  // one, and parsing megabytes to find out would cost more than it can return.
  if (!text || text.length > 64_000 || !text.trimStart().startsWith("{")) return undefined;
  try {
    return readToolPreview(JSON.parse(text));
  } catch {
    return undefined;
  }
}
