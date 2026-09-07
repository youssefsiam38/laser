import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCommandBus, type ModuleContext } from "../src/modules/index.js";
import { accountUsageModule, isOpenAICodexProvider, parseOpenAICodexUsage } from "../src/modules/account-usage.js";

afterEach(()=>vi.unstubAllGlobals());

function moduleHarness() {
  const token=`header.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test-account"}})).toString("base64url")}.signature`;
  const model={provider:"openai-codex",id:"test"};
  const auth=vi.fn().mockResolvedValue({ok:true,apiKey:token});
  const commands=createCommandBus();
  const send=vi.fn();
  const ctx:ModuleContext={pi:{on:vi.fn()} as unknown as ExtensionAPI,session:{model,modelRegistry:{getAll:()=>[model],getAvailable:()=>[model],getApiKeyAndHeaders:auth}} as unknown as ExtensionContext,send,commands};
  return {ctx,auth,commands,send};
}

it("loads subscription quota and refreshes it without emitting credentials or sending a model request",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:20}}})))
    .mockResolvedValueOnce(new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:35}}})));
  vi.stubGlobal("fetch",fetcher);
  const h=moduleHarness();
  const stop=await accountUsageModule.activate(h.ctx);
  await vi.waitFor(()=>expect(h.send).toHaveBeenCalledWith(expect.objectContaining({state:expect.objectContaining({status:"ready",snapshot:expect.objectContaining({windows:[{kind:"primary",usedPercent:20}]})})})));
  expect(h.commands.deliver({type:"lasercode/account-usage/refresh"})).toBe(true);
  await vi.waitFor(()=>expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({state:expect.objectContaining({status:"ready",snapshot:expect.objectContaining({windows:[{kind:"primary",usedPercent:35}]})})})));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url])=>url === "https://chatgpt.com/backend-api/wham/usage")).toBe(true);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({redirect:"error",headers:{"ChatGPT-Account-ID":"test-account"}});
  expect(JSON.stringify(h.send.mock.calls)).not.toContain("test-account");
  expect(JSON.stringify(h.send.mock.calls)).not.toContain("signature");
  stop?.();
});

it("leaves loading on credential failure and allows a subsequent retry",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({rate_limit:{primary_window:{used_percent:1}}}))));
  const h=moduleHarness();h.auth.mockRejectedValueOnce(new Error("credential failure containing sensitive data"));
  const stop=await accountUsageModule.activate(h.ctx);
  await vi.waitFor(()=>expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({state:expect.objectContaining({status:"unavailable"})})));
  expect(JSON.stringify(h.send.mock.calls)).not.toContain("sensitive data");
  h.commands.deliver({type:"lasercode/account-usage/refresh"});
  await vi.waitFor(()=>expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({state:expect.objectContaining({status:"ready"})})));
  stop?.();
});

describe("OpenAI Codex account usage", () => {
  it("preserves source-shaped named buckets without adding percentages or inventing null windows", () => {
    const window = { used_percent: 24, limit_window_seconds: 18_000, reset_at: 1_800_000_000 };
    const snapshot = parseOpenAICodexUsage({
      rate_limit: { primary_window: window, secondary_window: null },
      additional_rate_limits: [
        { metered_feature: "codex_bengalfox", limit_name: "GPT-5.3-Codex-Spark", rate_limit: { primary_window: { ...window, used_percent: 0 }, secondary_window: { ...window, used_percent: 61, limit_window_seconds: 604_800 } } },
        { metered_feature: "base_model_inference", limit_name: "gpt-reserve", rate_limit: { primary_window: window } },
      ],
      code_review_rate_limit: null,
      email: "private@example.invalid", account_id: "private-account",
    });
    expect(snapshot?.windows).toEqual([
      { kind: "primary", usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", kind: "primary", usedPercent: 0, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", kind: "secondary", usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
      { limitId: "base_model_inference", limitName: "gpt-reserve", kind: "primary", usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("prefers the app-server map over its duplicate single-bucket view", () => {
    const primary = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 };
    const codex = { limitId: "codex", primary, secondary: null, planType: "pro", credits: { hasCredits: true, unlimited: false, balance: "20.00" } };
    const snapshot = parseOpenAICodexUsage({ rateLimits: codex, rateLimitsByLimitId: {
      codex, other: { limitName: "Other allowance", primary: { ...primary, usedPercent: 42 } },
    } });
    expect(snapshot).toMatchObject({ planType: "pro", credits: { balance: "20.00" }, windows: [
      { limitId: "codex", kind: "primary", usedPercent: 25, windowDurationMins: 300 },
      { limitId: "other", limitName: "Other allowance", kind: "primary", usedPercent: 42, windowDurationMins: 300 },
    ] });
  });

  it("does not turn missing quota into zero and supports credit-only accounts", () => {
    expect(parseOpenAICodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toBeUndefined();
    expect(parseOpenAICodexUsage({ rate_limit: null, credits: { has_credits: true, unlimited: true } }))
      .toMatchObject({ windows: [], credits: { hasCredits: true, unlimited: true } });
  });
  it("recognizes Pi's named account providers", () => {
    expect(isOpenAICodexProvider("openai-codex")).toBe(true);
    expect(isOpenAICodexProvider("openai-codex-2")).toBe(true);
    expect(isOpenAICodexProvider("openai")).toBe(false);
  });

  it("normalizes allowance windows and purchased credits without credentials", () => {
    const snapshot = parseOpenAICodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 24.5, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
      },
      credits: { has_credits: true, unlimited: false, balance: "42.7500" },
      access_token: "must not cross the boundary",
    });
    expect(snapshot).toMatchObject({
      provider: "openai-codex",
      planType: "pro",
      windows: [
        { kind: "primary", usedPercent: 24.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        { kind: "secondary", usedPercent: 61, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: "42.7500" },
    });
    expect(snapshot).not.toHaveProperty("access_token");
  });

  it("accepts the camel-case app-server-shaped window vocabulary", () => {
    expect(parseOpenAICodexUsage({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }))
      .toMatchObject({ windows: [{ kind: "primary", usedPercent: 10, windowDurationMins: 300 }] });
    expect(parseOpenAICodexUsage({ unrelated: true })).toBeUndefined();
  });
});

it.each([
  [403, { "content-type": "text/html", "cf-mitigated": "challenge" }, "security check", false],
  [401, { "content-type": "application/json" }, "Reconnect", true],
  [403, { "content-type": "application/json" }, "permissions", false],
  [429, { "content-type": "application/json" }, "Wait a moment", false],
  [503, { "content-type": "application/json" }, "unavailable", false],
] as const)("classifies HTTP %s with its actual recovery", async (status, headers, expected, reconnect) => {
  const fetcher = vi.fn().mockResolvedValue(new Response("private response body", { status, headers }));
  vi.stubGlobal("fetch", fetcher);
  const h = moduleHarness();
  const stop = await accountUsageModule.activate(h.ctx);
  await vi.waitFor(() => expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.objectContaining({ status: "unavailable", message: expect.stringContaining(expected) }) })));
  const message = h.send.mock.calls.at(-1)![0].state.message;
  expect(message.startsWith("OpenAI rejected")).toBe(reconnect);
  expect(message).not.toContain("private response body");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe("https://chatgpt.com/backend-api/wham/usage");
  stop?.();
});

it("keeps the last good reading after a timeout and refresh remains retryable", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 } } })))
    .mockRejectedValueOnce(new DOMException("private token", "TimeoutError"))
    .mockResolvedValueOnce(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 35 } } })));
  vi.stubGlobal("fetch", fetcher);
  const h = moduleHarness();
  const stop = await accountUsageModule.activate(h.ctx);
  await vi.waitFor(() => expect(h.send.mock.calls.at(-1)?.[0].state.status).toBe("ready"));
  h.commands.deliver({ type: "lasercode/account-usage/refresh" });
  await vi.waitFor(() => expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining({ state: expect.objectContaining({ status: "unavailable", message: expect.stringContaining("connection"), snapshot: expect.objectContaining({ windows: [{ kind: "primary", usedPercent: 20 }] }) }) })));
  expect(JSON.stringify(h.send.mock.calls)).not.toContain("private token");
  h.commands.deliver({ type: "lasercode/account-usage/refresh" });
  await vi.waitFor(() => expect(h.send.mock.calls.at(-1)?.[0].state.snapshot.windows[0].usedPercent).toBe(35));
  stop?.();
});

it.each(["not-json", " ".repeat(1_000_001)])("rejects invalid or oversized bodies without exposing them", async body => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
  const h = moduleHarness();
  const stop = await accountUsageModule.activate(h.ctx);
  await vi.waitFor(() => expect(h.send.mock.calls.at(-1)?.[0].state.status).toBe("unavailable"));
  expect(h.send.mock.calls.at(-1)?.[0].state.message).toMatch(/unsupported format|safely read/);
  stop?.();
});

it("does not make an HTTP request when the engine cannot resolve credentials", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const h = moduleHarness(); h.auth.mockResolvedValueOnce({ ok: false });
  const stop = await accountUsageModule.activate(h.ctx);
  await vi.waitFor(() => expect(h.send.mock.calls.at(-1)?.[0].state.status).toBe("unavailable"));
  expect(fetcher).not.toHaveBeenCalled(); stop?.();
});
