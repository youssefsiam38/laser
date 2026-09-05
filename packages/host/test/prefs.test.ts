/**
 * PrefsStore (M11-T6). The store itself is small, but three of its properties
 * are the whole point of moving the theme off the browser, and each is easy to
 * get subtly wrong:
 *
 *   - a namespace survives a restart, or a theme is still per device;
 *   - clearing is a real edit with its own revision, not "never set", or a
 *     second device would silently put the old theme back;
 *   - the revision only ever goes up, because that is what lets a client
 *     recognise the echo of its own write instead of fighting it.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrefsEntry } from "@piorbit/protocol";
import { PrefsStore } from "../src/prefs.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "piorbit-prefs-"));

describe("PrefsStore", () => {
  it("keeps a namespace, hands it back, and survives a restart", () => {
    const root = dir();
    try {
      const file = join(root, "prefs.json");
      const theme = { followSystem: false, theme: { id: "graphite", base: "dark" } };
      const first = new PrefsStore({ storePath: file });
      first.set("theme", theme);
      first.close();

      expect(JSON.parse(readFileSync(file, "utf8")).namespaces.theme.value).toEqual(theme);

      const second = new PrefsStore({ storePath: file });
      expect(second.get("theme")).toEqual([
        expect.objectContaining({ namespace: "theme", value: theme, revision: 1 }),
      ]);
      // The revision carries across, so a client that reconnects cannot see a
      // number it has already seen attached to different content.
      expect(second.currentRevision).toBe(1);
      second.set("theme", { ...theme, followSystem: true });
      expect(second.get("theme")[0]?.revision).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clearing is an edit of its own, and is broadcast like any other", () => {
    const changes: PrefsEntry[] = [];
    const store = new PrefsStore({ onChange: (entry) => changes.push(entry) });
    store.set("theme", { id: "graphite" });
    store.set("theme", null);

    expect(store.get("theme")).toEqual([]);
    expect(changes.map((c) => c.value)).toEqual([{ id: "graphite" }, null]);
    expect(changes.map((c) => c.revision)).toEqual([1, 2]);
  });

  it("lists every namespace, and only the one asked for when asked", () => {
    const store = new PrefsStore();
    store.set("theme", 1);
    store.set("panels", 2);
    expect(store.get().map((e) => e.namespace).sort()).toEqual(["panels", "theme"]);
    expect(store.get("panels").map((e) => e.value)).toEqual([2]);
    expect(store.get("nothing-here")).toEqual([]);
  });

  it("refuses a value too large to be a preference, and changes nothing", () => {
    const store = new PrefsStore();
    store.set("theme", { id: "graphite" });
    expect(() => store.set("theme", { blob: "x".repeat(400_000) })).toThrow(/too large/);
    expect(store.get("theme")[0]?.value).toEqual({ id: "graphite" });
    expect(store.currentRevision).toBe(1);
  });

  it("copies the value in, so a later mutation of the caller's object cannot reach it", () => {
    const store = new PrefsStore();
    const value = { id: "graphite", tokens: { bg: "dark" } };
    store.set("theme", value);
    value.tokens.bg = "light";
    expect(store.get("theme")[0]?.value).toEqual({ id: "graphite", tokens: { bg: "dark" } });
  });

  it("starts empty rather than failing to boot on a corrupt file", () => {
    const root = dir();
    try {
      const file = join(root, "prefs.json");
      writeFileSync(file, "{ not json");
      const store = new PrefsStore({ storePath: file });
      expect(store.get()).toEqual([]);
      // And it recovers: the next write replaces the unreadable file.
      store.set("theme", { id: "graphite" });
      store.close();
      expect(JSON.parse(readFileSync(file, "utf8")).namespaces.theme.value).toEqual({ id: "graphite" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
