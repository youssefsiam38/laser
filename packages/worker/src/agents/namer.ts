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
 * it against a configured provider: rank connected candidates, test both
 * naming jobs, and keep the best quality/latency/price result. It is not waited
 * on by anything a person is looking at.
 */
import {
  PRODUCT_DISPLAY_NAME,
  SESSION_NAME_MAX,
  SESSION_NAME_MIN,
  renderInstructionTemplate,
  type AgentModelChoice,
  type ModelCatalogEntry,
  type NamerCandidate,
  type NamerState,
} from "@lasercode/protocol";

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
/** Above this price a model is a fallback, not excluded when it is the only usable choice. */
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
  /** The effective prompt from the editable built-in definition. */
  instructions?: () => string;
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

export function toolLabelPrompt(toolName: string, args: unknown, instructions?: string): NamerContext {
  const serialized = serializedArgs(args);
  return {
    systemPrompt: systemPrompt(
      instructions,
      `Reply with only a present-progressive label of at most ${TOOL_LABEL_MAX} characters for this running action, like "Searching auth handlers" or "Reading the build config". No quotes, no trailing period.`,
    ),
    messages: [{ role: "user", content: `Tool: ${toolName}\nArguments: ${serialized}\n\nLabel:`, timestamp: Date.now() }],
  };
}

export function listCost(model: Pick<ModelCatalogEntry, "cost">): number | undefined {
  const input = model.cost?.input;
  const output = model.cost?.output;
  if (typeof input !== "number" && typeof output !== "number") return undefined;
  return (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
}

/**
 * Connected, enabled candidates for Namer: recognisably small and affordable
 * models first, then increasingly expensive fallbacks, at most `limit`. Pure,
 * so candidate selection is testable without a provider.
 */
export function selectNamerCandidates(
  models: readonly ModelCatalogEntry[],
  configuredProviders: ReadonlySet<string>,
  limit = NAMER_MAX_CANDIDATES,
  preferred?: AgentModelChoice | null,
): ModelCatalogEntry[] {
  const eligible = models.filter((model) => {
    if (!configuredProviders.has(model.provider)) return false;
    // A model the person switched off is off everywhere, naming included.
    if (model.enabled === false) return false;
    return true;
  });
  const rank = (model: ModelCatalogEntry) => {
    if (preferred?.provider === model.provider && preferred.id === model.id) return -1;
    const affordable = (listCost(model) ?? Number.POSITIVE_INFINITY) <= NAMER_COST_CEILING;
    if (CHEAP.test(model.id) && affordable && !EXPENSIVE.test(model.id)) return 0;
    if (affordable && !EXPENSIVE.test(model.id)) return 1;
    if (CHEAP.test(model.id)) return 2;
    return 3;
  };
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
export const QUALIFY_TOOL = { name: "grep", args: { pattern: "auth", path: "src" } } as const;

/** True for a title the benchmark accepts. */
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

export function normalizeToolLabel(raw: string): NormalizedName {
  const extracted = namedValue(raw, ["label", "name", "activity"]);
  const uncut = cleanToolLabel(extracted.text, Number.POSITIVE_INFINITY);
  const value = cleanToolLabel(extracted.text);
  return { value, fidelity: uncut.length > TOOL_LABEL_MAX ? 1 : extracted.wrapped || /\r?\n/.test(extracted.text.trim()) ? 2 : 3 };
}

function validToolLabel(label: string): boolean {
  const first = label.split(/\s+/, 1)[0] ?? "";
  return label.length > 0 && label.length <= TOOL_LABEL_MAX && /ing$/i.test(first);
}

function serializedArgs(args: unknown): string {
  try {
    return (JSON.stringify(args ?? {}) ?? "{}").slice(0, 1200);
  } catch {
    return "{}";
  }
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
    const raw = await this.complete(choice, sessionNamePrompt(text, this.renderInstructions(choice, { namingTask: "session title", sourceText: text })), 48);
    if (raw === null) return null;
    const name = normalizeSessionName(raw).value;
    return validSessionName(name) ? name : null;
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
    const raw = await this.complete(
      choice,
      toolLabelPrompt(
        toolName,
        args,
        this.renderInstructions(choice, {
          namingTask: "activity label",
          sourceText: `Tool: ${toolName}\nArguments: ${serializedArgs(args)}`,
          toolName,
          toolArguments: serializedArgs(args),
        }),
      ),
      48,
    );
    if (raw === null) return null;
    if (options.stillRunning?.() === false) return null;
    const label = normalizeToolLabel(raw).value;
    return validToolLabel(label) ? label : null;
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

  /** Benchmark connected candidates on both naming jobs, concurrently. */
  async qualify(): Promise<NamerState> {
    const qualifiedAt = new Date(this.now()).toISOString();
    if (!this.options.catalog) return { status: "unavailable", model: null, candidates: [], qualifiedAt, reason: "No model catalogue is available in this worker." };
    let selected: ModelCatalogEntry[];
    try {
      const { models, configuredProviders } = await this.options.catalog();
      selected = selectNamerCandidates(models, configuredProviders, NAMER_MAX_CANDIDATES, this.options.model());
    } catch (error) {
      return { status: "unavailable", model: null, candidates: [], qualifiedAt, reason: error instanceof Error ? error.message : String(error) };
    }
    if (selected.length === 0) {
      return { status: "unavailable", model: null, candidates: [], qualifiedAt, reason: "No connected provider offers a model Namer can try. Connect a provider in Settings → Providers and models." };
    }
    let runtime: NamerModelRuntime;
    try {
      runtime = await this.options.models();
    } catch (error) {
      const current = this.options.model();
      const detail = error instanceof Error ? error.message : String(error);
      return current
        ? { status: "ready", model: current, candidates: [], qualifiedAt, reason: `The new check could not run, so Namer kept its current model. ${detail}` }
        : { status: "unqualified", model: null, candidates: [], qualifiedAt, reason: `The model check could not run and will remain retryable. ${detail}` };
    }
    const trials = await Promise.all(selected.map(async (entry) => {
      const choice = { provider: entry.provider, id: entry.id };
      const cost = listCost(entry);
      const started = this.now();
      let candidate: NamerCandidate;
      let quality = 0;
      try {
        const sessionInstructions = this.renderInstructions(choice, { namingTask: "session title", sourceText: QUALIFY_SAMPLE });
        const raw = await this.completeWithRuntime(runtime, choice, sessionNamePrompt(QUALIFY_SAMPLE, sessionInstructions), 48, true);
        const title = raw === null ? { value: "", fidelity: 0 } : normalizeSessionName(raw);
        const toolSource = `Tool: ${QUALIFY_TOOL.name}\nArguments: ${serializedArgs(QUALIFY_TOOL.args)}`;
        const toolInstructions = this.renderInstructions(choice, {
          namingTask: "activity label",
          sourceText: toolSource,
          toolName: QUALIFY_TOOL.name,
          toolArguments: serializedArgs(QUALIFY_TOOL.args),
        });
        const toolRaw = await this.completeWithRuntime(runtime, choice, toolLabelPrompt(QUALIFY_TOOL.name, QUALIFY_TOOL.args, toolInstructions), 48, true);
        const latencyMs = this.now() - started;
        const label = toolRaw === null ? { value: "", fidelity: 0 } : normalizeToolLabel(toolRaw);
        const titleValid = validSessionName(title.value);
        const labelValid = validToolLabel(label.value);
        quality = title.fidelity + label.fidelity;
        candidate = {
          model: choice,
          latencyMs,
          valid: titleValid && labelValid,
          ...(title.value ? { sample: title.value } : {}),
          ...(!titleValid ? { error: "Its session title could not be made usable." } : !labelValid ? { error: "Its activity label did not describe an action in progress." } : {}),
        };
      } catch (error) {
        candidate = { model: choice, latencyMs: null, valid: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (cost !== undefined) candidate.costPerMillion = cost;
      return { candidate, quality };
    }));
    const candidates = trials.map(({ candidate }) => candidate);
    const winner = trials
      .filter(({ candidate }) => candidate.valid && candidate.latencyMs !== null)
      .sort((a, b) => {
        if (a.quality !== b.quality) return b.quality - a.quality;
        const burden = ({ candidate }: (typeof trials)[number]) =>
          (candidate.latencyMs ?? Number.POSITIVE_INFINITY) + (candidate.costPerMillion ?? NAMER_COST_CEILING * 2) * 200;
        return burden(a) - burden(b);
      })[0]?.candidate;
    if (!winner) {
      const current = this.options.model();
      if (current) {
        return {
          status: "ready",
          model: current,
          candidates,
          qualifiedAt,
          reason: "The new check did not find a better usable model, so Namer kept the model that was already working.",
        };
      }
      return {
        status: "unqualified",
        model: null,
        candidates,
        qualifiedAt,
        reason: "No candidate completed both naming checks. Namer will try again automatically; you can also run the check again now.",
      };
    }
    return { status: "ready", model: winner.model, candidates, qualifiedAt };
  }

  private renderInstructions(
    choice: AgentModelChoice,
    request: { namingTask: string; sourceText: string; toolName?: string; toolArguments?: string },
  ): string | undefined {
    const template = this.options.instructions?.()?.trim();
    if (!template) return undefined;
    return renderInstructionTemplate(template, "namer", {
      productName: PRODUCT_DISPLAY_NAME,
      agentName: "Namer",
      agentDescription: "Names sessions and running actions with a fast, inexpensive model.",
      model: `${choice.provider}/${choice.id}`,
      namingTask: request.namingTask,
      sourceText: request.sourceText,
      toolName: request.toolName ?? "",
      toolArguments: request.toolArguments ?? "",
    });
  }

  /** One bounded completion; null when the model is missing, times out or fails (unless `rethrow`). */
  private async complete(choice: AgentModelChoice, context: NamerContext, maxTokens: number, rethrow = false): Promise<string | null> {
    try {
      const runtime = await this.options.models();
      return await this.completeWithRuntime(runtime, choice, context, maxTokens, rethrow);
    } catch (error) {
      if (rethrow) throw error;
      return null;
    }
  }

  private async completeWithRuntime(runtime: NamerModelRuntime, choice: AgentModelChoice, context: NamerContext, maxTokens: number, rethrow = false): Promise<string | null> {
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
