/**
 * A Router whose only real dependency is the project-work authority (M21-T3).
 *
 * The worker pool is a stub that **throws on every way of reaching a worker**.
 * That is the point: the leap requires the host to answer project work without
 * starting one, for writes as much as for reads, so any route that reached for
 * a worker fails the test that used it rather than passing quietly.
 *
 * Not a test file.
 */
import { AttentionTracker } from "../../src/attention.js";
import { ProjectEnvStore } from "../../src/project-env.js";
import { ProjectRegistry } from "../../src/projects.js";
import { ProjectWorkMethods, type ProjectWorkTrust } from "../../src/project-work/methods.js";
import { ProjectWorkNotifier } from "../../src/project-work/notifier.js";
import { ProjectWorkStore, type ProjectWorkQuota } from "../../src/project-work/store.js";
import { Router } from "../../src/router.js";
import { ViewCache } from "../../src/views.js";
import { testAccess } from "../actors.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcResponse } from "@lasercode/protocol";
import type { ActorIdentity } from "../../src/access.js";
import type { LogInput } from "../../src/logstore.js";
import type { SessionCatalog } from "../../src/catalog.js";
import type { WorkerPool } from "../../src/worker-pool.js";

export interface ProjectWorkHarnessOptions {
  quota?: ProjectWorkQuota;
  eventsRetained?: number;
  /** Trust for a project folder. Absent = nothing is trust-gated. */
  trustOf?: (projectRoot: string) => ProjectWorkTrust;
  /** Narrowing applied to every actor by the environment policy. */
  policy?: unknown;
  /**
   * Stand the Router up without the authority, as a host whose store could
   * not be opened: the methods must refuse with the reason, not answer.
   */
  unavailable?: string;
}

export interface ProjectWorkHarness {
  router: Router;
  store: ProjectWorkStore;
  methods: ProjectWorkMethods;
  dir: string;
  /** Where the harness' first project lives, already minted. */
  projectRoot: string;
  projectId: string;
  /** Every notification the host would have broadcast, in order. */
  notifications: Array<{ method: string; params: unknown }>;
  /** Every log row the authority wrote. */
  logs: LogInput[];
  /** How many times something tried to reach a worker. Always zero. */
  workerAttempts: () => number;
  call: (method: string, params: unknown, actor?: ActorIdentity) => Promise<JsonRpcResponse>;
  cleanup: () => void;
}

const LOCAL_APP: ActorIdentity = { class: "local_app", id: "l1.app" };

export function projectWorkHarness(options: ProjectWorkHarnessOptions = {}): ProjectWorkHarness {
  const dir = mkdtempSync(join(tmpdir(), "project-work-router-"));
  const notifications: Array<{ method: string; params: unknown }> = [];
  const logs: LogInput[] = [];
  let workerAttempts = 0;

  const notifier = new ProjectWorkNotifier({
    attention: (projectId) => methods.attention(projectId),
    notifyUpdated: (notification) => notifications.push({ method: "project/work/updated", params: notification }),
    notifyAttention: (notification) => notifications.push({ method: "project/work/attention", params: notification }),
  });
  const store = new ProjectWorkStore({
    file: join(dir, "project-work.db"),
    ...(options.quota ? { quota: options.quota } : {}),
    ...(options.eventsRetained !== undefined ? { eventsRetained: options.eventsRetained } : {}),
    onEvent: (event) => notifier.handle(event),
  });
  const methods = new ProjectWorkMethods({
    store,
    ...(options.trustOf ? { trustOf: options.trustOf } : {}),
    logs: {
      record: (input: LogInput) => {
        logs.push(input);
        return undefined;
      },
    },
  });

  const reachedForAWorker = (what: string): never => {
    workerAttempts += 1;
    throw new Error(`project work started a worker (${what})`);
  };
  const pool = {
    get: async (cwd: string) => reachedForAWorker(`get ${cwd}`),
    prepare: async (cwd: string) => reachedForAWorker(`prepare ${cwd}`),
    liveClients: () => [],
    cwds: () => [],
    openSessions: () => [],
    hasReservedWorker: () => false,
    cwdOfSession: () => undefined,
    bindSession: () => {},
    forgetSession: () => {},
    broadcastRequest: async () => reachedForAWorker("broadcast"),
  } as unknown as WorkerPool;

  const catalog = {
    list: () => [],
    get: () => undefined,
    getListed: () => undefined,
    cwdOf: () => undefined,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;

  const router = new Router(pool, catalog, {
    attention: new AttentionTracker({}),
    projects: new ProjectRegistry({ catalog, agentDir: join(dir, "agent") }),
    projectEnv: new ProjectEnvStore({ storePath: join(dir, "project-env.json") }),
    views: new ViewCache(2),
    access: testAccess(options.policy),
    ...(options.unavailable === undefined ? { projectWork: methods } : { projectWorkUnavailable: options.unavailable }),
  });

  const projectRoot = join(dir, "alpha");
  const projectId = store.projectIdFor(projectRoot)!;
  let id = 0;

  return {
    router,
    store,
    methods,
    dir,
    projectRoot,
    projectId,
    notifications,
    logs,
    workerAttempts: () => workerAttempts,
    call: (method, params, actor = LOCAL_APP) => router.handle({ jsonrpc: "2.0", id: ++id, method, params }, { actor }),
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The result of a call that must have succeeded. */
export function ok<T = Record<string, unknown>>(response: JsonRpcResponse): T {
  if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as T;
}

/** The error of a call that must have failed. */
export function failed(response: JsonRpcResponse): { code: number; message: string; data?: unknown } {
  if (!response.error) throw new Error(`expected a refusal, got ${JSON.stringify(response.result)}`);
  return response.error;
}
