/**
 * The host half of a research write, over the project-work bridge (D-351.a,
 * D-356.d).
 *
 * `ProjectResearch` writes through a `ResearchStore`: one call to read the
 * research artifact, one to apply an operation. Both are ordinary lifecycle
 * calls — a `project/work/get` and a `project/work/revise` carrying the
 * operation — so there is no `project/research/*` method, no second writer on
 * an artifact, and the host applies every rule again on the way in. The body
 * the worker's pre-check produced is never sent: what crosses is the
 * operation, and the host stores what **its** applier returns.
 */
import type { ProjectWorkGetResult, ResearchBody, ResearchOperation } from "@lasercode/protocol";
import type { ResearchStore } from "../research/bridge.js";
import type { ResearchWriteAck } from "../research/tools.js";
import { refuseProjectWork, type ProjectWorkBridge } from "./bridge.js";

/** A research artifact read through the bridge, by key or by opaque id. */
async function readResearch(
  bridge: ProjectWorkBridge,
  ref: string | undefined,
): Promise<{ ref: string; revisionId: string; body: ResearchBody }> {
  const projectId = bridge.projectId();
  if (projectId === undefined) {
    refuseProjectWork(
      "no_project",
      "This session is not working in a project, so it has no research to write to.",
      "ask the person to open this chat in a project, then start the research again",
    );
  }
  if (!ref) {
    refuseProjectWork(
      "no_research_ref",
      "Name the research this belongs to.",
      "call inspect_project_work with action list and kinds research to find it, then write again naming its key",
    );
  }
  const byKey = /^[A-Z]+-\d+$/.test(ref);
  const read = (await bridge.call("project/work/get", {
    projectId,
    ...(byKey ? { key: ref } : { entityId: ref }),
    body: { mode: "full" as const },
  })) as ProjectWorkGetResult;
  const body = read.body?.body;
  if (!body || body.kind !== "research") {
    refuseProjectWork(
      "not_research",
      `${read.entity.key} is a ${read.entity.kind}, not research, so a finding cannot be recorded on it.`,
      "call inspect_project_work with kinds research to find the research this belongs to",
    );
  }
  return { ref: read.entity.entityId, revisionId: read.revision.revisionId, body: body.research };
}

/** A `ResearchStore` backed by the host authority. */
export function bridgeResearchStore(bridge: ProjectWorkBridge): ResearchStore {
  return {
    artifact: (ref) => readResearch(bridge, ref),
    async apply(input): Promise<ResearchWriteAck> {
      const projectId = bridge.projectId();
      if (projectId === undefined) {
        refuseProjectWork(
          "no_project",
          "This session is not working in a project, so it cannot write research.",
          "ask the person to open this chat in a project, then write again",
        );
      }
      const current = await readResearch(bridge, input.researchRef);
      const result = await bridge.call(
        "project/work/revise",
        {
          projectId,
          entityId: current.ref,
          expectedRevisionId: input.expectedRevisionId,
          // The host replaces this with what its own applier returns; it is
          // here because `revise` declares a body, never as the authority.
          body: { kind: "research", research: current.body },
          idempotencyKey: input.idempotencyKey,
        },
        { research: input.operation as ResearchOperation },
      );
      const after = bridge.lastResearchResult();
      const stored = result.revision.revisionId;
      const body = await readResearch(bridge, current.ref);
      const findingId = findingIdOf(body.body, input.operation);
      return {
        revisionId: stored,
        questionId: input.operation.questionId,
        ...(findingId !== undefined ? { findingId } : {}),
        status: body.body.status,
        ...(after?.attention ? { attention: after.attention } : {}),
        staleRefs: after?.staleRefs ?? [],
      };
    },
  };
}

/** The finding the host appended, as the body now reads it. */
function findingIdOf(body: ResearchBody, operation: ResearchOperation): string | undefined {
  if (operation.op !== "record_finding") return undefined;
  const question = body.questions.find((candidate) => candidate.id === operation.questionId);
  return question?.findings.at(-1);
}
