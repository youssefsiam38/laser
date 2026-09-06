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
  const ctx:ModuleContext={pi:{on:vi.fn()} as unknown as ExtensionAPI,session:{model,modelRegistry:{getAll:()=>[model],getApiKeyAndHeaders:auth}} as unknown as ExtensionContext,send,commands};
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
  expect(fetcher.mock.calls.every(([url])=>String(url).endsWith("/usage"))).toBe(true);
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
    expect(parseOpenAICodexUsage({ rateLimits: { primary: { usedPercent: 10, windowMinutes: 300 } } }))
      .toMatchObject({ windows: [{ kind: "primary", usedPercent: 10, windowDurationMins: 300 }] });
    expect(parseOpenAICodexUsage({ unrelated: true })).toBeUndefined();
  });
});
