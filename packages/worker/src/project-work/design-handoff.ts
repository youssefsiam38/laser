/**
 * `/design implement @Design` — the hand-off packet (D-354,
 * `docs/design-phase.md`, "`/design` — three forms").
 *
 * The third form of `/design` does not draw anything: it hands an approved
 * design to the session that is going to build it. What crosses is exactly
 * what the doc names — the tree, the index entries it was composed from, the
 * strategy, the host region, the fixtures and the comments nobody has
 * resolved — at **one exact revision**, pulled from the project's own record
 * rather than retyped by a model.
 *
 * The UI sends the command as the whole input of a prompt (T6), so the shape
 * this module recognises is the text itself: `/design implement DES-4`, with
 * the ref written as a key, an `@design:` mention chip's human form, or an
 * opaque entity id.
 */
import type { DesignBody, ProjectWorkGetResult } from "@lasercode/protocol";
import type { ProjectWorkBridge } from "./bridge.js";

/** The whole packet's ceiling. A hand-off that does not fit says so. */
export const DESIGN_HANDOFF_MAX = 8_000;
const SCREENS_MAX = 12;
const NODES_PER_SCREEN = 6;
const COMMENTS_MAX = 10;

/** `/design implement DES-4`, `/design implement @design:DES-4`, an entity id. */
export const DESIGN_IMPLEMENT_PATTERN = /^\s*\/design\s+implement\s+(.+?)\s*$/i;

/** The ref a `/design implement` command names, or undefined for another form. */
export function designImplementRef(input: string): string | undefined {
  const matched = DESIGN_IMPLEMENT_PATTERN.exec(input);
  if (!matched?.[1]) return undefined;
  // `@design:DES-4` and `@DES-4` are the mention chip's human forms.
  return matched[1].replace(/^@(?:design:)?/i, "").trim() || undefined;
}

export interface DesignHandoffPacket {
  text: string;
  /** The exact revision the packet describes. */
  ref: { key: string; entityId: string; revisionId: string; digest: string };
  truncated: boolean;
}

/**
 * Build the packet for one design ref.
 *
 * Refuses nothing: a ref that names no design, or a design nobody can read,
 * comes back as `undefined` and the session simply runs the command as
 * ordinary text — the model then says it could not find it, which is a better
 * answer than a turn that will not start.
 */
export async function buildDesignHandoff(bridge: ProjectWorkBridge, ref: string): Promise<DesignHandoffPacket | undefined> {
  const projectId = bridge.projectId();
  if (projectId === undefined) return undefined;
  const byKey = /^[A-Z]+-\d+$/.test(ref);
  let read: ProjectWorkGetResult;
  try {
    read = (await bridge.call("project/work/get", {
      projectId,
      ...(byKey ? { key: ref } : { entityId: ref }),
      body: { mode: "full" as const },
      include: { comments: true, approvals: true, links: true },
    })) as ProjectWorkGetResult;
  } catch {
    return undefined;
  }
  const body = read.body?.body;
  if (!body || body.kind !== "design") return undefined;
  const design: DesignBody = body.design;

  const lines: string[] = [];
  let truncated = false;
  const approval = read.approvals.find((candidate) => candidate.decision === "approved" && candidate.invalidatedAt === undefined);
  lines.push(
    `# Implement ${read.entity.key} · ${read.entity.title}`,
    `[from ${read.entity.key} revision ${read.revision.revisionId}] digest ${read.revision.digest.slice(0, 12)}, state ${read.entity.state}` +
      `${approval ? `, ${approval.gate} gate approved` : ", not approved"}${read.entity.staleBecause ? `, stale since ${read.entity.staleBecause.upstreamKey} moved` : ""}.`,
    "Build exactly this revision. If something in it cannot be built as drawn, say so and leave a comment on the design instead of improvising.",
    "",
    "## Brief",
    `[from ${read.entity.key}] ${oneLine(design.brief, 500)}`,
  );

  lines.push("", "## Screens");
  for (const screen of design.screens.slice(0, SCREENS_MAX)) {
    const shape =
      "tree" in screen.content
        ? `${String(screen.content.tree.nodes.length)} nodes, root ${screen.content.tree.rootNodeId}`
        : `sketch ${screen.content.sketchId}`;
    const states = screen.states.filter((state) => state.included).map((state) => state.name);
    lines.push(
      `- ${screen.name} (${screen.fidelity}${screen.viewport ? `, ${screen.viewport}` : ""}${screen.theme ? `, ${screen.theme}` : ""}): ${shape}${states.length > 0 ? `; states ${states.join(", ")}` : ""}`,
    );
    if ("tree" in screen.content) {
      const named = screen.content.tree.nodes
        .slice(0, NODES_PER_SCREEN)
        .map((node) => `${node.id}:${"primitive" in node.component ? node.component.primitive : node.component.indexEntryId}`);
      lines.push(`  nodes: ${named.join(", ")}${screen.content.tree.nodes.length > NODES_PER_SCREEN ? ", …" : ""}`);
      if (screen.content.tree.nodes.length > NODES_PER_SCREEN) truncated = true;
    }
  }
  if (design.screens.length > SCREENS_MAX) {
    truncated = true;
    lines.push(`…and ${String(design.screens.length - SCREENS_MAX)} more screens; read them with inspect_project_work include body.`);
  }

  if (design.designIndexRef) {
    lines.push(
      "",
      "## Index entries used",
      `[from ${read.entity.key}] design index ${design.designIndexRef.indexId} revision ${design.designIndexRef.revisionId}` +
        `${design.designIndexRef.eraId ? `, era ${design.designIndexRef.eraId}` : ""}. Call inspect_design_index for the entries themselves.`,
    );
  }
  if (design.foundation?.principles.length) {
    lines.push("", "## Foundation", ...design.foundation.principles.slice(0, 8).map((principle) => `[from ${read.entity.key}] ${oneLine(principle, 200)}`));
  }
  if (design.strategy) {
    lines.push(
      "",
      "## Strategy",
      `[from ${read.entity.key}] ${design.strategy.kind}: ${oneLine(design.strategy.reason, 400)}`,
      ...(design.strategy.targetFiles.length > 0 ? [`target files: ${design.strategy.targetFiles.slice(0, 12).join(", ")}`] : []),
      ...(design.strategy.integrationContract ? [`contract: ${oneLine(design.strategy.integrationContract, 400)}`] : []),
    );
  }
  if (design.hostPage || design.insertionRegion) {
    lines.push(
      "",
      "## Host region",
      ...(design.hostPage
        ? [
            `[from ${read.entity.key}] page ${design.hostPage.routeOrPath}${design.hostPage.templatePath ? ` (${design.hostPage.templatePath})` : ""}, ${design.hostPage.fidelity}`,
            ...(design.hostPage.outline.length > 0
              ? [`outline: ${design.hostPage.outline.slice(0, 10).map((part) => `${part.role}${part.label ? ` ${part.label}` : ""}`).join(" › ")}`]
              : []),
          ]
        : []),
      ...(design.insertionRegion
        ? [
            `[from ${read.entity.key}] region ${design.insertionRegion.id} in ${design.insertionRegion.templatePath} at ${design.insertionRegion.structuralPath}${design.insertionRegion.orphaned ? " — the template moved and this anchor no longer resolves" : ""}`,
          ]
        : []),
    );
  }
  if (design.fixtures.length > 0) {
    lines.push(
      "",
      "## Fixtures",
      ...design.fixtures.slice(0, 10).map((fixture) => `[from ${read.entity.key}] ${fixture.name}: ${String(fixture.rows)} rows${fixture.blobId ? " (attached)" : ""}`),
    );
  }

  const open = read.comments.filter((comment) => comment.state !== "resolved");
  if (open.length > 0) {
    lines.push(
      "",
      "## Unresolved comments",
      ...open.slice(0, COMMENTS_MAX).map((comment) => `[from ${read.entity.key} comment] ${comment.blocking ? "blocking: " : ""}${oneLine(comment.text, 240)}`),
    );
    if (open.length > COMMENTS_MAX) truncated = true;
  }

  lines.push(
    "",
    `Quote ${read.revision.revisionId} as expected_revision_id when you comment on this design or record what you built.`,
  );

  let text = lines.join("\n");
  if (text.length > DESIGN_HANDOFF_MAX) {
    truncated = true;
    text = `${text.slice(0, DESIGN_HANDOFF_MAX)}\n…this hand-off was cut. Read the rest with inspect_project_work include body.`;
  }
  return {
    text,
    ref: { key: read.entity.key, entityId: read.entity.entityId, revisionId: read.revision.revisionId, digest: read.revision.digest },
    truncated,
  };
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
