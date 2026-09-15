/**
 * RP-4 · proving a conversation can be reopened, against the real engine.
 *
 * `prepareRelease()` is what stands between "this runtime is idle" and "this
 * runtime may go". It flushes what the engine still owes the file and then
 * reads that file back through the engine's own parser, comparing identity,
 * entries and branch with the live manager — so a record that was deleted,
 * replaced, truncated or corrupted after it was opened is caught here, while
 * the conversation is still in memory and can be kept.
 *
 * Everything is sandboxed in a temp directory; no credentials, no provider.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";

let base: string;
let driver: StableSdkDriver;

async function open(): Promise<string> {
  const state = await driver.open({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
  });
  return state.path;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-release-`));
  mkdirSync(join(base, "project"), { recursive: true });
  mkdirSync(join(base, "agent"), { recursive: true });
  mkdirSync(join(base, "sessions"), { recursive: true });
  driver = new StableSdkDriver();
});

afterEach(async () => {
  await driver.dispose().catch(() => {});
  rmSync(base, { recursive: true, force: true });
});

describe("StableSdkDriver.prepareRelease", () => {
  it("settles the record and agrees it can be reopened", async () => {
    const path = await open();
    const readiness = await driver.prepareRelease();
    expect(readiness).toEqual({ ok: true });
    // The flush is the point: what the engine held is on disk, with this
    // session's identity in its header.
    expect(existsSync(path)).toBe(true);
    const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as { type: string; id: string };
    expect(header.type).toBe("session");
    expect(header.id).toBe(driver.state().id);
    // And nothing about the conversation changed by asking.
    expect(driver.sessionHeader()?.id).toBe(header.id);
  });

  it("refuses when the record was deleted while the conversation was open", async () => {
    const path = await open();
    expect((await driver.prepareRelease()).ok).toBe(true);
    unlinkSync(path);
    expect(await driver.prepareRelease()).toMatchObject({ ok: false, refusal: "no_record" });
  });

  it("refuses when the record was emptied", async () => {
    const path = await open();
    expect((await driver.prepareRelease()).ok).toBe(true);
    writeFileSync(path, "");
    expect(await driver.prepareRelease()).toMatchObject({ ok: false, refusal: "unreadable" });
  });

  it("refuses when another session's record took its place", async () => {
    const path = await open();
    expect((await driver.prepareRelease()).ok).toBe(true);
    const other = { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000999", cwd: join(base, "project"), timestamp: "2026-09-10T00:00:00.000Z" };
    writeFileSync(path, `${JSON.stringify(other)}\n`);
    expect(await driver.prepareRelease()).toMatchObject({ ok: false, refusal: "identity_mismatch" });
  });

  it("refuses when the record is corrupt after a valid header", async () => {
    const path = await open();
    expect((await driver.prepareRelease()).ok).toBe(true);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    // Header intact, the rest of the conversation truncated away: exactly the
    // shape a one-line header check would have called reopenable.
    writeFileSync(path, `${lines[0]!}\n`);
    expect(await driver.prepareRelease()).toMatchObject({ ok: false, refusal: "identity_mismatch" });
  });

  it("refuses a record that is not parseable at all, whichever step notices", async () => {
    const path = await open();
    writeFileSync(path, "not json\nnot json either\n");
    const readiness = await driver.prepareRelease();
    expect(readiness.ok).toBe(false);
    // Two honest ways to notice, depending on whether the engine still owed
    // this file its first write: the flush finds something already there, or
    // the read-back finds no header of this session. Both keep the runtime.
    expect(["unreadable", "identity_mismatch", "flush_failed"]).toContain((readiness as { refusal: string }).refusal);
  });
});
