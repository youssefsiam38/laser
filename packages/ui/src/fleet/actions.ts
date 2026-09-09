/**
 * The background-task actions the provider exposes as `actions.tasks`. Pure of
 * React: a request client, the reducer's dispatch and the shared toast guard
 * in, a stable object of methods out. Tested in test/fleet/actions.test.ts.
 *
 * Two failure styles, the same rule as the agents actions: a method a surface
 * is *waiting on* rejects, so the message lands where the person is looking;
 * a method that only settles toasts and resolves.
 */
import type { BackgroundTask, TaskOutputChunk } from "@lasercode/protocol";
import type { HostClient } from "../client.js";
import type { Action } from "../store.js";

export interface TasksActions {
  /**
   * `tasks/list` into `state.tasks`; `path` narrows to one session. Failure
   * toasts — the fleet keeps whatever it already holds rather than emptying.
   */
  list(path?: string): Promise<void>;
  /** `tasks/stop`; the returned task is folded into the store. Rejects on failure. */
  stop(path: string, id: string): Promise<BackgroundTask>;
  /** `tasks/output` — one bounded range of a task's bytes. Rejects on failure. */
  output(path: string, id: string, fromByte: number): Promise<TaskOutputChunk>;
}

export interface TasksActionsDeps {
  client: Pick<HostClient, "request">;
  dispatch(action: Action): void;
  /** Toast-and-swallow, shared with every other action. */
  guard<T>(work: () => Promise<T>): Promise<T | undefined>;
}

export function createTasksActions({ client, dispatch, guard }: TasksActionsDeps): TasksActions {
  return {
    list: (path) =>
      guard(async () => {
        const { tasks } = await client.request("tasks/list", path !== undefined ? { path } : {});
        dispatch({ type: "tasks/loaded", tasks, ...(path !== undefined ? { path } : {}) });
      }).then(() => undefined),
    stop: async (path, id) => {
      const { task } = await client.request("tasks/stop", { path, id });
      dispatch({ type: "tasks/update", task });
      return task;
    },
    output: (path, id, fromByte) => client.request("tasks/output", { path, id, fromByte }),
  };
}
