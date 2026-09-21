/**
 * Naming — the one small request that titles a conversation from its first
 * prompt.
 *
 * It is not an agent, has no identity, no editable prompt and no state
 * (D-347). It is a **one-shot walk of the naming profile**
 * (`docs/model-profiles.md`, "Runtime"): one small completion per model, in
 * the profile's own order, with an 8 s ceiling each, stopping at the first
 * usable title. There is no benchmark, no candidate ranking and no
 * qualification step — the person chose an ordered list of models, and that
 * list is the answer.
 *
 * It never throws, creates no session and appears in no fleet row: a name that
 * does not arrive is simply not shown, and a request that cannot start does
 * not run.
 */
import { SESSION_NAME_MAX, SESSION_NAME_MIN, type ModelIdentity, type ModelProfile } from "@lasercode/protocol";

export const NAMING_TIMEOUT_MS = 8_000;

/** The engine's model runtime, reduced to what one bounded completion needs. */
export interface CompletionModel {
  provider: string;
  id: string;
}

export interface CompletionContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

export interface CompletionResult {
  content: ReadonlyArray<{ type: string; text?: string }>;
}

export interface CompletionRuntime {
  getModel(provider: string, id: string): CompletionModel | undefined;
  completeSimple(model: CompletionModel, context: CompletionContext, options?: { maxTokens?: number; signal?: AbortSignal }): Promise<CompletionResult>;
}

export interface SessionNamingOptions {
  models: () => Promise<CompletionRuntime>;
  /**
   * The profile session naming runs on. `null` means naming is off: no
   * profile is assigned to it, so there is nothing to walk and nothing to run.
   */
  profile: ModelProfile | null;
  timeoutMs?: number;
}

// ---------------------------------------------------------------- pure parts

/** Quotes, trailing punctuation and doubled whitespace gone; cut at a word boundary to `max`. */
export function cleanSessionName(raw: string, max = SESSION_NAME_MAX): string {
  let text = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "") ?? "";
  text = text.replace(/^(?:title|name)\s*:\s*/i, "");
  text = text.replace(/^["'“”‘’`*_\s]+|["'“”‘’`*_\s]+$/g, "");
  text = text.replace(/\s+/g, " ").replace(/[.!?,;:…\s]+$/g, "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const boundary = cut.lastIndexOf(" ");
  const short = (boundary > Math.floor(max / 2) ? cut.slice(0, boundary) : text.slice(0, max)).trim();
  return short.replace(/[.!?,;:…\-–—]+$/g, "").trim();
}

export function sessionNamePrompt(text: string): CompletionContext {
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 1500);
  return {
    systemPrompt:
      `Reply with only a session title of ${SESSION_NAME_MIN} to ${SESSION_NAME_MAX} characters that says what the person wants done. ` +
      `No quotes, no trailing period, no explanation.`,
    messages: [{ role: "user", content: `First message of the session:\n\n${excerpt}\n\nTitle:`, timestamp: Date.now() }],
  };
}

/** True for a title this will use. */
export function validSessionName(name: string): boolean {
  return name.length > 0 && name.length <= SESSION_NAME_MAX;
}

interface NormalizedName {
  value: string;
  /** 3 = contract-perfect, 2 = harmless wrapper removed, 1 = safely shortened. */
  fidelity: number;
}

function namedValue(raw: string, keys: readonly string[]): { text: string; wrapped: boolean } {
  let text = raw.trim();
  let wrapped = false;
  const fenced = text.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    text = fenced[1] ?? "";
    wrapped = true;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string") return { text: parsed, wrapped: true };
    if (parsed && typeof parsed === "object") {
      for (const key of keys) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string") return { text: value, wrapped: true };
      }
    }
  } catch {
    // Normal prose is the expected response.
  }
  if (/^(?:title|name|label)\s*:/i.test(text) || /^['"“”‘’`*_]/.test(text)) wrapped = true;
  return { text, wrapped };
}

export function normalizeSessionName(raw: string): NormalizedName {
  const extracted = namedValue(raw, ["title", "name", "sessionTitle"]);
  const uncut = cleanSessionName(extracted.text, Number.POSITIVE_INFINITY);
  const value = cleanSessionName(extracted.text);
  return { value, fidelity: uncut.length > SESSION_NAME_MAX ? 1 : extracted.wrapped || /\r?\n/.test(extracted.text.trim()) ? 2 : 3 };
}

function textOf(completion: CompletionResult): string {
  return completion.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim();
}

// ----------------------------------------------------------------- the request

/** Whether naming can happen at all: a profile with at least one model in it. */
export function canNameSessions(profile: ModelProfile | null): boolean {
  return (profile?.models.length ?? 0) > 0;
}

/**
 * A title for a conversation from its first prompt, or null when none arrives.
 *
 * One request per model of the naming profile, in the profile's order, until
 * one answers with a usable title. A model that is missing, slow or failing is
 * passed over exactly as it would be inside a conversation; when the profile is
 * spent the conversation keeps the name it already has. Never throws.
 */
export async function nameSession(text: string, options: SessionNamingOptions): Promise<string | null> {
  const profile = options.profile;
  if (!profile || text.trim() === "") return null;
  const timeoutMs = options.timeoutMs ?? NAMING_TIMEOUT_MS;
  for (const entry of profile.models) {
    const choice: ModelIdentity = { provider: entry.provider, id: entry.id };
    const raw = await complete(options.models, choice, sessionNamePrompt(text), 48, timeoutMs);
    if (raw === null) continue;
    const name = normalizeSessionName(raw).value;
    if (validSessionName(name)) return name;
  }
  return null;
}

/** One bounded completion; null when the model is missing, times out or fails. */
async function complete(
  models: () => Promise<CompletionRuntime>,
  choice: ModelIdentity,
  context: CompletionContext,
  maxTokens: number,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const runtime = await models();
    const model = runtime.getModel(choice.provider, choice.id);
    if (!model) return null;
    const completion = await runtime.completeSimple(model, context, { maxTokens, signal: AbortSignal.timeout(timeoutMs) });
    const answer = textOf(completion);
    return answer === "" ? null : answer;
  } catch {
    return null;
  }
}
