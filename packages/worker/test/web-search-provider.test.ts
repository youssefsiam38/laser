import { afterEach, expect, it, vi } from "vitest";
import { searchFailure, searchWithProvider } from "../dist/web-search-provider.js";
import type { SearchJob } from "../src/web-search-execution.js";

afterEach(() => vi.unstubAllGlobals());
const job: SearchJob = { provider: "duckduckgo", query: "test", connection: { source: "none" }, options: {} };

it("accepts a genuine empty search but rejects challenge and malformed pages", async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response('<div class="no-results">No results</div>'))
    .mockResolvedValueOnce(new Response('<form id="challenge-form">bots use DuckDuckGo</form>', { status: 202 }))
    .mockResolvedValueOnce(new Response('<html>unexpected</html>'));
  vi.stubGlobal("fetch", request);
  expect(JSON.parse(await searchWithProvider(job))).toMatchObject({ provider: "duckduckgo", results: [] });
  await expect(searchWithProvider(job)).rejects.toThrow(/verification/);
  await expect(searchWithProvider(job)).rejects.toThrow(/invalid response/);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["openai", "openai-codex"])("uses only the granted %s endpoint and parses source-shaped SSE", async (provider) => {
  const token = provider === "openai" ? "private-test-key" : `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
  const output = [{ type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://example.com", title: "Source" }] } },
    { type: "message", content: [{ type: "output_text", text: "Grounded answer", annotations: [{ type: "url_citation", url: "https://example.com", title: "Source" }] }] }];
  const request = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", request);
  const response = JSON.parse(await searchWithProvider({ ...job, provider: "openai", authentication: { provider, apiKey: token, models: [{ id: "gpt-5.6-terra", provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses", baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api" }] } }));
  expect(response).toMatchObject({ provider: "openai", answer: "Grounded answer" });
  expect(response.results[0].url).toBe("https://example.com/");
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(provider === "openai" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses");
  expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  if (provider === "openai-codex") expect(init.headers).toMatchObject({ "chatgpt-account-id": "test-account" });
  expect(JSON.parse(init.body as string)).toMatchObject({ tools: [{ type: "web_search" }], tool_choice: "required", stream: true, store: false });
});

it.each([
  ["DuckDuckGo requires bot verification (challenge response)", "browser verification"],
  ["OpenAI API error 401: secret=private-key", "HTTP 401"],
  ["OpenAI API error 429: private-key", "rate or usage limit"],
  ["DuckDuckGo returned no parseable results (invalid response)", "unusable response"],
  ["fetch failed private-key", "network"],
])("reports a safe actionable failure: %s", (message, expected) => {
  const failure = searchFailure(job, new Error(message));
  expect(failure).toContain("DuckDuckGo");
  expect(failure).toContain(expected);
  expect(failure).toContain("No other provider was used");
  expect(failure).not.toContain("private-key");
});
