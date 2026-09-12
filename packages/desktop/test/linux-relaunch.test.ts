import { BINARY_NAME, ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertRelaunchPrivileges, linuxRelaunchCommand } from "../src/linux-relaunch.js";

it("uses the installed launcher, keeping argv, cwd and environment exactly", () => {
  const env = { PATH: "/custom/bin", [ENV.stateDir]: "/data with spaces", DISPLAY: ":42" };
  const input = { packaged: true, execPath: "/app/bin", argv: ["/app/bin", "--user-data-dir=/custom profile", "--ozone-platform=x11"], cwd: "/project", env };
  const command = linuxRelaunchCommand(input);
  expect(command).toEqual({ executable: `/app/${BINARY_NAME}`, args: input.argv.slice(1), cwd: input.cwd, env });
  expect(command.env).not.toBe(env);
  expect(command.args).not.toBe(input.argv);
  expect(linuxRelaunchCommand({ ...input, packaged: false }).executable).toBe(input.execPath);
  expect(command.args).not.toContain("--no-sandbox");
  expect(linuxRelaunchCommand({ ...input, env: { ...env, APPIMAGE: "/downloads/app with spaces.AppImage" } }).executable)
    .toBe("/downloads/app with spaces.AppImage");
});

it("never pretends an inherited kernel restriction can be cleared", () => {
  expect(() => assertRelaunchPrivileges("Name:\tapp\nNoNewPrivs:\t0\n")).not.toThrow();
  expect(() => assertRelaunchPrivileges("NoNewPrivs:\t1\n")).toThrow(/quit the app completely/);
  expect(() => assertRelaunchPrivileges("NoNewPrivs:\t1\n")).toThrow(/cannot remove/);
  expect(() => assertRelaunchPrivileges("NoNewPrivs:\t2\n")).toThrow(/could not verify/);
  expect(() => assertRelaunchPrivileges("")).toThrow(/could not verify/);
});

const roots: string[] = [];
const children: ChildProcess[] = [];
const helpers: number[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const pid of helpers.splice(0)) { try { process.kill(pid); } catch { /* exited */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const helperFile = fileURLToPath(new URL("../dist/relaunch-helper.cjs", import.meta.url));
const nnp = () => /^NoNewPrivs:\s*(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
const alive = (pid: number) => {
  try { return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch { return false; }
};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Restart fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fixture(broken = false) {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-restart-`)); roots.push(root);
  const result = join(root, "result.json");
  const recorder = join(root, "record.cjs");
  writeFileSync(recorder, `
    const fs = require('node:fs'), cp = require('node:child_process');
    const status = () => fs.readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\\s*(\\d+)/m)[1];
    fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({
      nnp: status(), child: cp.execFileSync('/bin/sh', ['-c', 'grep NoNewPrivs /proc/self/status'], {encoding:'utf8'}).trim(),
      args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.RESTART_TEST_MARKER,
      stateDir: process.env[${JSON.stringify(ENV.stateDir)}]
    }));
  `);
  const script = `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const helper = spawn(process.execPath, ['--input-type=commonjs', '--eval', fs.readFileSync(${JSON.stringify(helperFile)}, 'utf8')], {
      detached:true, stdio:['ignore','ignore','ignore','ipc']
    });
    helper.on('message', m => process.send({...m, helperPid:helper.pid}));
    helper.on('exit', (code) => process.send({type:'helper-exit', code}));
    helper.send({type:'prepare', launch:{
      executable:${JSON.stringify(broken ? join(root, "missing") : process.execPath)},
      args:[${JSON.stringify(recorder)}, 'space in arg', '$(not-a-shell)', '--flag'],
      cwd:${JSON.stringify(root)},
      env:{...process.env, RESTART_TEST_MARKER:'kept', [${JSON.stringify(ENV.stateDir)}]:${JSON.stringify(join(root, "state"))}}
    }});
    process.on('message', m => {
      if(m.type==='exit') process.exit(0);
      else if(m.type==='disconnect-helper') helper.disconnect();
      else helper.send(m);
    });
  `;
  const parent = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(parent);
  const messages: Array<{ type: string; helperPid?: number; code?: number }> = [];
  parent.on("message", (value) => {
    const message = value as (typeof messages)[number];
    messages.push(message);
    if (message.helperPid && !helpers.includes(message.helperPid)) helpers.push(message.helperPid);
  });
  return { root, result, parent, messages, sent: (type: string) => messages.some((m) => m.type === type) };
}

describe.skipIf(process.platform !== "linux")("stock-Node handoff, real processes (build desktop first)", () => {
  it("requires commit AND old-process exit; preserves configuration and flags into shell children", async () => {
    expect(existsSync(helperFile)).toBe(true);
    const f = fixture();
    await until(() => f.sent("ready"));
    expect(existsSync(f.result)).toBe(false);
    f.parent.send({ type: "commit" });
    await until(() => f.sent("committed"));
    f.parent.send({ type: "disconnect-helper" });
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(existsSync(f.result), "disconnect alone must not race the single-instance lock").toBe(false);
    f.parent.send({ type: "exit" });
    await until(() => existsSync(f.result));
    const result = JSON.parse(readFileSync(f.result, "utf8"));
    expect(result).toEqual({ nnp: nnp(), child: `NoNewPrivs:\t${nnp()}`, args: ["space in arg", "$(not-a-shell)", "--flag"], cwd: f.root, marker: "kept", stateDir: join(f.root, "state") });
  });

  it("parent loss before commit cancels, rather than restarting after a crash", async () => {
    const f = fixture();
    await until(() => f.sent("ready"));
    const pid = f.messages.find((m) => m.type === "ready")!.helperPid!;
    f.parent.send({ type: "exit" });
    await until(() => !alive(pid));
    expect(existsSync(f.result)).toBe(false);
  });

  it("explicit cancellation ends the prepared helper without launching", async () => {
    const f = fixture();
    await until(() => f.sent("ready"));
    f.parent.send({ type: "cancel" });
    await until(() => f.sent("helper-exit"));
    expect(existsSync(f.result)).toBe(false);
    expect(alive(f.parent.pid!)).toBe(true);
  });

  it("missing replacement fails preparation while the original remains alive", async () => {
    const f = fixture(true);
    await until(() => f.sent("helper-exit"));
    expect(f.sent("ready")).toBe(false);
    expect(f.messages.find((m) => m.type === "helper-exit")?.code).toBe(1);
    expect(alive(f.parent.pid!)).toBe(true);
    expect(existsSync(f.result)).toBe(false);
  });
});
