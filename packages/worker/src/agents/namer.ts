/**
 * Namer — the built-in agent that names things (original request): a session
 * from its first prompt (25–30 characters) and a tool call the moment it
 * starts (a present-progressive label, "Searching auth handlers").
 *
 * It is a service, never a session: one small completion per request through
 * the engine's model runtime, with the model the host qualified (or a person
 * chose) and an 8 s ceiling. It never throws — a name that does not arrive is
 * simply not shown — and it never labels one tool call twice.
 *
 * `qualify()` is the benchmark the host asks for as soon as a worker can run
 * it against a configured provider: nominate cheap models, time each on the
 * session-naming prompt, keep the fastest one that answers validly. It is not
 * waited on by anything a person is looking at.
 */
import { SESSION_NAME_MAX, SESSION_NAME_MIN, type AgentModelChoice, type ModelCatalogEntry, type NamerCandidate, type NamerState } from "@lasercode/protocol";

export const TOOL_LABEL_MAX = 40;
export const NAMER_TIMEOUT_MS = 8_000;
/*
 * Tool labels have no in-flight cap. There was one (three per session), and
 * it was the wrong trade: the person is looking at exactly the row that went
 * unlabelled. Every call that starts is asked about, at once; the only things
 * that stop a request are a call already asked about and a call that has
 * already ended — a label for a row that is gone is spend with nothing to show
 * for it. Spend is bounded by the naming model being the cheapest allowed and
 * by the label being labelled once per call id.
 */
/** Call ids one session remembers, so the same call is never labelled twice. */
const LABELLED_MEMORY = 64;
export const NAMER_MAX_CANDIDATES = 6;
/** Models whose input + output list price exceeds this (per million tokens) are never nominated. */
export const NAMER_COST_CEILING = 3;
const EXPENSIVE = /opus|pro|ultra|max/i;
const CHEAP = /mini|nano|flash|haiku|lite|luna|small/i;

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
  /** The model to name with; null means naming is off. */
  model: () => AgentModelChoice | null;
  /** The catalogue and the providers with credentials, for `qualify()`. */
  catalog?: () => Promise<{ models: ModelCatalogEntry[]; configuredProviders: ReadonlySet<string> }>;
  timeoutMs?: number;
  now?: () => number;
}

/** What `labelTool` needs to know about the call it was asked to label. */
export interface LabelToolOptions {
  /**
   * Whether the call is still running. A label for a finished call is never
   * rendered (the aggregate row reads the running member's label only), so it
   * is checked before the completion is paid for and again when it lands.
   */
  stillRunning?: () => boolean;
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

/** One line, no quotes, no trailing period, at most `TOOL_LABEL_MAX` characters. */
export function cleanToolLabel(raw: string, max = TOOL_LABEL_MAX): string {
  const cleaned = cleanSessionName(raw, max);
  return cleaned.length > 0 ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : "";
}

export function sessionNamePrompt(text: string): NamerContext {
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 1500);
  return {
    systemPrompt: `You name chat sessions. Reply with only a title of ${SESSION_NAME_MIN} to ${SESSION_NAME_MAX} characters that says what the person wants done. No quotes, no trailing period, no explanation.`,
    messages: [{ role: "user", content: `First message of the session:\n\n${excerpt}\n\nTitle:`, timestamp: Date.now() }],
  };
}

export function toolLabelPrompt(toolName: string, args: unknown): NamerContext {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? {}) ?? "{}";
  } catch {
    serialized = "{}";
  }
  return {
    systemPrompt: `You label a running tool call for a progress row. Reply with only a present-progressive phrase of at most ${TOOL_LABEL_MAX} characters, like "Searching auth handlers" or "Reading the build config". No quotes, no trailing period.`,
    messages: [{ role: "user", content: `Tool: ${toolName}\nArguments: ${serialized.slice(0, 1200)}\n\nLabel:`, timestamp: Date.now() }],
  };
}

export function listCost(model: Pick<ModelCatalogEntry, "cost">): number | undefined {
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
}

/**
 * Cheap, connected, enabled candidates for Namer: no expensive names, no list
 * price over the ceiling, the recognisably small ones first, then by cost and
 * name, at most `limit`. Pure, so the nomination is testable without a provider.
 */
export function nominateNamerCandidates(
  models: readonly ModelCatalogEntry[],
  configuredProviders: ReadonlySet<string>,
  limit = NAMER_MAX_CANDIDATES,
): ModelCatalogEntry[] {
  const eligible = models.filter((model) => {
    if (!configuredProviders.has(model.provider)) return false;
    // A model the person switched off is off everywhere, naming included.
    if (model.enabled === false) return false;
    if (EXPENSIVE.test(model.id)) return false;
    const cost = listCost(model);
    if (cost !== undefined && cost > NAMER_COST_CEILING) return false;
    return true;
  });
  const rank = (model: ModelCatalogEntry) => (CHEAP.test(model.id) ? 0 : 1);
  eligible.sort((a, b) => {
    const byPreference = rank(a) - rank(b);
    if (byPreference !== 0) return byPreference;
    const byCost = (listCost(a) ?? Number.POSITIVE_INFINITY) - (listCost(b) ?? Number.POSITIVE_INFINITY);
    if (byCost !== 0) return byCost;
    return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
  });
  return eligible.slice(0, limit);
}

/** The fixed prompt every candidate is timed on. */
export const QUALIFY_SAMPLE = "Fix the login form so pressing Enter submits it, and make the error banner disappear after a successful sign-in.";

/** True for a title the benchmark accepts. */
export function validSessionName(name: string): boolean {
  return name.length > 0 && name.length <= SESSION_NAME_MAX;
}

function textOf(completion: NamerCompletion): string {
  return completion.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ")
    .trim();
}

// ------------------------------------------------------------------ service

/** Per-session label bookkeeping: what is in flight, and what has been asked for already. */
interface SessionLabels {
  /** Call ids already asked about, newest last; trimmed to `LABELLED_MEMORY`. */
  order: string[];
  ids: Set<string>;
}

export class NamerService {
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Label bookkeeping per session; dropped by `forget()` when the session closes. */
  private readonly labels = new Map<string, SessionLabels>();

  constructor(private readonly options: NamerServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? NAMER_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Whether naming can happen at all right now. */
  enabled(): boolean {
    return this.options.model() !== null;
  }

  /** A title for a session from its first prompt, or null when none arrives. Never throws. */
  async nameSession(text: string): Promise<string | null> {
    const choice = this.options.model();
    if (!choice || text.trim() === "") return null;
    const raw = await this.complete(choice, sessionNamePrompt(text), 24);
    if (raw === null) return null;
    const name = cleanSessionName(raw);
    return name === "" ? null : name;
  }

  /**
   * A present-progressive label for a tool call that just started.
   *
   * A burst of calls is the normal case and every one of them is asked about
   * at once; for a call already labelled or already finished this returns
   * null immediately rather than doing work whose answer nobody would see.
   * Never throws.
   */
  async labelTool(sessionKey: string, toolCallId: string, toolName: string, args: unknown, options: LabelToolOptions = {}): Promise<string | null> {
    const choice = this.options.model();
    if (!choice) return null;
    const session = this.sessionLabels(sessionKey);
    if (session.ids.has(toolCallId)) return null;
    // Already over by the time the event was handled: a label for it is spend
    // with nothing to show for it.
    if (options.stillRunning?.() === false) return null;
    this.remember(session, toolCallId);
    const raw = await this.complete(choice, toolLabelPrompt(toolName, args), 20);
    if (raw === null) return null;
    if (options.stillRunning?.() === false) return null;
    const label = cleanToolLabel(raw);
    return label === "" ? null : label;
  }

  /** A session closed: its label bookkeeping goes with it. */
  forget(sessionKey: string): void {
    this.labels.delete(sessionKey);
  }

  private sessionLabels(sessionKey: string): SessionLabels {
    let session = this.labels.get(sessionKey);
    if (!session) {
      session = { order: [], ids: new Set() };
      this.labels.set(sessionKey, session);
    }
    return session;
  }

  private remember(session: SessionLabels, toolCallId: string): void {
    session.order.push(toolCallId);
    session.ids.add(toolCallId);
    while (session.order.length > LABELLED_MEMORY) {
      const oldest = session.order.shift();
      if (oldest !== undefined) session.ids.delete(oldest);
    }
  }

  /** Benchmark nominated cheap models on the session-naming prompt and pick the fastest valid one. */
  async qualify(): Promise<NamerState> {
    const qualifiedAt = new Date(this.now()).toISOString();
    if (!this.options.catalog) return { status: "unavailable", model: null, candidates: [], qualifiedAt, reason: "No model catalogue is available in this worker." };
    let nominated: ModelCatalogEntry[];
    try {
      const { models, configuredProviders } = await this.options.catalog();
      nominated = nominateNamerCandidates(models, configuredProviders);
    } catch (error) {
      return { status: "unavailable", model: null, candidates: [], qualifiedAt, reason: error instanceof Error ? error.message : String(error) };
    }
    if (nominated.length === 0) {
      return { status: "unavailable", model: null, candidates: [], qualifiedAt, reason: "No connected provider offers an inexpensive model. Connect a provider with a small model in Settings → Providers and models." };
    }
    const candidates: NamerCandidate[] = [];
    for (const entry of nominated) {
      const choice = { provider: entry.provider, id: entry.id };
      const cost = listCost(entry);
      const started = this.now();
      let candidate: NamerCandidate;
      try {
        const raw = await this.complete(choice, sessionNamePrompt(QUALIFY_SAMPLE), 24, true);
        const latencyMs = this.now() - started;
        // Judge the answer as given (quotes and whitespace aside), not the cut
        // version: a model that rambles past the ceiling is not a valid namer.
        const sample = raw === null ? "" : cleanSessionName(raw, Number.POSITIVE_INFINITY);
        const valid = raw !== null && validSessionName(sample);
        candidate = { model: choice, latencyMs, valid, ...(sample ? { sample } : {}), ...(raw === null ? { error: "No answer within the time limit." } : {}) };
      } catch (error) {
        candidate = { model: choice, latencyMs: null, valid: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (cost !== undefined) candidate.costPerMillion = cost;
      candidates.push(candidate);
    }
    const winner = candidates
      .filter((candidate) => candidate.valid && candidate.latencyMs !== null)
      .sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))[0];
    if (!winner) {
      return { status: "unavailable", model: null, candidates, qualifiedAt, reason: "None of the nominated models answered the naming prompt validly. Choose a model by hand in the Agents page." };
    }
    return { status: "ready", model: winner.model, candidates, qualifiedAt };
  }

  /** One bounded completion; null when the model is missing, times out or fails (unless `rethrow`). */
  private async complete(choice: AgentModelChoice, context: NamerContext, maxTokens: number, rethrow = false): Promise<string | null> {
    try {
      const runtime = await this.options.models();
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
