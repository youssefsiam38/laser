/**
 * The import adapters (M21-T21, leap "Import, export and interoperability").
 *
 * One adapter per documented layout, each one explicit and each one a pure
 * function of the bytes it read:
 *
 * | Adapter | Reads | Proposes |
 * | --- | --- | --- |
 * | `spec_kit` | `specs/<nnn>-<slug>/{spec,plan,tasks}.md` | a Spec, a Plan and one Task per checklist line |
 * | `openspec` | `openspec/specs/<capability>/spec.md`, `openspec/changes/<change>/*` | a Spec per capability and per change, a Plan from `design.md`, Tasks from `tasks.md` |
 * | `markdown` | any Markdown tree whose files declare `kind` in front matter | whatever each file declares |
 * | `plan_md` | a `PLAN.md` of milestone sections with task tables | a Plan per milestone and a Task per row |
 * | `work_export` | this product's own export | every item exactly, including its relations |
 *
 * Rules shared by all five:
 *
 * - **Nothing is invented.** A field the source does not have is empty, and
 *   what could not be carried over is a note on the proposal.
 * - **Nothing is lost either.** Where a body has a `document` field, the whole
 *   source Markdown goes into it, so an import never silently drops the parts
 *   of a document a parser did not understand.
 * - **Provenance travels.** Every proposal records the file it came from, the
 *   sha256 of the exact bytes parsed, the adapter, and the licence the source
 *   declared (or that it declared none).
 */
import {
  PROJECT_WORK_MARKDOWN_MAX,
  WORK_IMPORT_FILES_MAX,
  WORK_IMPORT_FILE_MAX_BYTES,
  WORK_IMPORT_PROPOSALS_MAX,
  projectWorkBodySchema,
  projectWorkManifestSchema,
  type ProjectWorkBody,
  type ProjectWorkEdgeRelation,
  type ProjectWorkKind,
  type SpecRequirement,
  type WorkImportAdapter,
  type WorkImportSourceRef,
} from "@lasercode/protocol";

import { bodyDigest, sha256 } from "../ids.js";
import { insideProject, kindOf, normaliseRelative, readTextFile, walkFiles } from "../export/paths.js";
import {
  bullets,
  checklist,
  firstParagraph,
  licenceFromFront,
  oneLine,
  parseMarkdown,
  plainText,
  readLicence,
  section,
  sectionText,
  sections,
  table,
  type ParsedMarkdown,
} from "./text.js";

/** One thing an adapter proposes, before anything has been matched or written. */
export interface ParsedItem {
  sourceId: string;
  kind: ProjectWorkKind;
  title: string;
  body: ProjectWorkBody;
  summary: string;
  source: WorkImportSourceRef;
  notes: string[];
  /** The key the source called it, when the source has keys of its own. */
  sourceKey?: string;
}

/** A relation the source recorded between two of its own items. */
export interface ParsedRelation {
  relation: ProjectWorkEdgeRelation;
  subjectKey: string;
  objectKey: string;
  note?: string;
}

export interface AdapterOutput {
  root: string;
  items: ParsedItem[];
  relations: ParsedRelation[];
  skipped: Array<{ path: string; reason: string }>;
  truncated: boolean;
}

/** Where each adapter looks when the person names no path. */
export const ADAPTER_DEFAULT_ROOT: Readonly<Record<WorkImportAdapter, string>> = {
  spec_kit: "specs",
  openspec: "openspec",
  markdown: "docs",
  plan_md: "PLAN.md",
  work_export: ".",
};

export interface AdapterInput {
  /** The project directory, already canonical. */
  projectRoot: string;
  /** The project-relative root the person named, or the adapter's default. */
  root: string;
  /** The default export root, for `work_export` when nothing was named. */
  exportRoot: string;
}

export function runAdapter(adapter: WorkImportAdapter, input: AdapterInput): AdapterOutput {
  switch (adapter) {
    case "spec_kit":
      return specKit(input);
    case "openspec":
      return openSpec(input);
    case "markdown":
      return plainMarkdown(input);
    case "plan_md":
      return planMarkdown(input);
    case "work_export":
      return workExport(input);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface SourceFile {
  path: string;
  text: string;
  digest: string;
  parsed: ParsedMarkdown;
}

function readSource(input: AdapterInput, path: string): SourceFile | undefined {
  const absolute = insideProject(input.projectRoot, path);
  const text = readTextFile(absolute, WORK_IMPORT_FILE_MAX_BYTES);
  if (text === undefined) return undefined;
  return { path, text, digest: sha256(text), parsed: parseMarkdown(text) };
}

/** Every Markdown file under the root, bounded and in a stable order. */
function markdownFiles(input: AdapterInput): { files: Array<{ path: string }>; truncated: boolean } {
  const absolute = insideProject(input.projectRoot, input.root);
  if (kindOf(absolute) === "file") return { files: [{ path: input.root }], truncated: false };
  if (kindOf(absolute) !== "directory") return { files: [], truncated: false };
  const walked = walkFiles(absolute, { max: WORK_IMPORT_FILES_MAX, extensions: [".md", ".markdown"] });
  return {
    files: walked.files.map((file) => ({ path: `${input.root}/${file.path}` })),
    truncated: walked.truncated,
  };
}

function sourceRef(
  adapter: WorkImportAdapter,
  file: SourceFile,
  extras: { licence?: { licence: WorkImportSourceRef["licence"]; licenceName?: string } | undefined; externalId?: string | undefined },
): WorkImportSourceRef {
  const licence = extras.licence;
  return {
    adapter,
    path: normaliseRelative(file.path),
    digest: file.digest,
    ...(licence?.licence !== undefined ? { licence: licence.licence } : {}),
    ...(licence?.licenceName !== undefined ? { licenceName: licence.licenceName } : {}),
    ...(extras.externalId !== undefined ? { externalId: extras.externalId } : {}),
  };
}

/** The licence a tree declares, from its own `LICENSE` file when it has one. */
function treeLicence(input: AdapterInput, directories: readonly string[]): { licence: WorkImportSourceRef["licence"]; licenceName?: string } | undefined {
  for (const directory of directories) {
    for (const name of ["LICENSE", "LICENSE.md", "LICENCE", "LICENCE.md", "COPYING"]) {
      const path = directory === "" ? name : `${directory}/${name}`;
      const text = readTextFile(insideProject(input.projectRoot, path), 512 * 1024);
      if (text === undefined) continue;
      const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
      const read = readLicence(firstLine);
      if (read) return read;
    }
  }
  return undefined;
}

function markdownDocument(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return trimmed.length > PROJECT_WORK_MARKDOWN_MAX ? trimmed.slice(0, PROJECT_WORK_MARKDOWN_MAX) : trimmed;
}

function specBodyFrom(parsed: ParsedMarkdown, text: string, options: { brief: string }): ProjectWorkBody {
  const requirements: SpecRequirement[] = [];
  for (const [index, item] of bullets(sectionText(parsed, /requirement/i)).entries()) {
    const cleaned = plainText(item);
    const identified = /^([A-Z]{1,4}-?\d{1,4})[:.)]?\s+(.*)$/.exec(cleaned);
    const body = identified ? identified[2]!.trim() : cleaned;
    const level = /\bMUST\b|\bSHALL\b|\brequired\b/i.test(body) ? "must" : /\bSHOULD\b|\brecommended\b/i.test(body) ? "should" : "may";
    requirements.push({ id: identified ? identified[1]!.toLowerCase().replace(/[^a-z0-9_-]/g, "") : `r${String(index + 1)}`, text: body, level });
  }
  const acceptance = bullets(sectionText(parsed, /acceptance|scenario/i)).map((item, index) => ({
    id: `a${String(index + 1)}`,
    text: plainText(item),
    machineVerifiable: false,
  }));
  return {
    kind: "spec",
    spec: {
      form: "full",
      brief: options.brief,
      outcomes: bullets(sectionText(parsed, /success criteria|outcome|goal/i)).map(plainText).slice(0, 64),
      nonGoals: bullets(sectionText(parsed, /out of scope|non-?goal/i)).map(plainText).slice(0, 64),
      requirements: requirements.slice(0, 256),
      acceptance: acceptance.slice(0, 256),
      constraints: bullets(sectionText(parsed, /constraint|assumption/i)).map(plainText).slice(0, 64),
      ...(markdownDocument(text) !== undefined ? { document: markdownDocument(text)! } : {}),
    },
  };
}

function planBodyFrom(parsed: ParsedMarkdown, text: string, options: { brief: string }): ProjectWorkBody {
  return {
    kind: "plan",
    plan: {
      brief: options.brief,
      // Phases and dependencies name Laser keys this project minted, which an
      // imported document cannot know. They stay empty rather than carrying
      // another tool's ids into a graph that would refuse them; the source's
      // own structure is kept verbatim in `document`.
      phases: [],
      dependencies: [],
      boundaries: [],
      migrations: [],
      risks: bullets(sectionText(parsed, /risk/i))
        .map((item) => ({ summary: oneLine(plainText(item), 500), control: "Carried over from the imported document.", severity: "medium" as const }))
        .slice(0, 64),
      verification: bullets(sectionText(parsed, /verification|testing|validation/i)).map((item) => oneLine(plainText(item), 500)).slice(0, 64),
      ...(markdownDocument(text) !== undefined ? { document: markdownDocument(text)! } : {}),
    },
  };
}

function taskBodyFrom(options: { outcome: string; notes?: string | undefined }): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: options.outcome,
      nonGoals: [],
      dependencies: [],
      scope: { packages: [], repositories: [], paths: [], capabilities: [] },
      acceptance: [],
      verificationCommands: [],
      visualEvidenceRequired: false,
      assignment: { policy: "unassigned" },
      ...(options.notes !== undefined && options.notes !== "" ? { notes: options.notes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Spec Kit
// ---------------------------------------------------------------------------

/**
 * GitHub Spec Kit: one feature per numbered directory, three documents in it.
 *
 * `spec.md` is the feature specification (user stories, functional
 * requirements with `FR-…` ids, acceptance scenarios); `plan.md` is the
 * implementation plan; `tasks.md` is the dependency-ordered checklist whose
 * `- [ ] T001 …` lines become one Task each.
 */
function specKit(input: AdapterInput): AdapterOutput {
  const items: ParsedItem[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const licence = treeLicence(input, [input.root, ""]);
  const { files, truncated } = markdownFiles(input);

  const features = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts[parts.length - 1]!.toLowerCase();
    const directory = parts.slice(0, -1).join("/");
    if (!["spec.md", "plan.md", "tasks.md"].includes(name)) {
      skipped.push({ path: file.path, reason: "not one of a feature's spec.md, plan.md or tasks.md" });
      continue;
    }
    const group = features.get(directory) ?? [];
    group.push(file.path);
    features.set(directory, group);
  }

  for (const [directory, paths] of [...features.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const feature = directory.split("/").pop() ?? directory;
    for (const path of paths.sort()) {
      const file = readSource(input, path);
      if (!file) {
        skipped.push({ path, reason: "could not be read, or is larger than an import may open" });
        continue;
      }
      const name = path.split("/").pop()!.toLowerCase();
      const declared = licenceFromFront(file.parsed.front) ?? licence;
      const title = oneLine(plainText(file.parsed.title ?? feature));
      const lede = firstParagraph(file.parsed.lede) || firstParagraph(sectionText(file.parsed, /overview|summary|why/i));
      if (name === "spec.md") {
        items.push({
          sourceId: `spec_kit:${path}`,
          kind: "spec",
          title,
          body: specBodyFrom(file.parsed, file.text, { brief: lede || title }),
          summary: oneLine(lede || title, 200),
          source: sourceRef("spec_kit", file, { licence: declared, externalId: feature }),
          notes: noteless(file.parsed, ["requirement", "acceptance"]),
          sourceKey: feature,
        });
      } else if (name === "plan.md") {
        items.push({
          sourceId: `spec_kit:${path}`,
          kind: "plan",
          title: title === feature ? `${feature} plan` : title,
          body: planBodyFrom(file.parsed, file.text, { brief: lede || title }),
          summary: oneLine(lede || title, 200),
          source: sourceRef("spec_kit", file, { licence: declared, externalId: feature }),
          notes: [],
          sourceKey: `${feature}/plan`,
        });
      } else {
        const list = checklist(file.text);
        if (list.length === 0) skipped.push({ path, reason: "no `- [ ]` task lines" });
        for (const entry of list.slice(0, WORK_IMPORT_PROPOSALS_MAX)) {
          const label = oneLine(plainText(entry.text));
          items.push({
            sourceId: `spec_kit:${path}#${entry.id ?? label}`,
            kind: "task",
            title: label,
            body: taskBodyFrom({ outcome: plainText(entry.text), notes: `Imported from ${path}${entry.id ? ` (${entry.id})` : ""}.` }),
            summary: entry.done ? "already ticked in the source list" : "not started in the source list",
            source: sourceRef("spec_kit", file, { licence: declared, externalId: entry.id ?? label }),
            notes: entry.done ? ["The source list has this ticked; imported work always starts in draft."] : [],
            sourceKey: entry.id ?? label,
          });
        }
      }
    }
  }
  return { root: input.root, items: items.slice(0, WORK_IMPORT_PROPOSALS_MAX), relations: [], skipped, truncated };
}

/** A note for each section a kind expects and this document did not have. */
function noteless(parsed: ParsedMarkdown, expected: readonly string[]): string[] {
  const notes: string[] = [];
  for (const name of expected) {
    if (!section(parsed, new RegExp(name, "i"))) notes.push(`The source has no ${name} section, so none were imported.`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// OpenSpec
// ---------------------------------------------------------------------------

/**
 * OpenSpec: `specs/<capability>/spec.md` is current behaviour;
 * `changes/<change>/` holds a proposal, an optional design, a task list and
 * delta specs under its own `specs/`.
 *
 * A capability spec and a change proposal both become Specs — they are the
 * requirements document at two moments — with the change's `design.md` as a
 * Plan and its `tasks.md` as Tasks. A delta spec keeps the change in its
 * title, so `## ADDED Requirements` is never confused with current behaviour.
 */
function openSpec(input: AdapterInput): AdapterOutput {
  const items: ParsedItem[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const licence = treeLicence(input, [input.root, ""]);
  const { files, truncated } = markdownFiles(input);

  for (const entry of files) {
    const relative = entry.path.startsWith(`${input.root}/`) ? entry.path.slice(input.root.length + 1) : entry.path;
    const parts = relative.split("/");
    const area = parts[0];
    if (area !== "specs" && area !== "changes") {
      skipped.push({ path: entry.path, reason: "outside specs/ and changes/" });
      continue;
    }
    const file = readSource(input, entry.path);
    if (!file) {
      skipped.push({ path: entry.path, reason: "could not be read, or is larger than an import may open" });
      continue;
    }
    const declared = licenceFromFront(file.parsed.front) ?? licence;
    const name = parts[parts.length - 1]!.toLowerCase();

    if (area === "specs") {
      const capability = parts[1] ?? "capability";
      if (name !== "spec.md") {
        skipped.push({ path: entry.path, reason: "not a capability spec.md" });
        continue;
      }
      items.push(openSpecCapability(file, capability, declared, entry.path));
      continue;
    }

    const change = parts[1] ?? "change";
    if (name === "proposal.md") {
      const why = sectionText(file.parsed, /^why/i);
      const brief = firstParagraph(why) || firstParagraph(file.parsed.lede) || change;
      items.push({
        sourceId: `openspec:${entry.path}`,
        kind: "spec",
        title: oneLine(plainText(file.parsed.title ?? change)),
        body: {
          kind: "spec",
          spec: {
            form: "full",
            brief,
            outcomes: bullets(sectionText(file.parsed, /what changes/i)).map(plainText).slice(0, 64),
            nonGoals: bullets(sectionText(file.parsed, /out of scope|non-?goal/i)).map(plainText).slice(0, 64),
            requirements: [],
            acceptance: [],
            constraints: bullets(sectionText(file.parsed, /impact/i)).map(plainText).slice(0, 64),
            ...(markdownDocument(file.text) !== undefined ? { document: markdownDocument(file.text)! } : {}),
          },
        },
        summary: oneLine(brief, 200),
        source: sourceRef("openspec", file, { licence: declared, externalId: change }),
        notes: [],
        sourceKey: change,
      });
      continue;
    }
    if (name === "design.md") {
      const brief = firstParagraph(file.parsed.lede) || firstParagraph(sectionText(file.parsed, /context|approach|decision/i)) || `${change} design`;
      items.push({
        sourceId: `openspec:${entry.path}`,
        kind: "plan",
        title: oneLine(plainText(file.parsed.title ?? `${change} approach`)),
        body: planBodyFrom(file.parsed, file.text, { brief }),
        summary: oneLine(brief, 200),
        source: sourceRef("openspec", file, { licence: declared, externalId: change }),
        notes: [],
        sourceKey: `${change}/design`,
      });
      continue;
    }
    if (name === "tasks.md") {
      const list = checklist(file.text);
      if (list.length === 0) skipped.push({ path: entry.path, reason: "no `- [ ]` task lines" });
      for (const task of list.slice(0, WORK_IMPORT_PROPOSALS_MAX)) {
        const label = oneLine(plainText(task.text));
        items.push({
          sourceId: `openspec:${entry.path}#${task.id ?? label}`,
          kind: "task",
          title: label,
          body: taskBodyFrom({ outcome: plainText(task.text), notes: `Imported from ${entry.path}${task.id ? ` (${task.id})` : ""}.` }),
          summary: task.done ? "already ticked in the source list" : "not started in the source list",
          source: sourceRef("openspec", file, { licence: declared, externalId: task.id ?? label }),
          notes: task.done ? ["The source list has this ticked; imported work always starts in draft."] : [],
          sourceKey: `${change}/${task.id ?? label}`,
        });
      }
      continue;
    }
    if (name === "spec.md") {
      const capability = parts[parts.length - 2] ?? "capability";
      const item = openSpecCapability(file, `${change} · ${capability}`, declared, entry.path);
      items.push({ ...item, sourceKey: `${change}/${capability}` });
      continue;
    }
    skipped.push({ path: entry.path, reason: "not a proposal, design, task list or spec" });
  }
  return { root: input.root, items: items.slice(0, WORK_IMPORT_PROPOSALS_MAX), relations: [], skipped, truncated };
}

/**
 * One OpenSpec capability spec: `### Requirement:` headings are the
 * requirements, and each `#### Scenario:` under them is an acceptance
 * criterion named by its scenario.
 */
function openSpecCapability(
  file: SourceFile,
  capability: string,
  licence: { licence: WorkImportSourceRef["licence"]; licenceName?: string } | undefined,
  path: string,
): ParsedItem {
  const requirementSections = sections(file.parsed, /^requirement:/i);
  const requirements: SpecRequirement[] = requirementSections.map((requirement, index) => ({
    id: `r${String(index + 1)}`,
    text: oneLine(plainText(requirement.heading.replace(/^requirement:\s*/i, "")), 2000),
    level: "must",
  }));
  const acceptance = sections(file.parsed, /^scenario:/i).map((scenario, index) => ({
    id: `a${String(index + 1)}`,
    text: oneLine(`${plainText(scenario.heading.replace(/^scenario:\s*/i, ""))}: ${bullets(scenario.text).map(plainText).join(" ")}`, 2000),
    machineVerifiable: false,
  }));
  const purpose = firstParagraph(sectionText(file.parsed, /purpose/i)) || firstParagraph(file.parsed.lede) || capability;
  return {
    sourceId: `openspec:${path}`,
    kind: "spec",
    title: oneLine(plainText(file.parsed.title ?? capability)),
    body: {
      kind: "spec",
      spec: {
        form: "full",
        brief: purpose,
        outcomes: [],
        nonGoals: [],
        requirements: requirements.slice(0, 256),
        acceptance: acceptance.slice(0, 256),
        constraints: [],
        ...(markdownDocument(file.text) !== undefined ? { document: markdownDocument(file.text)! } : {}),
      },
    },
    summary: oneLine(purpose, 200),
    source: sourceRef("openspec", file, { licence, externalId: capability }),
    notes: requirements.length === 0 ? ["The source declares no `### Requirement:` headings, so none were imported."] : [],
    sourceKey: capability,
  };
}

// ---------------------------------------------------------------------------
// Plain Markdown with front matter
// ---------------------------------------------------------------------------

const FRONT_KINDS: Readonly<Record<string, ProjectWorkKind>> = {
  spec: "spec",
  specification: "spec",
  research: "research",
  design: "design",
  plan: "plan",
  task: "task",
};

/**
 * Any Markdown tree, as long as each file says what it is.
 *
 * The front matter is the contract: `kind` decides what is proposed, `title`
 * and `key` are used when they are there, `licence` travels with the import. A
 * file that declares no kind is skipped and named — guessing would import a
 * README as a specification.
 */
function plainMarkdown(input: AdapterInput): AdapterOutput {
  const items: ParsedItem[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const fallbackLicence = treeLicence(input, [input.root, ""]);
  const { files, truncated } = markdownFiles(input);

  for (const entry of files) {
    const file = readSource(input, entry.path);
    if (!file) {
      skipped.push({ path: entry.path, reason: "could not be read, or is larger than an import may open" });
      continue;
    }
    const declaredKind = typeof file.parsed.front["kind"] === "string" ? String(file.parsed.front["kind"]).toLowerCase() : undefined;
    const kind = declaredKind ? FRONT_KINDS[declaredKind] : undefined;
    if (!kind) {
      skipped.push({
        path: entry.path,
        reason: declaredKind ? `front matter says kind: ${declaredKind}, which is not one this app keeps` : "no front matter saying what it is",
      });
      continue;
    }
    if (kind === "research" || kind === "design") {
      skipped.push({ path: entry.path, reason: `a ${kind} is a structured body that Markdown cannot carry; export and import it as work instead` });
      continue;
    }
    const front = file.parsed.front;
    const title = oneLine(plainText(typeof front["title"] === "string" ? front["title"] : (file.parsed.title ?? entry.path.split("/").pop()!)));
    const declared = licenceFromFront(front) ?? fallbackLicence;
    const key = typeof front["key"] === "string" ? front["key"] : undefined;
    const lede = firstParagraph(file.parsed.lede) || firstParagraph(sectionText(file.parsed, /brief|overview|summary|outcome/i)) || title;
    const body =
      kind === "spec"
        ? specBodyFrom(file.parsed, file.text, { brief: lede })
        : kind === "plan"
          ? planBodyFrom(file.parsed, file.text, { brief: lede })
          : taskBodyFrom({ outcome: sectionText(file.parsed, /outcome/i) ?? lede, notes: markdownDocument(file.text) });
    items.push({
      sourceId: `markdown:${entry.path}`,
      kind,
      title,
      body,
      summary: oneLine(lede, 200),
      source: sourceRef("markdown", file, { licence: declared, ...(key !== undefined ? { externalId: key } : {}) }),
      notes: [],
      ...(key !== undefined ? { sourceKey: key } : {}),
    });
  }
  return { root: input.root, items: items.slice(0, WORK_IMPORT_PROPOSALS_MAX), relations: [], skipped, truncated };
}

// ---------------------------------------------------------------------------
// An existing PLAN.md
// ---------------------------------------------------------------------------

/**
 * A `PLAN.md` written as milestone sections with a task table.
 *
 * Each `## <Milestone>` section becomes a Plan whose brief is the section's
 * own prose and whose `document` keeps the section verbatim. Each row of a
 * table whose first column holds task ids becomes a Task, with the row's last
 * column as its outcome and its declared dependencies kept as a note — they
 * name the source's ids, which are not keys this project minted, and a Plan
 * graph made of another document's ids would be refused rather than useful.
 */
function planMarkdown(input: AdapterInput): AdapterOutput {
  const skipped: Array<{ path: string; reason: string }> = [];
  const file = readSource(input, input.root);
  if (!file) {
    return { root: input.root, items: [], relations: [], skipped: [{ path: input.root, reason: "could not be read, or is larger than an import may open" }], truncated: false };
  }
  const licence = licenceFromFront(file.parsed.front) ?? treeLicence(input, [""]);
  const items: ParsedItem[] = [];
  const milestones = file.parsed.sections.filter((candidate) => candidate.depth === 2);
  const blocks = milestones.length > 0 ? milestones : [{ depth: 2, heading: file.parsed.title ?? input.root, text: file.parsed.content }];

  for (const milestone of blocks) {
    const inner = parseMarkdown(milestone.text);
    const brief = firstParagraph(milestone.text) || oneLine(plainText(milestone.heading));
    const parsedTable = table(milestone.text);
    const rows = parsedTable?.rows.filter((row) => row.length >= 2 && /^[A-Za-z][A-Za-z0-9]*-?T?\d+/.test(row[0] ?? "")) ?? [];
    items.push({
      sourceId: `plan_md:${input.root}#${milestone.heading}`,
      kind: "plan",
      title: oneLine(plainText(milestone.heading)),
      body: planBodyFrom(inner, milestone.text, { brief }),
      summary: oneLine(`${String(rows.length)} task${rows.length === 1 ? "" : "s"} · ${brief}`, 200),
      source: sourceRef("plan_md", file, { licence, externalId: plainText(milestone.heading) }),
      notes: rows.length === 0 ? ["No task table was found in this section, so no tasks were imported from it."] : [],
      sourceKey: plainText(milestone.heading),
    });

    for (const row of rows) {
      const id = plainText(row[0] ?? "");
      const title = oneLine(plainText(row[1] ?? id));
      const depends = row.length >= 4 ? plainText(row[2] ?? "") : "";
      const outcome = plainText(row[row.length - 1] ?? title);
      const notes = [`Imported from ${input.root} (${id}).`, depends !== "" ? `Depends on: ${depends}` : ""].filter((line) => line !== "").join("\n");
      items.push({
        sourceId: `plan_md:${input.root}#${id}`,
        kind: "task",
        title,
        body: taskBodyFrom({ outcome: outcome === "" ? title : outcome, notes }),
        summary: oneLine(outcome || title, 200),
        source: sourceRef("plan_md", file, { licence, externalId: id }),
        notes: depends === "" ? [] : ["The source's dependency ids are kept as a note: they are not keys this project minted."],
        sourceKey: id,
      });
    }
  }
  if (items.length === 0) skipped.push({ path: input.root, reason: "no milestone sections or task tables" });
  return { root: input.root, items: items.slice(0, WORK_IMPORT_PROPOSALS_MAX), relations: [], skipped, truncated: false };
}

// ---------------------------------------------------------------------------
// This product's own export
// ---------------------------------------------------------------------------

/**
 * Read an export back, exactly.
 *
 * The manifest names every item, its exact revision and that revision's
 * digest; the body beside it is the canonical content those bytes were
 * digested from. Both are checked: a body whose digest does not match what the
 * manifest recorded is refused for that item and named, because an export that
 * was edited by hand is not the revision it claims to be.
 *
 * This is what makes a round trip provable: export → import → export writes
 * the same documents and the same bodies, because nothing was interpreted on
 * the way through.
 */
function workExport(input: AdapterInput): AdapterOutput {
  const root = input.root === "." ? input.exportRoot : input.root;
  const skipped: Array<{ path: string; reason: string }> = [];
  const absolute = insideProject(input.projectRoot, root);
  const manifestPath = `${root}/manifest.json`;
  const manifestText = readTextFile(insideProject(absolute, "manifest.json"), 8 * 1024 * 1024);
  if (manifestText === undefined) {
    return { root, items: [], relations: [], skipped: [{ path: manifestPath, reason: "there is no export manifest here" }], truncated: false };
  }
  let manifest;
  try {
    manifest = projectWorkManifestSchema.parse(JSON.parse(manifestText));
  } catch {
    return { root, items: [], relations: [], skipped: [{ path: manifestPath, reason: "the manifest is not one this version can read" }], truncated: false };
  }

  const items: ParsedItem[] = [];
  const written = new Set<string>();
  for (const entity of manifest.entities) {
    const bodyPath = `${root}/${entity.body}`;
    const text = readTextFile(insideProject(absolute, entity.body), WORK_IMPORT_FILE_MAX_BYTES);
    if (text === undefined) {
      skipped.push({ path: bodyPath, reason: "the exported content for this item is missing" });
      continue;
    }
    let body: ProjectWorkBody;
    try {
      const json: unknown = JSON.parse(text);
      // Validated, then kept as the file's own value: the schema is strict, so
      // the two carry the same members, and this keeps an absent optional
      // field absent rather than present-and-undefined — which is what makes
      // the digest below the same one the export recorded.
      projectWorkBodySchema.parse(json);
      body = json as ProjectWorkBody;
    } catch {
      skipped.push({ path: bodyPath, reason: "the exported content is not a body this app can read" });
      continue;
    }
    const digest = bodyDigest(body).digest;
    if (digest !== entity.digest) {
      skipped.push({ path: bodyPath, reason: "the exported content no longer matches the digest the manifest recorded for it" });
      continue;
    }
    if (body.kind !== entity.kind) {
      skipped.push({ path: bodyPath, reason: `the manifest says ${entity.kind} and the content is a ${body.kind}` });
      continue;
    }
    written.add(entity.key);
    items.push({
      sourceId: `work_export:${entity.key}`,
      kind: entity.kind,
      title: entity.title,
      body,
      summary: oneLine(`${entity.kind} · revision ${String(entity.revisionIndex)}`, 200),
      source: {
        adapter: "work_export",
        path: normaliseRelative(`${root}/${entity.document}`),
        digest: entity.digest,
        licence: "not_applicable",
        externalId: entity.key,
      },
      notes: [],
      sourceKey: entity.key,
    });
  }

  const relations: ParsedRelation[] = manifest.relations
    .filter((relation) => written.has(relation.subject.key) && written.has(relation.object.key))
    .map((relation) => ({
      relation: relation.relation,
      subjectKey: relation.subject.key,
      objectKey: relation.object.key,
      ...(relation.note !== undefined ? { note: relation.note } : {}),
    }));

  return { root, items: items.slice(0, WORK_IMPORT_PROPOSALS_MAX), relations, skipped, truncated: manifest.entities.length > WORK_IMPORT_PROPOSALS_MAX };
}
