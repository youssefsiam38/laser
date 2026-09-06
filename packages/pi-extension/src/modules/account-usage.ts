/**
 * OpenAI Codex account allowance.
 *
 * Pi owns OAuth and model selection; this module only asks Pi for the current
 * credential, reads the provider's bounded account snapshot, and emits a
 * provider-neutral value. No token, account id, or raw response crosses the
 * extension boundary.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import type { AccountCredits, AccountUsageSnapshot, AccountUsageState } from "@lasercode/protocol";
import type { LaserModule, ModuleContext } from "./index.js";

const PROVIDER = "openai-codex";
const USAGE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/codex/usage",
  "https://chatgpt.com/backend-api/wham/usage",
] as const;
const MAX_RESPONSE_BYTES = 1_000_000;

type RecordValue = Record<string, unknown>;

export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return provider === PROVIDER || /^openai-codex-\d+$/.test(provider ?? "");
}

export function parseOpenAICodexUsage(payload: unknown, provider = PROVIDER): AccountUsageSnapshot | undefined {
  const root = record(payload);
  if (!root) return undefined;
  const rateLimits = findRecord(root, (value) => {
    const nested = record(value["rate_limit"] ?? value["rate_limits"] ?? value["rateLimit"] ?? value["rateLimits"]);
    return nested && hasWindow(nested) ? nested : hasWindow(value) ? value : undefined;
  });
  if (!rateLimits) return undefined;

  const windows = [
    parseWindow(rateLimits["primary_window"] ?? rateLimits["primaryWindow"] ?? rateLimits["primary"], "primary"),
    parseWindow(rateLimits["secondary_window"] ?? rateLimits["secondaryWindow"] ?? rateLimits["secondary"], "secondary"),
  ].filter((window): window is NonNullable<typeof window> => window !== undefined);
  if (windows.length === 0) return undefined;

  const creditsRecord = findRecord(root, (value) => record(value["credits"]));
  const credits = creditsRecord ? parseCredits(creditsRecord) : undefined;
  const planType = string(root["plan_type"] ?? root["planType"]);
  return {
    provider,
    ...(planType ? { planType } : {}),
    fetchedAt: new Date().toISOString(),
    windows,
    ...(credits ? { credits } : {}),
  };
}

export const accountUsageModule: LaserModule = {
  name: "account-usage",
  detect: ({ session }) =>
    session?.modelRegistry.getAll().some((model) => isOpenAICodexProvider(model.provider)) ?? false,
  activate(ctx) {
    let last: AccountUsageSnapshot | undefined;
    let pending: Promise<void> | undefined;

    const emit = (status: AccountUsageState["status"], message?: string) => {
      ctx.send({
        type: "lasercode/account-usage/state",
        state: {
          provider: last?.provider ?? PROVIDER,
          status,
          ...(last ? { snapshot: last } : {}),
          ...(message ? { message } : {}),
        },
      });
    };

    const refresh = async () => {
      emit("loading");
      const result = await readAccountUsage(ctx);
      if (result.snapshot) {
        last = result.snapshot;
        emit("ready");
      } else {
        emit("unavailable", result.message);
      }
    };
    const queue = () => {
      if (!pending) pending = refresh()
        .catch(() => emit("unavailable", "Could not refresh your account credentials. Reconnect your OpenAI account in Providers and try again."))
        .finally(() => { pending = undefined; });
      return pending;
    };
    const updateContext = (session: ModuleContext["session"]) => {
      if (session) ctx.session = session;
      void queue();
    };

    void queue();
    ctx.pi.on("model_select", (_event, session) => updateContext(session));
    ctx.pi.on("agent_end", (_event, session) => updateContext(session));
    const offCommand = ctx.commands?.on((command) => {
      if (command.type !== "lasercode/account-usage/refresh") return false;
      void queue();
      return true;
    });
    return () => offCommand?.();
  },
};

async function readAccountUsage(
  ctx: ModuleContext,
): Promise<{ snapshot?: AccountUsageSnapshot; message?: string }> {
  const session = ctx.session;
  if (!session) return { message: "Account usage is not available in this session." };
  const model = [session.model, ...session.modelRegistry.getAll()].find(
    (candidate) => candidate && isOpenAICodexProvider(candidate.provider),
  );
  if (!model) return { message: "No OpenAI Codex account model is available." };

  const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return { message: "Connect your OpenAI account to see its allowance." };
  const accountId = accountIdFromToken(auth.apiKey);
  if (!accountId) return { message: "Reconnect your OpenAI account to refresh its allowance." };

  const headers = {
    Authorization: `Bearer ${auth.apiKey}`,
    "ChatGPT-Account-ID": accountId,
    "OpenAI-Beta": "codex-1",
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/codex/cloud/settings/analytics",
    "User-Agent": PRODUCT_DISPLAY_NAME,
  };

  for (const endpoint of USAGE_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        if (response.status === 404) continue;
        return { message: response.status === 401 || response.status === 403
          ? "Reconnect your OpenAI account to refresh its allowance."
          : "OpenAI did not return account allowance right now. Try refresh again." };
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
        return { message: `OpenAI returned more allowance data than ${PRODUCT_DISPLAY_NAME} can safely read.` };
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        return { message: `OpenAI returned more allowance data than ${PRODUCT_DISPLAY_NAME} can safely read.` };
      }
      const snapshot = parseOpenAICodexUsage(JSON.parse(text), model.provider);
      return snapshot
        ? { snapshot }
        : { message: "OpenAI returned allowance data in an unsupported format." };
    } catch {
      // The legacy endpoint is a compatibility fallback only when the current
      // endpoint is unavailable, not when it rejects valid authentication.
      if (endpoint !== USAGE_ENDPOINTS.at(-1)) continue;
    }
  }
  return { message: "Could not reach OpenAI for a fresh allowance. Check your connection and try again." };
}

function accountIdFromToken(token: string): string | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RecordValue;
    const auth = record(payload["https://api.openai.com/auth"]);
    return string(auth?.["chatgpt_account_id"]);
  } catch {
    return undefined;
  }
}

function parseWindow(value: unknown, kind: "primary" | "secondary") {
  const raw = record(value);
  if (!raw) return undefined;
  const usedPercent = number(raw["used_percent"] ?? raw["usedPercent"]);
  if (usedPercent === undefined) return undefined;
  const seconds = number(raw["limit_window_seconds"] ?? raw["window_seconds"] ?? raw["windowSeconds"]);
  const minutes = number(raw["window_minutes"] ?? raw["windowMinutes"]);
  const resetsAt = number(raw["reset_at"] ?? raw["resets_at"] ?? raw["resetsAt"]);
  return {
    kind,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(seconds !== undefined ? { windowDurationMins: seconds / 60 } : minutes !== undefined ? { windowDurationMins: minutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  } as const;
}

function parseCredits(raw: RecordValue): AccountCredits | undefined {
  const balance = string(raw["balance"]);
  const hasCredits = boolean(raw["has_credits"] ?? raw["hasCredits"]);
  const unlimited = boolean(raw["unlimited"]);
  if (balance === undefined && hasCredits === undefined && unlimited === undefined) return undefined;
  return {
    hasCredits: hasCredits ?? balance !== undefined,
    unlimited: unlimited ?? false,
    ...(balance !== undefined ? { balance } : {}),
  };
}

function hasWindow(value: RecordValue): boolean {
  return ["primary_window", "primaryWindow", "primary", "secondary_window", "secondaryWindow", "secondary"]
    .some((key) => record(value[key]) !== undefined);
}

function findRecord(root: RecordValue, pick: (value: RecordValue) => RecordValue | undefined): RecordValue | undefined {
  const queue: Array<{ value: RecordValue; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<RecordValue>();
  for (let i = 0; i < queue.length && i < 1_000; i++) {
    const current = queue[i]!;
    const found = pick(current.value);
    if (found) return found;
    if (current.depth >= 5 || seen.has(current.value)) continue;
    seen.add(current.value);
    for (const nested of Object.values(current.value)) {
      const child = record(nested);
      if (child) queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : undefined;
}
