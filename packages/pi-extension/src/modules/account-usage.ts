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
// Verified with existing Pi OAuth credentials. /codex/usage can return a web
// security challenge even for a valid account; it is not an auth probe/fallback.
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const MAX_RESPONSE_BYTES = 1_000_000;

type RecordValue = Record<string, unknown>;

export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return provider === PROVIDER || /^openai-codex-\d+$/.test(provider ?? "");
}

export function parseOpenAICodexUsage(payload: unknown, provider = PROVIDER): AccountUsageSnapshot | undefined {
  const root = record(payload);
  if (!root) return undefined;
  const windows: AccountUsageSnapshot["windows"] = [];
  const seen = new Set<string>();
  const append = (value: unknown, id?: string, name?: string) => {
    const bucket = record(value);
    if (!bucket) return;
    const rate = record(bucket["rate_limit"]) ?? bucket;
    for (const kind of ["primary", "secondary"] as const) {
      const window = parseWindow(rate[`${kind}_window`] ?? rate[kind], kind);
      const key = `${id ?? "codex"}:${kind}`;
      if (!window || seen.has(key)) continue;
      seen.add(key);
      windows.push({ ...window, ...(id ? { limitId: id } : {}), ...(name ? { limitName: name } : {}) });
    }
  };
  // The app-server's map and single bucket are two views of the SAME data.
  // Prefer the map; never search recursively and accidentally pick one bucket.
  const byId = record(root["rateLimitsByLimitId"]);
  const primary = record(root["rate_limit"] ?? root["rateLimits"]);
  if (byId && Object.keys(byId).length) {
    for (const [id, value] of Object.entries(byId)) append(value, id, string(record(value)?.["limitName"]));
  } else {
    append(primary, string(primary?.["limitId"]), string(primary?.["limitName"]));
    if (Array.isArray(root["additional_rate_limits"])) {
      for (const value of root["additional_rate_limits"]) {
        const bucket = record(value);
        const id = string(bucket?.["metered_feature"]);
        if (id) append(bucket, id, string(bucket?.["limit_name"]));
      }
    }
    append(root["code_review_rate_limit"], "code-review", "Code review");
  }

  const creditsRecord = record(root["credits"] ?? primary?.["credits"] ?? record(byId?.["codex"])?.["credits"]);
  const credits = creditsRecord ? parseCredits(creditsRecord) : undefined;
  if (windows.length === 0 && !credits) return undefined;
  const planType = string(root["plan_type"] ?? root["planType"] ?? primary?.["planType"] ?? record(byId?.["codex"])?.["planType"]);
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
    let disposed = false;

    const emit = (status: AccountUsageState["status"], message?: string) => {
      if (disposed) return;
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
        .catch(() => emit("unavailable", "Could not read your account credentials. Try refresh again or check the connected account in Providers."))
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
    return () => { disposed = true; offCommand?.(); };
  },
};

async function readAccountUsage(
  ctx: ModuleContext,
): Promise<{ snapshot?: AccountUsageSnapshot; message?: string }> {
  const session = ctx.session;
  if (!session) return { message: "Account usage is not available in this session." };
  const model = [session.model, ...session.modelRegistry.getAvailable()].find(
    (candidate) => candidate && isOpenAICodexProvider(candidate.provider),
  );
  if (!model) return { message: "No OpenAI Codex account model is available." };

  const auth = await session.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return { message: "Connect your OpenAI account to see its allowance." };
  const accountId = accountIdFromToken(auth.apiKey);
  if (!accountId) return { message: "This credential does not identify a ChatGPT account. Connect an OpenAI subscription account in Providers." };

  const headers = {
    Authorization: `Bearer ${auth.apiKey}`,
    "ChatGPT-Account-ID": accountId,
    Accept: "application/json",
    "User-Agent": PRODUCT_DISPLAY_NAME,
  };

  try {
    const response = await fetch(USAGE_ENDPOINT, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    const html = response.headers.get("content-type")?.includes("text/html");
    if (response.headers.get("cf-mitigated") === "challenge" || html) {
      await response.body?.cancel();
      return { message: "OpenAI's web security check blocked the allowance lookup. Try again later or check your network; reconnecting your account will not resolve this check." };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) return { message: "OpenAI rejected this account's authentication. Reconnect your OpenAI account in Providers and retry." };
      if (response.status === 403) return { message: "OpenAI denied access to this account's allowance. Check your account or workspace permissions, then retry." };
      if (response.status === 429) return { message: "OpenAI is limiting allowance lookups. Wait a moment, then refresh again." };
      return { message: "OpenAI's allowance service is unavailable right now. Try refresh again later." };
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return { message: `OpenAI returned more allowance data than ${PRODUCT_DISPLAY_NAME} can safely read.` };
    }
    // Enforce the bound while reading, including chunked responses.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { message: `OpenAI returned more allowance data than ${PRODUCT_DISPLAY_NAME} can safely read.` };
      }
      chunks.push(value);
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return { message: "OpenAI returned allowance data in an unsupported format. Try refresh again later." }; }
    const snapshot = parseOpenAICodexUsage(payload, model.provider);
    return snapshot
      ? { snapshot }
      : { message: "OpenAI returned allowance data in an unsupported format." };
  } catch {
    return { message: "Could not reach OpenAI for a fresh allowance. Check your connection and try again." };
  }
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
  const minutes = number(raw["windowDurationMins"]);
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
