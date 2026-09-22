/**
 * L0 · assets: icons, images, fonts and the i18n catalogues.
 *
 * Asset files are inventory, not text: a `.svg` or a `.woff2` is counted and
 * named, never opened. Icon libraries come from the manifest (see
 * `l0-stack.ts`) or from a directory of `.svg` files; fonts come from
 * `@font-face`, from a font directory and from a stylesheet import; i18n comes
 * from the catalogue files a project keeps its copy in — the place its voice
 * is actually written down.
 */
import { factId, type DesignFact, type L0Result, type SourceFile } from "./facts.js";
import type { ScannedFile } from "./scan.js";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|ico)$/i;
const FONT = /\.(woff2?|ttf|otf|eot)$/i;
const ICON_DIRECTORY = /(^|\/)(icons?|svgs?|symbols)(\/|$)/i;

interface Bucket {
  count: number;
  bytes: number;
  sample: string;
}

function bucket(map: Map<string, Bucket>, key: string, file: ScannedFile): void {
  const existing = map.get(key) ?? { count: 0, bytes: 0, sample: file.path };
  existing.count += 1;
  existing.bytes += file.bytes;
  map.set(key, existing);
}

function directoryOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

/**
 * The asset inventory of a whole scan: one fact per directory that holds
 * assets of a kind, with counts and a sample path. Directories, not files,
 * because "where the icons live" is the fact a designer needs.
 */
export function assetFacts(files: readonly ScannedFile[]): DesignFact[] {
  const icons = new Map<string, Bucket>();
  const images = new Map<string, Bucket>();
  const fonts = new Map<string, Bucket>();
  for (const file of files) {
    if (file.kind !== "asset") continue;
    const directory = directoryOf(file.path);
    if (/\.svg$/i.test(file.path)) {
      if (ICON_DIRECTORY.test(directory)) bucket(icons, directory, file);
      else bucket(images, directory, file);
      continue;
    }
    if (IMAGE.test(file.path)) bucket(images, directory, file);
    else if (FONT.test(file.path)) bucket(fonts, directory, file);
  }

  const facts: DesignFact[] = [];
  const emit = (map: Map<string, Bucket>, kind: "icon" | "asset" | "font", label: string): void => {
    for (const [directory, entry] of [...map].sort((left, right) => right[1].count - left[1].count).slice(0, 40)) {
      facts.push({
        id: factId(kind, `${label}:${directory}`, directory),
        kind,
        name: directory,
        value: String(entry.count),
        detail: { form: label, files: String(entry.count), kilobytes: String(Math.round(entry.bytes / 1024)), sample: entry.sample },
        source: { path: directory, digest: "", startLine: 1, endLine: 1, excerpt: `${String(entry.count)} ${label} files` },
        confidence: "observed",
      });
    }
  };
  emit(icons, "icon", "icon directory");
  emit(images, "asset", "image directory");
  emit(fonts, "font", "font directory");
  return facts;
}

const I18N_PATH = /(^|\/)(locales?|lang|translations?|i18n|config\/locales)(\/|$)/i;

/** Whether a file is an i18n catalogue worth reading the keys of. */
export function isI18nPath(path: string): boolean {
  return I18N_PATH.test(path) && /\.(json|ya?ml)$/i.test(path);
}

/**
 * An i18n catalogue: the locale, how many keys it carries, and a sample of
 * the copy — the project's voice, as the project wrote it.
 */
export function parseI18nCatalogue(file: SourceFile): L0Result {
  const locale = (file.path.split("/").pop() ?? file.path).replace(/\.(json|ya?ml)$/i, "");
  let keys = 0;
  const samples: string[] = [];
  if (file.path.endsWith(".json")) {
    try {
      const parsed: unknown = JSON.parse(file.text);
      const walk = (node: unknown, depth: number): void => {
        if (depth > 8 || node === null || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (typeof value === "string") {
            keys += 1;
            if (samples.length < 8 && value.length > 2) samples.push(`${key}: ${value.slice(0, 80)}`);
          } else walk(value, depth + 1);
        }
      };
      walk(parsed, 0);
    } catch {
      return { facts: [], gaps: [{ path: file.path, reason: "this translation file is not valid JSON, so its copy is not in the index." }] };
    }
  } else {
    file.lines.forEach((line) => {
      const entry = /^\s{2,}([\w.-]+)\s*:\s*(.+)$/.exec(line);
      if (!entry) return;
      keys += 1;
      if (samples.length < 8) samples.push(`${entry[1] ?? ""}: ${(entry[2] ?? "").replace(/^["']|["']$/g, "").slice(0, 80)}`);
    });
  }
  if (keys === 0) return { facts: [], gaps: [{ path: file.path, reason: "this translation file holds no readable keys." }] };
  return {
    facts: [
      {
        id: factId("i18n", locale, file.path),
        kind: "i18n",
        name: locale,
        value: String(keys),
        detail: { keys: String(keys), sample: samples.join(" · ").slice(0, 600) },
        source: { path: file.path, digest: file.digest, startLine: 1, endLine: Math.min(file.lines.length, 1), excerpt: samples[0] ?? "" },
        confidence: "declared",
      },
    ],
    gaps: [],
  };
}
