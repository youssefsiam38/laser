import type { AccountUsageWindow } from "@lasercode/protocol";

export type ResetDisplay = "remaining" | "time";
export interface AllowanceGroup { id: string; name: string; windows: AccountUsageWindow[] }
export interface AllowanceExplanation { text: string; source?: string }
const PRICING = "https://learn.chatgpt.com/docs/pricing";
const SPEED = "https://learn.chatgpt.com/docs/agent-configuration/speed";

/** Presentation only: preserve every server window. Names never merge distinct IDs. */
export function groupAllowances(windows: readonly AccountUsageWindow[]): AllowanceGroup[] {
  const groups = new Map<string, AllowanceGroup>();
  for (const window of windows) {
    const id = window.limitId ? `id:${window.limitId}` : window.limitName ? `name:${window.limitName}` : "default";
    let group = groups.get(id);
    if (!group) {
      group = { id, name: window.limitName ?? window.limitId ?? "Codex", windows: [] };
      groups.set(id, group);
    }
    group.windows.push(window);
  }
  return [...groups.values()];
}

/** Reviewed against official sources; unknown names must not inherit guessed model semantics.
 * See docs/account-usage-research.md. The full settings view retains all API data;
 * only the compact chat view filters out undocumented buckets.
 */
export function allowanceExplanation(group: Pick<AllowanceGroup, "id" | "name">): AllowanceExplanation {
  const name = group.name.toLowerCase();
  if (group.id === "id:codex_bengalfox" || name === "gpt-5.3-codex-spark") return {
    text: "Codex Spark is a separate model for fast, interactive coding. It trades capability for near-instant responses; it is not standard GPT-5.3-Codex running in fast mode. Spark has its own usage limits.", source: SPEED,
  };
  if (group.id === "id:base_model_inference" || name === "gpt-reserve") return {
    text: `OpenAI reports this allowance under the name ${group.name}. Its precise purpose is not defined in the public documentation we reviewed. These are the limits and reset times returned for your account—not a model recommendation or a purchased-credit balance.`,
  };
  if (group.id === "id:code-review" || name === "code review") return {
    text: "This allowance covers Codex reviews through GitHub, such as requested pull-request reviews and automatic reviews. Reviews performed locally count toward general usage instead.", source: PRICING,
  };
  if (group.id === "default" || group.id === "id:codex" || name === "codex") return {
    text: "Your account's general Codex allowance, shared by local and cloud tasks. Usage depends on the model and work performed, not simply the number of messages. This is account-wide, not the usage of this session alone.", source: PRICING,
  };
  return { text: "An allowance reported by your provider. Its specific purpose is not documented here. The name, usage windows and reset times are shown as received; do not assume it is a separate model or add its percentage to other allowances." };
}

export const creditsExplanation: AllowanceExplanation = {
  text: "Credits can pay for eligible usage after included limits are reached. This is the balance reported for your account, separate from the percentage allowances. Credit rules and eligible features depend on your plan.", source: PRICING,
};

export function allowanceWindowLabel(minutes: number | undefined, kind: string): string {
  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    if (minutes === 10_080) return "Weekly allowance";
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day allowance`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour allowance`;
    return `${minutes}-minute allowance`;
  }
  return kind === "primary" ? "Primary allowance" : kind === "secondary" ? "Secondary allowance" : "Account allowance";
}

export function resetLabel(timestamp: number | undefined, display: ResetDisplay, now: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "Reset unavailable";
  const date = new Date(timestamp * 1_000);
  if (Number.isNaN(date.getTime())) return "Reset unavailable";
  if (display === "time") return `Resets ${date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
  const ms = date.getTime() - now;
  // A clock reaching zero is not evidence that the provider renewed its quota.
  if (ms <= 0) return "Reset due · refresh to check";
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor(minutes % 1_440 / 60);
  const remainder = minutes % 60;
  return `Resets in ${[days ? `${days}d` : "", hours ? `${hours}h` : "", remainder ? `${remainder}m` : ""].filter(Boolean).join(" ")}`;
}
