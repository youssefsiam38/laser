import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@lasercode/protocol";

const runner = fileURLToPath(new URL("./process-fixture.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_SLUG}-migration-process-`));
  roots.push(root);
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "state", "fixture.txt"), "before\n", { mode: 0o600 });
  writeFileSync(join(root, "state", "second.txt"), "before-second\n", { mode: 0o640 });
  return root;
}

function run(root: string, mode: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [runner, mode, root], { encoding: "utf8", timeout: 15_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function spawnPaused(root: string, mode: string, phase: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [runner, mode, root, phase], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not reach ${phase}: ${output}`)), 10_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes(`\"phase\":\"${phase}\"`)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      if (!output.includes(`\"phase\":\"${phase}\"`)) {
        clearTimeout(timer);
        reject(new Error(`process exited before ${phase}: ${code}/${signal}: ${output}`));
      }
    });
  });
  return child;
}

async function killHard(child: ChildProcess): Promise<void> {
  const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
  expect(child.kill("SIGKILL")).toBe(true);
  expect(await exited).toBe("SIGKILL");
}

describe("real-process migration crash recovery", () => {
  for (const phase of ["snapshotting", "migrating", "step", "migrated"] as const) {
    it(`recovers exact data after SIGKILL at ${phase}`, async () => {
      const root = fixture();
      const child = await spawnPaused(root, "migrate", phase);
      await killHard(child);

      const recovered = run(root, "recover");
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(readFileSync(join(root, "state", "fixture.txt"), "utf8")).toBe("after\n");
      expect(readFileSync(join(root, "state", "second.txt"), "utf8")).toBe("after-second\n");
      expect(statSync(join(root, "state", "fixture.txt")).mode & 0o777).toBe(0o640);
    });
  }

  it("resumes an interrupted partial restore after SIGKILL with exact bytes and modes", async () => {
    const root = fixture();
    expect(run(root, "fail").status).toBe(0);
    const child = await spawnPaused(root, "restore", "restore-partial");
    expect(readFileSync(join(root, "state", "fixture.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(join(root, "state", "second.txt"), "utf8")).toBe("after-second\n");
    await killHard(child);

    const restored = run(root, "restore");
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(join(root, "state", "fixture.txt"), "utf8")).toBe("before\n");
    expect(readFileSync(join(root, "state", "second.txt"), "utf8")).toBe("before-second\n");
    expect(statSync(join(root, "state", "fixture.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "state", "second.txt")).mode & 0o777).toBe(0o640);
  });
});
