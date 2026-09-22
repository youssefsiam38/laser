/**
 * A process that dies in the middle of writing project work (M21-T2).
 *
 * Run by `crash.test.ts` as a real child and killed with SIGKILL at an exact
 * point, because that is the only honest way to test what survives:
 *
 *   commit-then-kill    the second create has committed; the process dies
 *                       before the caller could do anything with the result
 *   kill-before-commit  the second create has taken its key and written its
 *                       rows, and the process dies before COMMIT
 *
 * The kill point is chosen through the store's injected clock: after the first
 * create returns, the fixture arms itself, and kills on the nth clock read of
 * the second create. Read 1 is the start of the write; read 2 is the
 * idempotency record, which is the last statement before COMMIT.
 */
import { ProjectWorkStore } from "../../src/project-work/store.js";
import { specBody } from "./fixtures.js";

const file = process.argv[2] ?? "";
const mode = process.argv[3] ?? "commit-then-kill";
const projectRoot = process.argv[4] ?? "/tmp/project";

let armed = false;
let reads = 0;
const killOnRead = mode === "kill-before-commit" ? 2 : 0;
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  // Unreachable: SIGKILL cannot be handled. Present so the type is `never`.
  throw new Error("unreachable");
};

const store = new ProjectWorkStore({
  file,
  now: () => {
    if (armed) {
      reads += 1;
      if (killOnRead > 0 && reads === killOnRead) die();
    }
    return new Date(Date.UTC(2026, 0, 1, 0, 0, reads));
  },
  onEvent: (event) => {
    if (armed && mode === "commit-then-kill" && event.change.key === "SPEC-2") die();
  },
});

const projectId = store.projectIdFor(projectRoot)!;
const first = store.create({ projectId, kind: "spec", title: "The first one", body: specBody("first"), origin: { actor: { kind: "person", label: "You" } }, idempotencyKey: "one" });
process.stdout.write(`${JSON.stringify({ projectId, key: first.entity.key })}\n`);
armed = true;
store.create({ projectId, kind: "spec", title: "The second one", body: specBody("second"), origin: { actor: { kind: "person", label: "You" } }, idempotencyKey: "two" });
process.stdout.write("survived\n");
store.close();
