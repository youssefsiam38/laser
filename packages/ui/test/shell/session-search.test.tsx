// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useSessionSearch } from "../../src/components/shell/use-session-search.js";
import { ThreadSearch } from "../../src/components/assistant-ui/elements/thread-search.js";

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client }) }));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useSessionSearch>;
function Fixture({ query }: { query: string }) { state = useSessionSearch(query); return null; }
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.useFakeTimers(); client.request.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
it("ignores out-of-order replies and keeps recent results when explicitly extending history", async () => {
  let oldReply: (value: unknown) => void = () => {};
  client.request.mockImplementationOnce(() => new Promise(resolve => { oldReply = resolve; }));
  await act(async () => root.render(<Fixture query="pear" />));
  await act(async () => vi.advanceTimersByTime(250));
  const oldId = client.request.mock.calls[0]![1].searchId;
  client.request.mockResolvedValueOnce({}); // cancellation, not the next page
  client.request.mockResolvedValueOnce({ hits: [{ path: "recent", count: 1, excerpt: "Apple", source: "user" }], unreadable: 0 });
  await act(async () => root.render(<Fixture query="Apple" />));
  await act(async () => vi.advanceTimersByTime(250));
  await act(async () => oldReply({ hits: [{ path: "wrong", count: 1, excerpt: "pear", source: "user" }], unreadable: 0 }));
  expect(state.hits.map(h => h.path)).toEqual(["recent"]);
  expect(client.request).toHaveBeenCalledTimes(3);
  expect(client.request).toHaveBeenCalledWith("session/search/cancel", { searchId: oldId });
  client.request.mockResolvedValueOnce({ hits: [{ path: "older", count: 1, excerpt: "Apple", source: "assistant" }], unreadable: 0 });
  await act(async () => state.more());
  expect(state.hits.map(h => h.path)).toEqual(["recent", "older"]);
  expect(client.request.mock.calls[3]![1].before).toBe(client.request.mock.calls[2]![1].after);
});
it("retries the failed older period instead of restarting recent history", async () => {
  client.request.mockResolvedValueOnce({ hits: [], unreadable: 0 });
  await act(async () => root.render(<Fixture query="Apple" />));
  await act(async () => vi.advanceTimersByTime(250));
  client.request.mockRejectedValueOnce(new Error("offline"));
  await act(async () => state.more());
  expect(state.error).toBe(true);
  client.request.mockResolvedValueOnce({ hits: [], unreadable: 0 });
  await act(async () => state.retry());
  const { searchId: _old, ...prior } = client.request.mock.calls[1]![1];
  expect(client.request.mock.calls[2]![1]).toMatchObject(prior);
  expect(state.period).toBe(1);
});
it("renders the real excerpt as in-flow escaped text with highlighted matches", async () => {
  await act(async () => root.render(<ThreadSearch grouped={false} query="Apple" activeId="one" threads={[{ id: "one", title: "Orchard", group: "Project", preview: "", status: "idle", matchCount: 1, matchSource: "user", excerpt: '<script>Apple</script> ' + "x".repeat(400) }]} />));
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("mark")?.textContent).toBe("Apple");
  const excerpt = container.querySelector('[data-slot="session-search-excerpt"]')!;
  expect(excerpt.closest('[role="option"]')).not.toBeNull();
  expect(excerpt.className).toContain("[overflow-wrap:anywhere]");
  expect(excerpt.textContent).toContain("Your message");
});

it("cancels an in-flight host scan when the search surface closes", async () => {
  client.request.mockImplementation((method: string) => method === "session/search" ? new Promise(() => {}) : Promise.resolve({}));
  await act(async () => root.render(<Fixture query="huge" />));
  await act(async () => vi.advanceTimersByTime(250));
  const searchId = client.request.mock.calls[0]![1].searchId;
  await act(async () => root.render(null));
  expect(client.request).toHaveBeenCalledWith("session/search/cancel", { searchId });
});
