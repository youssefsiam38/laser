/**
 * The in-process contract between the worker's project-work services and the
 * companion extension's one `project-work` module (M21-T17).
 *
 * Everything on the worker's side of it — the typed bridge to the host
 * authority, the Design Index, the Research run — lives in
 * `packages/worker/src/project-work`, `…/design/index` and `…/research`. The
 * module owns only what must happen inside the engine session: registering
 * the tools the model sees, and putting the implementation context packet and
 * the `/design implement` hand-off in front of the model at the boundary
 * where the role block already goes (D-140).
 *
 * One bridge per session, built by the worker when it opens one and passed
 * through `createLaserExtension({ projectWork })`. Everything optional on it
 * is a capability gate: an absent Design Index means the three Design tools
 * are not registered at all, not registered-and-refusing
 * (`docs/agent-tool-contract.md` §3).
 */
import type { LaserToolSpec } from "@lasercode/protocol";

/** A tool the worker defined, with the handler that answers it. */
export interface ProjectWorkToolBinding {
  spec: LaserToolSpec;
  /** What the tool answers. The module renders it; it never interprets it. */
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The code and next call a failure takes when it declares none itself. */
  recovery: { code: string; next: string };
}

export interface ProjectWorkBridge {
  /**
   * The lifecycle surface: `inspect_project_work`, `write_project_artifact`,
   * `request_project_review`, `report_project_task`. A projectless chat
   * supplies only the first, which is how a cross-project read stays possible
   * without a project of its own (leap, "Flexibility").
   */
  lifecycleTools(): ProjectWorkToolBinding[];
  /** The Design Index tools, when this project has an index bridge. */
  designTools(): ProjectWorkToolBinding[];
  /** The Research tools, for the adapters this session really has. */
  researchTools(): ProjectWorkToolBinding[];
  /**
   * What to put in front of the model this turn, or nothing.
   *
   * Called at every model-call boundary, so the packet can never be older
   * than the turn that reads it. The worker decides what it contains: the
   * implementation context packet for a session executing a Task, the
   * `/design implement` hand-off when the turn's input asked for one.
   */
  turnContext(input: { prompt?: string }): Promise<string | undefined>;
}
