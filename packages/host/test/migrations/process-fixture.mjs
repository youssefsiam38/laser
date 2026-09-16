import { join } from "node:path";
import { MigrationEngine } from "../../dist/index.js";

const [mode, root, pausePhase = ""] = process.argv.slice(2);
if (!mode || !root) process.exit(2);
const roots = { stateDir: join(root, "state"), agentDir: join(root, "agent"), sessionDir: join(root, "sessions") };
const unit = { root: "stateDir", path: "fixture.txt", type: "file" };
const second = { root: "stateDir", path: "second.txt", type: "file" };
const wait = new Int32Array(new SharedArrayBuffer(4));
const pause = (phase) => {
  process.stdout.write(`${JSON.stringify({ phase, pid: process.pid })}\n`);
  Atomics.wait(wait, 0, 0);
};
const registry = {
  targetSchema: 2,
  steps: [{
    id: "synthetic-v2", fromSchema: 1, toSchema: 2, units: [unit, second],
    run(context) {
      context.writeFile(unit, "after\n", 0o640);
      if (pausePhase === "step") pause("step");
      context.writeFile(second, "after-second\n", 0o640);
      if (mode === "fail") throw new Error("synthetic process failure");
    },
  }],
};
const engine = new MigrationEngine({
  roots,
  registry,
  onState(state) {
    if (state.phase === pausePhase || (pausePhase === "restore-partial" && state.phase === "restoring" && state.restoreIndex === 1)) {
      pause(pausePhase);
    }
  },
});
const input = { updateId: "d".repeat(64), targetGenerationId: "b".repeat(64) };
try {
  if (mode === "restore") engine.restore(input.updateId);
  else if (mode === "recover") engine.recover({ targetVerified: true });
  else if (mode === "recover-failed") engine.recover({ targetVerified: false });
  else if (mode === "select-pause") {
    engine.migrate(input);
    engine.markLaunchAttempt(input.updateId, "c".repeat(32));
    pause("selected");
  } else engine.migrate(input);
  process.stdout.write(`${JSON.stringify({ phase: engine.currentState()?.phase ?? "none", data: "complete" })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ phase: engine.currentState()?.phase ?? "none", data: "failed" })}\n`);
  if (mode !== "fail") throw error;
}
