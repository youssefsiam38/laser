/**
 * A verification command is owned while it runs (M21-T22, threat model §7).
 *
 * `docs/agents.md` §6 holds background work to four things this asserts about
 * the one part of a verification run that executes anything: the process is
 * registered with the inventory as this worker's helper, it runs in the
 * Task's own checkout, it runs with `CI=1`, and the line it runs is the exact
 * string the Task declared — nothing of the run's own data is interpolated
 * into it.
 *
 * The child is inert: no process is started on the machine running this.
 */
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceProcessRegistration } from "@lasercode/protocol";
import { runVerificationCommand } from "../../src/project-work/verification/commands.js";
import { setWorkerProcessObserver } from "../../src/process-registry.js";

class InertChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 4242;
  kill(): boolean {
    return true;
  }
}

afterEach(() => {
  setWorkerProcessObserver(undefined);
});

describe("the one thing a verification run executes", () => {
  it("registers the process it starts as this worker's helper", async () => {
    const registered: ResourceProcessRegistration[] = [];
    setWorkerProcessObserver({ started: (registration) => registered.push(registration) });
    const child = new InertChild();
    let seen: { command: string; options: SpawnOptions } | undefined;
    const running = runVerificationCommand({
      command: "pnpm -F @lasercode/host test",
      cwd: "/tmp/checkout",
      spawnProcess: (command, options) => {
        seen = { command, options };
        return child as unknown as ChildProcess;
      },
    });
    await Promise.resolve();
    child.stdout.emit("data", Buffer.from("ok\n"));
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    const run = await running;

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ pid: 4242, role: "helper", label: "verification-command" });
    // The declared line, exactly, in the checkout it was declared for.
    expect(seen?.command).toBe("pnpm -F @lasercode/host test");
    expect(seen?.options.cwd).toBe("/tmp/checkout");
    expect((seen?.options.env as NodeJS.ProcessEnv | undefined)?.["CI"]).toBe("1");
    // Owned as a tree, so a stop can end everything it started.
    expect(seen?.options.detached).toBe(true);
    expect(run.status).toBe("passed");
    expect(run.exitCode).toBe(0);
  });

  it("registers nothing when nothing was started", async () => {
    const registered: ResourceProcessRegistration[] = [];
    setWorkerProcessObserver({ started: (registration) => registered.push(registration) });
    const controller = new AbortController();
    controller.abort();
    const run = await runVerificationCommand({
      command: "pnpm test",
      cwd: "/tmp/checkout",
      signal: controller.signal,
      spawnProcess: () => {
        throw new Error("nothing should be started for a run that was already stopped");
      },
    });
    expect(run.status).toBe("stopped");
    expect(registered).toHaveLength(0);
  });
});
