import { instructionSourceMapSchema, type InstructionSourceMap, type InstructionSourceSpan } from "@lasercode/protocol";
import type { RequestField } from "./request-model.js";

const displayPath = (path: Array<string | number>) => path.map((key, i) => typeof key === "number" ? `[${key}]` : `${i ? "." : ""}${key}`).join("");

/** Same text projection as requestFieldText, retaining the actual JSON leaf paths.
 * No file access, fuzzy matching or inference from an AGENTS.md-looking string. */
function textLeaves(value: unknown, path: string): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((part, i) => textLeaves(part, `${path}[${i}]`));
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") return [{ path: `${path}.text`, text: object.text }];
  const key = object.content != null ? "content" : "parts";
  return textLeaves(object[key], `${path}.${key}`);
}

export async function requestSourceSpans(field: RequestField, maps: InstructionSourceMap[]): Promise<InstructionSourceSpan[]> {
  // Logs can contain legacy or malformed metadata despite their static type.
  const validated = maps.flatMap(map => {
    const parsed = instructionSourceMapSchema.safeParse(map);
    return parsed.success ? [parsed.data] : [];
  });
  const spans: InstructionSourceSpan[] = [];
  let offset = 0;
  let index = 0;
  for (const leaf of textLeaves(field.value, field.path)) {
    if (index++) {
      spans.push({ start: offset, end: offset + 2, source: { kind: "agent", origin: "engine", label: "Text block separator", inline: true } });
      offset += 2;
    }
    const map = validated.find(map => displayPath(map.path) === leaf.path);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(leaf.text));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    let cursor = 0;
    const valid = map?.sha256 === hash && map.spans.every(span => {
      const ok = Number.isInteger(span.start) && Number.isInteger(span.end) && span.start === cursor && span.end > span.start && span.end <= leaf.text.length;
      cursor = span.end;
      return ok;
    }) && cursor === leaf.text.length;
    const ranges = valid && map ? map.spans : [{ start: 0, end: leaf.text.length, source: { kind: "unrecorded" as const, origin: "unrecorded" as const, inline: true as const, label: "Not recorded" } }];
    spans.push(...ranges.filter(span => span.end > span.start).map(span => ({ ...span, start: span.start + offset, end: span.end + offset })));
    offset += leaf.text.length;
  }
  return spans;
}
