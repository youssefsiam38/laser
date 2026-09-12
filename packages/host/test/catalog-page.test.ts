import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@lasercode/protocol";
import { pageCatalog } from "../src/catalog-page.js";
const row = (index: number, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  path: `/sessions/${String(index).padStart(3, "0")}`, id: String(index), cwd: "/project",
  createdAt: "2026-06-01", modifiedAt: "2026-06-01", messageCount: 2, ...patch,
});
const groupOf = (row: SessionSummary) => row.cwd;
describe("catalog pages", () => {
  it("refills past archived rows, pins empty/attention rows and ancestors, and deduplicates", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i));
    rows.push(row(40, { messageCount: 0 }), row(41, { attention: "waiting_for_input", parentPath: rows[18]!.path }));
    const first = pageCatalog(rows, { page: { exclude: rows.slice(0, 7).map(r => r.path), include: [rows[10]!.path], probe: [rows[19]!.path, "/missing"] } }, groupOf);
    expect(first.sessions.map(r => r.id)).toEqual(["7", "8", "9", "10", "11", "12", "13", "18", "40", "41"]);
    expect(first.archivedCount).toBe(7);
    expect(first.presence).toEqual({ [rows[10]!.path]: true, [rows[19]!.path]: true, "/missing": false });
    expect(first.groups?.[0]?.total).toBe(15);
    const more = pageCatalog(rows, { page: { cursor: first.groups![0]!.cursor!, exclude: rows.slice(0, 7).map(r => r.path) } }, groupOf);
    expect(more.sessions.map(r => r.id)).toEqual(["14", "15", "16", "17", "18", "19", "40", "41"]);
    expect(more.groups?.[0]?.cursor).toBeUndefined();
  });
  it("supports expanded refreshes, deterministic ties, and malformed cursor refusal", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i)).reverse();
    expect(pageCatalog(rows, { page: { sizes: { "/project": 14 } } }, groupOf).sessions).toHaveLength(14);
    expect(() => pageCatalog(rows, { page: { cursor: "garbage" } }, groupOf)).toThrow("Refresh the list");
  });
});
