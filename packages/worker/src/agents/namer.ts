/**
 * Naming — the service that titles a session from its first prompt.
 *
 * It is a **one-shot walk of the naming profile** (`docs/model-profiles.md`,
 * "Runtime"): one small completion per model, in the profile's own order, with
 * an 8 s ceiling each, stopping at the first usable title. There is no
 * benchmark, no candidate ranking and no qualification step — the person chose
 * an ordered list of models, and that list is the answer.
 *
 * It never throws, creates no session and appears in no fleet row: a name that
 * does not arrive is simply not shown.
 */
import {
  PRODUCT_DISPLAY_NAME,
  PRODUCT_NAME,
  SESSION_NAME_MAX,
  SESSION_NAME_MIN,
  renderInstructionTemplate,
  type ModelIdentity,
  type ModelProfile,
} from "@lasercode/protocol";
import { FALLBACK_NAMER_INSTRUCTIONS } from "./definitions.js";

export const NAMER_TIMEOUT_MS = 8_000;

/** The engine's model runtime, reduced to what naming needs (so tests can fake it). */
export interface NamerModel {
  provider: string;
  id: string;
}

export interface NamerContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string; timestamp: number }>;
}

export interface NamerCompletion {
  content: ReadonlyArray<{ type: string; text?: string }>;
}

export interface NamerModelRuntime {
  getModel(provider: string, id: string): NamerModel | undefined;
  completeSimple(model: NamerModel, context: NamerContext, options?: { maxTokens?: number; signal?: AbortSignal }): Promise<NamerCompletion>;
}

export interface NamerServiceOptions {
  models: () => Promise<NamerModelRuntime>;
  /**
   * The profile session naming runs on. `null` means naming is off: there is
   * no profile assigned to it and nothing to walk.
   */
  profile: () => ModelProfile | null;
  /** The effective prompt from the editable built-in definition. */
  instructions?: () => string;
  timeoutMs?: number;
  now?: () => number;
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

function systemPrompt(instructions: string | undefined, contract: string): string {
  const base = instructions?.trim();
  return base ? `${base}\n\nFor this request: ${contract}` : contract;
}

export function sessionNamePrompt(text: string, instructions?: string): NamerContext {
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 1500);
  return {
    systemPrompt: systemPrompt(
      instructions,
      `Reply with only a session title of ${SESSION_NAME_MIN} to ${SESSION_NAME_MAX} characters that says what the person wants done. No quotes, no trailing period, no explanation.`,
    ),
    messages: [{ role: "user", content: `First message of the session:\n\n${excerpt}\n\nTitle:`, timestamp: Date.now() }],
  };
}

/** True for a title this service will use. */
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

function textOf(completion: NamerCompletion): string {
  return completion.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim();
}

// ------------------------------------------------------------------ service

export class NamerService {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: NamerServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? NAMER_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Whether naming can happen at all right now. */
  enabled(): boolean {
    return (this.options.profile()?.models.length ?? 0) > 0;
  }

  /**
   * A title for a session from its first prompt, or null when none arrives.
   *
   * One request per model of the naming profile, in the profile's order, until
   * one answers with a usable title. A model that is missing, slow or failing
   * is passed over exactly as it would be inside a conversation; when the
   * profile is spent the session keeps the name it already has. Never throws.
   */
  async nameSession(text: string): Promise<string | null> {
    const profile = this.options.profile();
    if (!profile || text.trim() === "" ) return null;
    for (const entry of profile.models) {
      const choice: ModelIdentity = { provider: entry.provider, id: entry.id };
      const raw = await this.complete(choice, sessionNamePrompt(text, this.renderInstructions(choice, text)), 48);
      if (raw === null) continue;
      const name = normalizeSessionName(raw).value;
      if (validSessionName(name)) return name;
    }
    return null;
  }

  private renderInstructions(choice: ModelIdentity, sourceText: string): string | undefined {
    const template = this.options.instructions?.()?.trim();
    if (!template) return undefined;
    const values = {
      productName: PRODUCT_DISPLAY_NAME,
      agentName: "Namer",
      agentDescription: "Names sessions on the profile chosen for session names.",
      model: `${choice.provider}/${choice.id}`,
      sourceText,
    };
    try {
      return renderInstructionTemplate(template, "namer", values);
    } catch (error) {
      console.error(`${PRODUCT_NAME} worker: Namer's saved instructions could not be rendered; using the shipped prompt for this turn:`, error instanceof Error ? error.message : error);
      return renderInstructionTemplate(FALLBACK_NAMER_INSTRUCTIONS, "namer", values);
    }
  }

  /** One bounded completion; null when the model is missing, times out or fails (unless `rethrow`). */
  private async complete(choice: ModelIdentity, context: NamerContext, maxTokens: number, rethrow = false): Promise<string | null> {
    try {
      const runtime = await this.options.models();
      return await this.completeWithRuntime(runtime, choice, context, maxTokens, rethrow);
    } catch (error) {
      if (rethrow) throw error;
      return null;
    }
  }

  private async completeWithRuntime(runtime: NamerModelRuntime, choice: ModelIdentity, context: NamerContext, maxTokens: number, rethrow = false): Promise<string | null> {
    try {
      const model = runtime.getModel(choice.provider, choice.id);
      if (!model) {
        if (rethrow) throw new Error(`${choice.provider}/${choice.id} is not in the model catalogue.`);
        return null;
      }
      const completion = await runtime.completeSimple(model, context, { maxTokens, signal: AbortSignal.timeout(this.timeoutMs) });
      const text = textOf(completion);
      return text === "" ? null : text;
    } catch (error) {
      if (rethrow) throw error;
      return null;
    }
  }
}
