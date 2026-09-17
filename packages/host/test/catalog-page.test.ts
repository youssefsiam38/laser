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
    expect(first.sessions.map(r => r.id)).toEqual(["7", "8", "9", "10", "11", "12", "13", "14", "18", "40", "41"]);
    expect(first.archivedCount).toBe(7);
    expect(first.presence).toEqual({ [rows[10]!.path]: true, [rows[19]!.path]: true, "/missing": false });
    expect(first.groups?.[0]).toMatchObject({ total: 15, remaining: 4 });
    const more = pageCatalog(rows, { page: { cursor: first.groups![0]!.cursor!, exclude: rows.slice(0, 7).map(r => r.path) } }, groupOf);
    expect(more.sessions.map(r => r.id)).toEqual(["15", "16", "17", "18", "19", "40", "41"]);
    expect(more.sessions.filter(row => !first.sessions.some(firstRow => firstRow.path === row.path))).toHaveLength(first.groups![0]!.remaining!);
    expect(more.groups?.[0]).toMatchObject({ remaining: 0 });
    expect(more.groups?.[0]?.cursor).toBeUndefined();
  });
  it("keeps cwd-scoped pages scoped even when another project has important rows", () => {
    const rows = [
      row(1, { cwd: "/A", path: "/A/1.jsonl" }),
      row(2, { cwd: "/B", path: "/B/child.jsonl", parentPath: "/A/1.jsonl" }),
      row(100, { cwd: "/B", path: "/B/100.jsonl", attention: "waiting_for_input" }),
    ];
    const page = pageCatalog(rows, { cwd: "/A", page: { size: 7 } }, groupOf);
    expect(page.sessions.map(item => item.path)).toEqual(["/A/1.jsonl"]);
    expect(page.groups?.map(group => group.cwd)).toEqual(["/A"]);
  });
  it("counts and pages prospective roots rather than collapsed child rows", () => {
    const roots = Array.from({ length: 10 }, (_, index) => row(index, { path: `/sessions/root-${index}` }));
    const children = roots.map((parent, index) => row(index + 100, { path: `/sessions/child-${index}`, parentPath: parent.path }));
    const rows = roots.flatMap((root, index) => [root, children[index]!]);
    const first = pageCatalog(rows, { page: { size: 4 } }, groupOf);
    expect(first.sessions).toHaveLength(8);
    expect(first.groups?.[0]).toMatchObject({ remaining: 6 });
    const second = pageCatalog(rows, { cwd: "/project", page: { cursor: first.groups![0]!.cursor! } }, groupOf);
    expect(second.sessions).toHaveLength(12);
    expect(second.groups?.[0]).toMatchObject({ remaining: 0 });
  });
  it("supports expanded refreshes, deterministic ties, and malformed cursor refusal", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i)).reverse();
    const page = pageCatalog(rows, { page: { sizes: { "/project": 14 } } }, groupOf);
    expect(page.sessions).toHaveLength(14);
    expect(page.groups?.[0]?.remaining).toBe(6);
    expect(() => pageCatalog(rows, { page: { cursor: "garbage" } }, groupOf)).toThrow("Refresh the list");
  });
});
