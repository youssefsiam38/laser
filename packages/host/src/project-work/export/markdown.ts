/**
 * One entity, as deterministic Markdown (M21-T21).
 *
 * The rules, all of them load-bearing:
 *
 * - **The same revision always renders to the same bytes.** Nothing here reads
 *   a clock, a locale or a random value, and every list keeps the order the
 *   body stores it in. Two exports of unchanged work are byte-identical, which
 *   is what makes a re-export a diff a person can read.
 * - **No timestamps in the document.** `createdAt` and `updatedAt` are facts
 *   about the store, not about the work; putting them in the file would make
 *   every export a change. The identity that matters — the revision id and the
 *   digest of the canonical body — is in the front matter and in the manifest.
 * - **The document is for a person; the body is for a machine.** Markdown is a
 *   deliberately lossy view of a closed body (a design tree does not become
 *   prose), so the export writes the exact canonical body beside it under
 *   `bodies/`, and re-importing an export reads that. The Markdown never has
 *   to be invertible to be honest.
 * - **Nothing executable, nothing injected.** Only text the body already
 *   validated is written, with the front matter's values JSON-encoded, so a
 *   title with a colon or a quote cannot break the header it sits in.
 */
import type {
  DesignBody,
  PlanBody,
  ProjectTaskBody,
  ProjectWorkBody,
  ProjectWorkEdge,
  ProjectWorkEntity,
  ProjectWorkRevision,
  RepositoryLink,
  ResearchBody,
  SpecBody,
} from "@lasercode/protocol";

/** What a document is rendered from. Everything is already fenced to `revision`. */
export interface DocumentInput {
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  body: ProjectWorkBody;
  /** Edges where this entity is the subject, in a stable order. */
  edges: ProjectWorkEdge[];
  /** Repository links of this entity, in a stable order. */
  repositoryLinks: RepositoryLink[];
  /** `entityId` → key, so a link reads as `TASK-3` and not as an opaque id. */
  keyOf: (entityId: string) => string | undefined;
}

class Document {
  private readonly parts: string[] = [];

  section(heading: string, render: (out: Document) => void): void {
    const inner = new Document();
    render(inner);
    const text = inner.text();
    if (text === "") return;
    this.parts.push(`## ${heading}\n\n${text}`);
  }

  paragraph(text: string | undefined): void {
    const trimmed = (text ?? "").trim();
    if (trimmed === "") return;
    this.parts.push(trimmed);
  }

  /** A raw Markdown block a person wrote. Never re-wrapped, never escaped away. */
  markdown(text: string | undefined): void {
    this.paragraph(text);
  }

  bullets(items: readonly string[]): void {
    const lines = items.map((item) => `- ${oneLine(item)}`).filter((line) => line !== "- ");
    if (lines.length === 0) return;
    this.parts.push(lines.join("\n"));
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    if (rows.length === 0) return;
    const head = `| ${headers.join(" | ")} |`;
    const rule = `| ${headers.map(() => "---").join(" | ")} |`;
    const body = rows.map((row) => `| ${row.map((cell) => oneLine(cell).replace(/\|/g, "\\|")).join(" | ")} |`);
    this.parts.push([head, rule, ...body].join("\n"));
  }

  text(): string {
    return this.parts.filter((part) => part !== "").join("\n\n");
  }
}

/** A value on one line: a body's text may wrap, a bullet may not. */
function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").trim();
}

/** A front-matter value, always JSON-encoded so nothing can break the header. */
function frontMatterValue(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * The document for one entity: front matter, a title, then the kind's own
 * sections, then its links.
 */
export function renderDocument(input: DocumentInput): string {
  const { entity, revision, body } = input;
  const front: Array<[string, string | number | boolean]> = [
    ["key", entity.key],
    ["kind", entity.kind],
    ["title", entity.title],
    ["state", entity.state],
    ["revision", revision.index],
    // The digest of the canonical body, and deliberately **not** the revision
    // id: the id is this store's, the digest is the content's. A document that
    // carried the id could not be byte-identical after a round trip through
    // another project, and identity belongs in the manifest either way.
    ["digest", revision.digest],
  ];
  if (entity.archivedAt !== undefined) front.push(["archived", true]);

  const document = new Document();
  switch (body.kind) {
    case "spec":
      renderSpec(document, body.spec);
      break;
    case "research":
      renderResearch(document, body.research);
      break;
    case "design":
      renderDesign(document, body.design);
      break;
    case "plan":
      renderPlan(document, body.plan);
      break;
    case "task":
      renderTask(document, body.task);
      break;
  }
  renderLinks(document, input);

  const header = front.map(([name, value]) => `${name}: ${frontMatterValue(value)}`).join("\n");
  const title = `# ${entity.key} · ${oneLine(entity.title)}`;
  const parts = [`---\n${header}\n---`, title, document.text()].filter((part) => part !== "");
  return `${parts.join("\n\n")}\n`;
}

function renderSpec(out: Document, spec: SpecBody): void {
  out.section("Brief", (section) => section.paragraph(spec.brief));
  out.section("Problem", (section) => section.paragraph(spec.problem));
  out.section("Outcomes", (section) => section.bullets(spec.outcomes));
  out.section("Non-goals", (section) => section.bullets(spec.nonGoals));
  out.section("Requirements", (section) =>
    section.bullets(spec.requirements.map((requirement) => `**${requirement.level}** ${requirement.text}`)),
  );
  out.section("Acceptance", (section) =>
    section.bullets(spec.acceptance.map((criterion) => `[${criterion.machineVerifiable ? "automated" : "person"}] ${criterion.text}`)),
  );
  out.section("Constraints", (section) => section.bullets(spec.constraints));
  out.section("Form", (section) => section.paragraph(spec.gated === true ? `${spec.form} · gated` : spec.form));
  out.section("Document", (section) => section.markdown(spec.document));
}

function renderResearch(out: Document, research: ResearchBody): void {
  out.section("Question", (section) => section.paragraph(research.question));
  out.section("Status", (section) => section.paragraph(research.status));
  out.section("Scope", (section) => {
    section.bullets(research.scope.in.map((item) => `in: ${item}`));
    section.bullets(research.scope.out.map((item) => `out: ${item}`));
    section.bullets(research.scope.constraints.map((item) => `constraint: ${item}`));
  });
  out.section("Questions", (section) =>
    section.table(
      ["Question", "State", "Answer"],
      research.questions.map((question) => [question.text, question.state, question.answer ?? ""]),
    ),
  );
  out.section("Findings", (section) =>
    section.table(
      ["Claim", "Confidence", "Source", "Licence"],
      research.findings.map((finding) => [finding.claim, finding.confidence, finding.source.title, finding.licence]),
    ),
  );
  out.section("Sources", (section) =>
    section.table(
      ["Title", "Kind", "Trust", "Found through"],
      research.sources.map((source) => [source.title, source.kind, source.trust, source.fetchedVia]),
    ),
  );
  out.section("Unresolved", (section) => section.bullets(research.unresolved.map((item) => `${item.fact} — ${item.wouldSettleIt}`)));
}

function renderDesign(out: Document, design: DesignBody): void {
  out.section("Brief", (section) => section.paragraph(design.brief));
  out.section("Fidelity", (section) => section.paragraph(design.fidelity));
  out.section("Strategy", (section) =>
    section.paragraph(design.strategy ? `${design.strategy.kind}: ${design.strategy.reason}` : undefined),
  );
  out.section("Screens", (section) =>
    section.table(
      ["Screen", "Fidelity", "Content"],
      design.screens.map((screen) => [
        screen.name,
        screen.fidelity,
        "tree" in screen.content ? `${String(screen.content.tree.nodes.length)} nodes` : `sketch ${screen.content.sketchId}`,
      ]),
    ),
  );
  out.section("Flows", (section) =>
    section.bullets(design.flows.map((flow) => `${flow.fromScreenId} — ${flow.trigger} → ${describeAction(flow.action)}`)),
  );
  out.section("Sketches", (section) =>
    section.table(["Sketch", "Bytes", "Digest"], design.sketches.map((sketch) => [sketch.title, String(sketch.bytes), sketch.digest])),
  );
}

function renderPlan(out: Document, plan: PlanBody): void {
  out.section("Brief", (section) => section.paragraph(plan.brief));
  out.section("Phases", (section) =>
    section.table(
      ["Phase", "Tasks", "Summary"],
      plan.phases.map((phase) => [phase.name, phase.taskKeys.join(", "), phase.summary ?? ""]),
    ),
  );
  out.section("Dependencies", (section) =>
    section.bullets(plan.dependencies.map((dependency) => `${dependency.from} → ${dependency.to}${dependency.reason ? ` — ${dependency.reason}` : ""}`)),
  );
  out.section("Boundaries", (section) => section.bullets(plan.boundaries.map((boundary) => `${boundary.scope} — ${boundary.rule}`)));
  out.section("Migrations", (section) =>
    section.bullets(plan.migrations.map((migration) => `${migration.summary} — ${migration.reversible ? "reversible" : "not reversible"}`)),
  );
  out.section("Risks", (section) => section.bullets(plan.risks.map((risk) => `[${risk.severity}] ${risk.summary} — ${risk.control}`)));
  out.section("Verification", (section) => section.bullets(plan.verification));
  out.section("Rollback", (section) => section.paragraph(plan.rollback));
  out.section("Document", (section) => section.markdown(plan.document));
}

function renderTask(out: Document, task: ProjectTaskBody): void {
  out.section("Outcome", (section) => section.paragraph(task.outcome));
  out.section("Non-goals", (section) => section.bullets(task.nonGoals));
  out.section("Dependencies", (section) => section.bullets(task.dependencies));
  out.section("Scope", (section) => {
    const scope: string[] = [];
    if (task.scope.packages.length > 0) scope.push(`packages: ${task.scope.packages.join(", ")}`);
    if (task.scope.repositories.length > 0) scope.push(`repositories: ${task.scope.repositories.join(", ")}`);
    if (task.scope.paths.length > 0) scope.push(`paths: ${task.scope.paths.join(", ")}`);
    if (task.scope.capabilities.length > 0) scope.push(`capabilities: ${task.scope.capabilities.join(", ")}`);
    if (task.scope.sharedWith && task.scope.sharedWith.length > 0) scope.push(`shared with: ${task.scope.sharedWith.join(", ")}`);
    section.bullets(scope);
  });
  out.section("Acceptance", (section) =>
    section.bullets(
      task.acceptance.map(
        (criterion) => `[${criterion.machineVerifiable ? "automated" : "person"}] ${criterion.text}${criterion.command ? ` \`${criterion.command}\`` : ""}`,
      ),
    ),
  );
  out.section("Verification", (section) => section.bullets(task.verificationCommands.map((command) => `\`${command}\``)));
  out.section("Assignment", (section) =>
    section.paragraph(task.assignment.policy === "agent" ? `agent: ${task.assignment.agentName}` : task.assignment.policy),
  );
  out.section("Plan", (section) => section.paragraph(task.planKey));
  out.section("Notes", (section) => section.markdown(task.notes));
}

/** A flow's action, as one readable phrase. Never a JSON blob in a document. */
function describeAction(action: DesignBody["flows"][number]["action"]): string {
  switch (action.type) {
    case "navigate":
      return `navigate ${action.screenId}`;
    case "overlay":
      return `overlay ${action.screenId}`;
    case "close":
      return "close";
    case "setState":
      return `set ${action.nodeId} to ${action.state}`;
    case "setVariant":
      return `set ${action.nodeId} variant ${action.variant}`;
    case "switchTheme":
      return `switch theme to ${action.theme}`;
    case "switchViewport":
      return `switch viewport to ${action.viewport}`;
  }
}

/**
 * The links, as a person reads them: which other items this one is joined to,
 * and which repository states it is fenced to. The machine-readable form of
 * the same facts — with ids, digests and targets — is in the manifest.
 */
function renderLinks(out: Document, input: DocumentInput): void {
  out.section("Links", (section) => {
    section.bullets(
      input.edges.map((edge) => {
        const other = edge.subject.entityId === input.entity.entityId ? edge.object : edge.subject;
        const direction = edge.subject.entityId === input.entity.entityId ? "→" : "←";
        return `${edge.relation} ${direction} ${input.keyOf(other.entityId) ?? other.key}`;
      }),
    );
    section.bullets(
      input.repositoryLinks.map((link) => {
        const target = "state" in link.target ? link.target.state.commitObjectId : link.target.change.head.commitObjectId;
        return `${link.relation} ${target.slice(0, 12)}${link.publishedPath ? ` (${link.publishedPath})` : ""}`;
      }),
    );
  });
}
