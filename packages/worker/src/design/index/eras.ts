/**
 * Eras — the named layers of a UI codebase.
 *
 * Most real projects are not one design system; they are two or three, laid
 * down at different times and still shipping. A design composed from the wrong
 * one looks foreign the day it lands, so the index names the layers and says
 * which one new work belongs in (`docs/design-phase.md`, "The Design Index").
 *
 * The detection is deliberately conservative and entirely static: candidate
 * roots are the places a project keeps a UI (workspace packages, top-level
 * folders, `app/views`, `resources/views`), each root's signals are the facts
 * found *under* it, and two roots with the same signature are one era. Naming
 * them well is L1's job; here they get honest names built from their own
 * signals, and a single-stack project gets exactly one era.
 */
import { stableId, type DesignFact } from "./facts.js";
import type { ScannedFile } from "./scan.js";

/** One detected era, before review. */
export interface EraCandidate {
  id: string;
  name: string;
  roots: string[];
  useForNewWork: boolean;
  /** What made it an era: framework and styling names, class vocabulary. */
  signals: string[];
  /** The L0 facts this era was detected from. */
  factIds: string[];
  /** Why it is (or is not) the era for new work, in a sentence for a person. */
  reason: string;
}

/** Class vocabularies that name an older era loudly. */
const LEGACY_CLASS_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(btn|btn-[a-z0-9-]+)$/, "Bootstrap"],
  [/^col-(xs|sm|md|lg|xl)-\d+$/, "Bootstrap grid"],
  [/^(navbar|panel|jumbotron|well|form-control|input-group)(-[a-z0-9-]+)?$/, "Bootstrap"],
  [/^(pure-|foundation-|uk-)/, "legacy framework"],
];

const MODERN_FRAMEWORKS = ["React", "Vue", "Svelte", "SvelteKit", "Angular", "Solid", "Next.js", "Nuxt", "Remix", "Lit"];
const LEGACY_FRAMEWORKS = ["jQuery", "Alpine", "Rails", "Laravel", "Symfony"];

function rootOf(path: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (root === ".") {
      best ??= root;
      continue;
    }
    if ((path === root || path.startsWith(`${root}/`)) && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * Where a UI could live: every directory holding a manifest, plus the template
 * roots of the server-rendered stacks, plus the project root as a fallback.
 */
export function candidateRoots(files: readonly ScannedFile[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const name = file.path.split("/").pop() ?? file.path;
    const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
    if (name === "package.json" || name === "Gemfile" || name === "composer.json") roots.add(directory);
    const templates = /^(app\/views|resources\/views|templates|app\/assets|src)(\/|$)/.exec(file.path);
    if (templates) roots.add(templates[1] ?? "");
  }
  roots.add(".");
  return [...roots].sort((left, right) => left.length - right.length);
}

interface RootSignals {
  frameworks: Set<string>;
  styling: Set<string>;
  legacyClasses: Set<string>;
  factIds: string[];
  components: number;
  templates: number;
}

function emptySignals(): RootSignals {
  return { frameworks: new Set(), styling: new Set(), legacyClasses: new Set(), factIds: [], components: 0, templates: 0 };
}

/** Group the facts under each candidate root. */
function signalsByRoot(facts: readonly DesignFact[], roots: readonly string[]): Map<string, RootSignals> {
  const byRoot = new Map<string, RootSignals>();
  for (const fact of facts) {
    const root = rootOf(fact.source.path, roots) ?? ".";
    const signals = byRoot.get(root) ?? emptySignals();
    byRoot.set(root, signals);
    if (fact.kind === "stack") {
      const role = fact.detail?.["role"];
      if (role === "framework") signals.frameworks.add(fact.name);
      if (role === "styling") signals.styling.add(fact.name);
      if (role === "framework" || role === "styling") signals.factIds.push(fact.id);
      continue;
    }
    if (fact.kind === "component") {
      signals.components += 1;
      const framework = fact.detail?.["framework"];
      if (framework !== undefined && framework !== "JavaScript") signals.frameworks.add(framework);
      continue;
    }
    if (fact.kind === "template") {
      signals.templates += 1;
      continue;
    }
    if (fact.kind === "class-vocabulary") {
      for (const [pattern, label] of LEGACY_CLASS_SIGNALS) {
        if (!pattern.test(fact.name)) continue;
        signals.legacyClasses.add(label);
        if (signals.factIds.length < 64) signals.factIds.push(fact.id);
        break;
      }
    }
  }
  return byRoot;
}

function signatureOf(signals: RootSignals): string {
  return [[...signals.frameworks].sort().join("+"), [...signals.styling].sort().join("+"), [...signals.legacyClasses].sort().join("+")].join("|");
}

function nameFor(signals: RootSignals, root: string): string {
  const legacy = [...signals.legacyClasses][0];
  const framework = [...signals.frameworks].find((entry) => MODERN_FRAMEWORKS.includes(entry)) ?? [...signals.frameworks][0];
  const styling = [...signals.styling][0];
  if (framework !== undefined && styling !== undefined) return `${framework} + ${styling}`;
  if (framework !== undefined) return framework;
  if (legacy !== undefined) return `${legacy} templates`;
  if (styling !== undefined) return `${styling} styles`;
  return root === "." ? "the project's UI" : root;
}

/**
 * The eras of one build.
 *
 * `useForNewWork` is a proposal, not a verdict: a person confirms it in review
 * (`review.ts`), and only one era can hold it at a time.
 */
export function detectEras(facts: readonly DesignFact[], files: readonly ScannedFile[]): EraCandidate[] {
  const roots = candidateRoots(files);
  const byRoot = signalsByRoot(facts, roots);

  // Roots that carry no UI signal at all are not eras.
  const meaningful = [...byRoot].filter(([, signals]) =>
    signals.frameworks.size > 0 || signals.styling.size > 0 || signals.legacyClasses.size > 0 || signals.components > 0 || signals.templates > 0,
  );
  if (meaningful.length === 0) return [];

  // A manifest at the project root describes every root under it: a React
  // dependency declared once at the top is React in `src`, not a second era
  // of its own. Its signals are folded into the roots that hold the UI — and
  // only into those, so a folder that had nothing to say does not acquire an
  // era's worth of signals by being next to a manifest.
  const projectWide = byRoot.get(".");
  if (projectWide && meaningful.some(([root]) => root !== ".")) {
    for (const [root, signals] of meaningful) {
      if (root === ".") continue;
      for (const framework of projectWide.frameworks) signals.frameworks.add(framework);
      for (const styling of projectWide.styling) signals.styling.add(styling);
      for (const id of projectWide.factIds) if (signals.factIds.length < 64) signals.factIds.push(id);
    }
  }

  const grouped = new Map<string, { roots: string[]; signals: RootSignals }>();
  for (const [root, signals] of meaningful) {
    const signature = signatureOf(signals);
    const existing = grouped.get(signature);
    if (existing) {
      existing.roots.push(root);
      existing.signals.components += signals.components;
      existing.signals.templates += signals.templates;
      for (const id of signals.factIds) if (existing.signals.factIds.length < 64) existing.signals.factIds.push(id);
      continue;
    }
    grouped.set(signature, { roots: [root], signals });
  }

  // The root "." usually restates what a package root already said. Keep it
  // only when it is the sole era, or when it has signals of its own.
  const entries = [...grouped.values()];
  const withoutBareRoot = entries.filter((entry) => !(entry.roots.length === 1 && entry.roots[0] === "." && entries.length > 1 && entry.signals.components === 0 && entry.signals.templates === 0));
  const candidates = withoutBareRoot.length > 0 ? withoutBareRoot : entries;

  const scored = candidates.map((entry) => {
    const modern = [...entry.signals.frameworks].some((framework) => MODERN_FRAMEWORKS.includes(framework));
    const legacy = entry.signals.legacyClasses.size > 0 || [...entry.signals.frameworks].some((framework) => LEGACY_FRAMEWORKS.includes(framework));
    const score = (modern ? 100 : 0) - (legacy ? 50 : 0) + entry.signals.components + Math.min(entry.signals.templates, 20);
    return { entry, score, modern, legacy };
  });
  const best = scored.reduce((winner, entry) => (entry.score > winner.score ? entry : winner), scored[0] as (typeof scored)[number]);

  return scored
    .sort((left, right) => right.score - left.score)
    .map(({ entry, modern, legacy }) => {
      const roots_ = [...entry.roots].sort();
      const name = nameFor(entry.signals, roots_[0] ?? ".");
      const signals = [...entry.signals.frameworks, ...entry.signals.styling, ...entry.signals.legacyClasses];
      const useForNewWork = entry === best.entry;
      return {
        id: stableId("era", ...roots_),
        name,
        roots: roots_,
        useForNewWork,
        signals,
        factIds: entry.signals.factIds.slice(0, 64),
        reason: useForNewWork
          ? modern
            ? `${name} is the newest stack in this project and holds most of its components, so new work belongs here until you say otherwise.`
            : `${name} is the only UI stack found in this project, so new work belongs here.`
          : legacy
            ? `${name} looks like an older layer that is still shipping; compose in it only when you are changing a page it already owns.`
            : `${name} is a second UI stack in this project; new work goes elsewhere unless you change that here.`,
      };
    });
}
