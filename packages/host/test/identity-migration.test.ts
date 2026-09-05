/**
 * A rename must not orphan a person's data (MX-T7, D-36).
 *
 * The former list is passed in rather than read from `FORMER_NAMES`, so these
 * still test the move on the day the product has no former names (today) and on
 * the day it has one. The rules with judgement in them are the ones worth a
 * test: never merge, never delete, and never lose a directory because it was
 * only half moved.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DATA_DIR_NAME, PRODUCT_NAME } from "@piorbit/protocol";
import { migrateFormerIdentities, ownedDirectories, piorbitDataDir } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-migration-`));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OLD = [{ dirName: "previous" }];

/** A home directory holding an install under the old name. */
function homeWithOldInstall(label: string): string {
  const home = join(root, label);
  mkdirSync(join(home, ".local", "share", "previous", "agent"), { recursive: true });
  mkdirSync(join(home, ".config", "previous"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "previous", "agent", "settings.json"), '{"theme":"graphite"}');
  return home;
}

describe("the directories the product owns", () => {
  it("starts with the data directory paths.ts resolves", () => {
    const env = { HOME: root };
    expect(ownedDirectories(DATA_DIR_NAME, env)[0]).toBe(piorbitDataDir(env));
  });

  it("covers the config directory and the legacy dotfile, which is what --purge removes", () => {
    expect(ownedDirectories("example", { HOME: root })).toContain(join(root, ".config", "example"));
    expect(ownedDirectories("example", { HOME: root })).toContain(join(root, ".example"));
  });

  it("honours XDG_DATA_HOME and XDG_CONFIG_HOME, so a relocated home is followed", () => {
    const dirs = ownedDirectories("example", { HOME: root, XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" });
    expect(dirs).toContain(join("/d", "example"));
    expect(dirs).toContain(join("/c", "example"));
  });
});

describe("migrating from a former name", () => {
  it("moves the data and config directories, and the settings survive", () => {
    const home = homeWithOldInstall("moved");
    const result = migrateFormerIdentities({ HOME: home }, OLD);
    expect(result.steps.map((step) => step.outcome)).toEqual(["moved", "moved"]);
    expect(readFileSync(join(home, ".local", "share", DATA_DIR_NAME, "agent", "settings.json"), "utf8")).toBe(
      '{"theme":"graphite"}',
    );
    expect(existsSync(join(home, ".local", "share", "previous"))).toBe(false);
    expect(result.lines[0]).toContain("this product was renamed");
  });

  it("never merges: an existing directory wins and the old one is left alone", () => {
    const home = homeWithOldInstall("both");
    mkdirSync(join(home, ".local", "share", DATA_DIR_NAME), { recursive: true });
    writeFileSync(join(home, ".local", "share", DATA_DIR_NAME, "marker"), "current");
    const result = migrateFormerIdentities({ HOME: home }, OLD);
    const kept = result.steps.find((step) => step.outcome === "kept-both");
    expect(kept?.from).toBe(join(home, ".local", "share", "previous"));
    expect(existsSync(join(home, ".local", "share", "previous", "agent", "settings.json"))).toBe(true);
    expect(readFileSync(join(home, ".local", "share", DATA_DIR_NAME, "marker"), "utf8")).toBe("current");
    expect(result.lines.join("\n")).toContain("Merging two of these is a decision only you can make");
  });

  it("treats an empty destination as no destination, because `doctor` makes one", () => {
    // `piorbit doctor` checks that the state directory is writable by creating
    // it. Someone running it once before the app's first start would otherwise
    // be signed out, session-less and orphaned from every paired phone forever,
    // with a log line about two installs they do not have.
    const home = homeWithOldInstall("empty-destination");
    mkdirSync(join(home, ".local", "share", DATA_DIR_NAME, "state"), { recursive: true });
    rmSync(join(home, ".local", "share", DATA_DIR_NAME, "state"), { recursive: true });
    const result = migrateFormerIdentities({ HOME: home }, OLD);
    expect(result.steps.map((step) => step.outcome)).toEqual(["moved", "moved"]);
    expect(readFileSync(join(home, ".local", "share", DATA_DIR_NAME, "agent", "settings.json"), "utf8")).toBe(
      '{"theme":"graphite"}',
    );
  });

  it("is a no-op the second time, so every start can call it", () => {
    const home = homeWithOldInstall("twice");
    migrateFormerIdentities({ HOME: home }, OLD);
    expect(migrateFormerIdentities({ HOME: home }, OLD)).toEqual({ steps: [], lines: [] });
  });

  it("does nothing at all with no former names, which is the usual case", () => {
    const home = homeWithOldInstall("none");
    expect(migrateFormerIdentities({ HOME: home }, [])).toEqual({ steps: [], lines: [] });
  });
});
