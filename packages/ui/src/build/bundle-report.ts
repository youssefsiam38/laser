/**
 * What is in the bundle, from the bundle itself (M16-T31).
 *
 * A build answers "what does the first paint have to download" only if
 * somebody can read the entry chunk module by module. Rollup already knows:
 * every chunk carries the rendered length of each module it absorbed. So this
 * plugin writes that down rather than adding a dependency to draw it.
 *
 *   LASERCODE_BUNDLE_REPORT=1 pnpm -F @lasercode/ui build
 *
 * writes `dist-report/bundle.json` (machine-readable, every chunk and module)
 * and `dist-report/bundle.md` (the entry chunk's biggest modules, the chunk
 * table, and which lazy chunks the entry pulls in eagerly). The directory is
 * git-ignored and the plugin is inert without the flag, so a normal build is
 * byte-identical whether or not this file exists.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { ENV_PREFIX, PRODUCT_NAME } from "@lasercode/protocol";

/** The environment variable that turns the report on. */
export const BUNDLE_REPORT_ENV = `${ENV_PREFIX}_BUNDLE_REPORT`;

/** Where the report lands, relative to the package root. */
export const BUNDLE_REPORT_DIR = "dist-report";

interface ModuleSize {
  /** Module id, made relative to the repository root where possible. */
  id: string;
  bytes: number;
}

interface ChunkReport {
  file: string;
  isEntry: boolean;
  bytes: number;
  /** Static imports of this chunk: they load with it, always. */
  imports: string[];
  modules: ModuleSize[];
}

/** `node_modules/.pnpm/katex@0.18.5/node_modules/katex/dist/katex.mjs` → `katex/dist/katex.mjs`. */
const readable = (id: string, root: string): string => {
  const withoutQuery = id.split("?")[0] ?? id;
  const fromPnpm = withoutQuery.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(.+)$/);
  if (fromPnpm?.[1]) return fromPnpm[1];
  const rel = relative(root, withoutQuery);
  return rel.startsWith("..") ? withoutQuery : rel;
};

/** The npm package (or workspace directory) a module belongs to. */
const owner = (id: string): string => {
  const scoped = id.match(/^(@[^/]+\/[^/]+)/);
  if (scoped?.[1]) return scoped[1];
  const first = id.split("/")[0] ?? id;
  if (first === "packages" || first === "src") return id.split("/").slice(0, 3).join("/");
  return first;
};

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");

export function bundleReport(): Plugin {
  const enabled = process.env[BUNDLE_REPORT_ENV] === "1";
  let root = process.cwd();
  return {
    name: `${PRODUCT_NAME}:bundle-report`,
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      if (!enabled) return;
      const chunks: ChunkReport[] = [];
      for (const [file, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        const modules = Object.entries(output.modules)
          .map(([id, module]) => ({ id: readable(id, root), bytes: module.renderedLength }))
          .filter((module) => module.bytes > 0)
          .sort((a, b) => b.bytes - a.bytes);
        chunks.push({
          file,
          isEntry: output.isEntry,
          bytes: Buffer.byteLength(output.code),
          imports: [...output.imports],
          modules,
        });
      }
      chunks.sort((a, b) => b.bytes - a.bytes);
      const entry = chunks.find((chunk) => chunk.isEntry);

      const dir = resolve(root, BUNDLE_REPORT_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "bundle.json"), `${JSON.stringify({ chunks }, null, 2)}\n`);

      const lines: string[] = ["# Bundle report", ""];
      if (entry) {
        const eager = new Set<string>();
        const walk = (file: string) => {
          if (eager.has(file)) return;
          eager.add(file);
          for (const next of chunks.find((chunk) => chunk.file === file)?.imports ?? []) walk(next);
        };
        walk(entry.file);
        const eagerBytes = [...eager].reduce((sum, file) => sum + (chunks.find((chunk) => chunk.file === file)?.bytes ?? 0), 0);
        lines.push(
          `Entry chunk \`${entry.file}\`: ${kib(entry.bytes)}.`,
          "",
          `First paint loads ${eager.size} script chunk(s), ${kib(eagerBytes)} together:`,
          "",
          ...[...eager].map((file) => `- \`${file}\` — ${kib(chunks.find((chunk) => chunk.file === file)?.bytes ?? 0)}`),
          "",
          "## Entry chunk, top 25 modules",
          "",
          table(
            ["Module", "Size"],
            entry.modules.slice(0, 25).map((module) => [`\`${module.id}\``, kib(module.bytes)]),
          ),
          "",
          "## Entry chunk, by package",
          "",
          table(
            ["Package", "Size", "Modules"],
            [
              ...entry.modules
                .reduce((totals, module) => {
                  const key = owner(module.id);
                  const previous = totals.get(key) ?? { bytes: 0, count: 0 };
                  totals.set(key, { bytes: previous.bytes + module.bytes, count: previous.count + 1 });
                  return totals;
                }, new Map<string, { bytes: number; count: number }>())
                .entries(),
            ]
              .sort((a, b) => b[1].bytes - a[1].bytes)
              .slice(0, 30)
              .map(([name, total]) => [`\`${name}\``, kib(total.bytes), String(total.count)]),
          ),
          "",
        );
      }
      lines.push(
        "## Chunks over 40 KiB",
        "",
        table(
          ["Chunk", "Size", "Entry"],
          chunks.filter((chunk) => chunk.bytes > 40 * 1024).map((chunk) => [`\`${chunk.file}\``, kib(chunk.bytes), chunk.isEntry ? "yes" : ""]),
        ),
        "",
      );
      writeFileSync(resolve(dir, "bundle.md"), `${lines.join("\n")}\n`);
      this.warn(`bundle report written to ${relative(dirname(root), dir)}`);
    },
  };
}
