import { describe, expect, it } from "vitest";
import type { ClientRequests, SessionSummary } from "@lasercode/protocol";
import { createCatalogLoader } from "../../src/runtime/catalog-loader.js";
type Result = ClientRequests["pi/session/list"]["result"];
type Params = ClientRequests["pi/session/list"]["params"];
const row = (id: number): SessionSummary => ({ path: `/s/${id}`, id: String(id), cwd: "/project", messageCount: 2, modifiedAt: "2026-06-01", createdAt: "2026-06-01" });
function harness() {
  let state: Result = { sessions: [] };
  const requests: Array<{ params: Params; resolve(value: Result): void }> = [];
  const loader = createCatalogLoader({
    request: params => new Promise(resolve => requests.push({ params, resolve })),
    current: () => state, apply: result => { state = result; }, exclude: () => ["/archived"], include: () => ["/remembered"],
  });
  return { loader, requests, state: () => state };
}
describe("catalog loader", () => {
  it("starts bounded, appends older rows, and refreshes the expanded quota", async () => {
    const h = harness(); const opening = h.loader.refresh();
    expect(h.loader.refresh()).toBe(opening);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.params).toEqual({ page: { size: 7, sizes: {}, exclude: ["/archived"], include: ["/remembered"] } });
    h.requests[0]!.resolve({ sessions: Array.from({ length: 7 }, (_, i) => row(i)), groups: [{ cwd: "/project", total: 20, cursor: "one" }] }); await opening;
    expect(h.loader.hasIncluded("/remembered")).toBe(true);
    expect(h.loader.hasIncluded("/not-included")).toBe(false);
    const more = h.loader.more("/project");
    expect(h.requests[1]!.params.page?.cursor).toBe("one");
    h.requests[1]!.resolve({ sessions: [row(6), row(7)], groups: [{ cwd: "/project", total: 20, cursor: "two" }] }); await more;
    expect(h.state().sessions).toHaveLength(8);
    const refresh = h.loader.refresh(); expect(h.requests[2]!.params.page?.sizes).toEqual({ "/project": 14 });
    h.requests[2]!.resolve({ sessions: [row(7)], groups: [{ cwd: "/project", total: 1 }] }); await refresh;
    expect(h.state().sessions.map(r => r.id)).toEqual(["7"]);
    expect(await h.loader.more("/project")).toBe(true); expect(h.requests).toHaveLength(3);
  });
  it("refuses a late page after refresh and keeps full-summary reads explicit", async () => {
    const h = harness(); const opening = h.loader.refresh();
    h.requests[0]!.resolve({ sessions: [row(0)], groups: [{ cwd: "/project", total: 20, cursor: "one" }] }); await opening;
    const more = h.loader.more("/project"); const refresh = h.loader.refresh();
    h.requests[2]!.resolve({ sessions: [row(2)], groups: [{ cwd: "/project", total: 1 }] }); await refresh;
    h.requests[1]!.resolve({ sessions: [row(1)], groups: [{ cwd: "/project", total: 20 }] });
    expect(await more).toBe(false); expect(h.state().sessions.map(r => r.id)).toEqual(["2"]);
    const release = h.loader.expand(); const expanded = h.loader.refresh(); expect(h.requests[3]!.params).toEqual({});
    h.requests[3]!.resolve({ sessions: [row(0), row(1)] }); await expanded; release();
    const collapsed = h.loader.refresh(); expect(h.requests[4]!.params.page?.size).toBe(7);
    h.requests[4]!.resolve({ sessions: [] }); await collapsed;
    const all = h.loader.all(); expect(h.requests[5]!.params).toEqual({}); h.requests[5]!.resolve({ sessions: [row(9)] });
    expect(await all).toEqual([row(9)]); expect(h.state().sessions).toEqual([]);
  });
});
