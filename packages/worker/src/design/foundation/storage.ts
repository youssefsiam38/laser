/**
 * Where a foundation lives (M21-T14).
 *
 * In Laser state, as a Design revision body — and nowhere else. The contract
 * is one sentence of `docs/design-phase.md`: "sandbox components live in
 * Laser state; the repository is unchanged until Build." So this file writes
 * through the host authority over the project-work bridge and **imports no
 * filesystem API at all**: there is no path here that could touch the
 * project, which is why the test for it is a module-graph proof rather than a
 * promise.
 *
 * The token document rides in the body (`foundation.tokens`), bounded by the
 * same DTCG schema the index uses. `foundation.tokensBlobId` stays in the
 * shape for a document stored as a blob — the window reads either — but a
 * proposal never needs one: ten steps of tokens are kilobytes against a body
 * budget of megabytes.
 *
 * Reads and writes are fenced the way every project-work write is: the
 * revision the caller read is the `expectedRevisionId`, and a conflict comes
 * back as the host's own refusal rather than a silent overwrite.
 */
import { designIsSketchOnly, type DesignBody, type DesignFoundation, type ProjectWorkBody } from "@lasercode/protocol";
import { refuseProjectWork, type ProjectWorkBridge } from "../../project-work/bridge.js";

/** One Design entity as the foundation code needs it. */
export interface LoadedDesign {
  entityId: string;
  key: string;
  title: string;
  revisionId: string;
  digest: string;
  body: DesignBody;
}

/** A stored revision, as the tool reports it back. */
export interface StoredFoundation {
  entityId: string;
  key: string;
  revisionId: string;
  digest: string;
  created: boolean;
}

/** The brief a Design created by Foundation mode starts with. */
export function foundationBriefText(product: string | undefined): string {
  return product === undefined || product.trim() === ""
    ? "A greenfield foundation: this project has no interface code yet, so the design language is being proposed here first and implemented by the build."
    : `A greenfield foundation for ${product.trim()}. This project has no interface code yet, so the design language is proposed here first and implemented by the build.`;
}

/** An empty Design body carrying a foundation and nothing else. */
export function foundationBody(brief: string, foundation: DesignFoundation): DesignBody {
  return {
    brief,
    foundation,
    screens: [],
    flows: [],
    sketches: [],
    fidelity: "proposed",
    fixtures: [],
  };
}

/**
 * The Design entity a foundation is stored on, read at its current revision.
 *
 * `key` or `entityId` — whichever the caller has. A Design that is not one
 * (a Spec, a Task) is refused by name rather than written over.
 */
export async function loadDesign(
  bridge: ProjectWorkBridge,
  input: { entityId?: string; key?: string },
): Promise<LoadedDesign | undefined> {
  const projectId = bridge.projectId();
  if (projectId === undefined) return undefined;
  if (input.entityId === undefined && input.key === undefined) return undefined;
  const result = await bridge.call("project/work/get", {
    projectId,
    ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
    ...(input.key !== undefined ? { key: input.key } : {}),
    body: { mode: "full" as const },
  });
  if (result.entity.kind !== "design") {
    refuseProjectWork(
      "not_a_design",
      `${result.entity.key} is a ${result.entity.kind}, and a foundation is proposed on a design.`,
      "call propose_foundation with the key of a design, or leave it out to start a new one",
    );
  }
  const body = result.body?.body;
  if (body === undefined || body.kind !== "design") {
    refuseProjectWork(
      "body_unreadable",
      `${result.entity.key}'s body could not be read whole, so a foundation cannot be written onto it without losing what is there.`,
      "open the design in the workspace and check it, then try again",
    );
  }
  return {
    entityId: result.entity.entityId,
    key: result.entity.key,
    title: result.entity.title,
    revisionId: result.revision.revisionId,
    digest: result.revision.digest,
    body: body.design,
  };
}

/**
 * Store a foundation: a new Design when there is none, a revision when there
 * is. Nothing else about the design moves — screens, sketches and the host
 * page a design already carries are kept exactly as they were.
 */
export async function storeFoundation(
  bridge: ProjectWorkBridge,
  input: {
    design?: LoadedDesign | undefined;
    foundation: DesignFoundation;
    title?: string;
    product?: string;
    note: string;
    idempotencyKey: string;
  },
): Promise<StoredFoundation> {
  const projectId = bridge.projectId();
  if (projectId === undefined) {
    refuseProjectWork(
      "no_project",
      "This session is not working in a project, so there is nowhere to keep a foundation.",
      "ask the person to open this chat in a project, and then propose the foundation again",
    );
  }
  if (!input.design) {
    const body: ProjectWorkBody = { kind: "design", design: foundationBody(foundationBriefText(input.product), input.foundation) };
    const created = await bridge.call("project/work/create", {
      projectId,
      kind: "design",
      title: input.title ?? "Design foundation",
      body,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      entityId: created.entity.entityId,
      key: created.entity.key,
      revisionId: created.revision.revisionId,
      digest: created.revision.digest,
      created: true,
    };
  }
  const next: DesignBody = { ...input.design.body, foundation: input.foundation };
  const body: ProjectWorkBody = { kind: "design", design: next };
  const revised = await bridge.call("project/work/revise", {
    projectId,
    entityId: input.design.entityId,
    expectedRevisionId: input.design.revisionId,
    body,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    entityId: revised.entity.entityId,
    key: revised.entity.key,
    revisionId: revised.revision.revisionId,
    digest: revised.revision.digest,
    created: false,
  };
}

/**
 * What a Design carrying only a foundation can and cannot do yet.
 *
 * A foundation is not screens: it passes the Design gate as the thing it is
 * (the gate accepts a recorded foundation in place of an index profile), but
 * a design whose screens are all sketches still cannot. Said here so both the
 * tool and the window use the same words.
 */
export function foundationDesignState(body: DesignBody): { hasScreens: boolean; sketchOnly: boolean } {
  return { hasScreens: body.screens.length > 0, sketchOnly: designIsSketchOnly(body) };
}
