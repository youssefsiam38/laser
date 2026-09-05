import { PRODUCT_DISPLAY_NAME, storageKey } from "@lasercode/protocol";
/**
 * Pure logic behind the first-run flow (M10-T6): the steps, and where to
 * resume from. The host remembers whether setup finished; the facts that
 * decide which step is next (a provider signed in, a default model, a project)
 * are read fresh from the host on every open, so quitting halfway loses
 * nothing and a step that was completed elsewhere is not asked again.
 */
export type SetupStep = "welcome" | "provider" | "model" | "project" | "ready";

export const SETUP_STEPS: readonly SetupStep[] = ["welcome", "provider", "model", "project", "ready"];

export const STEP_TITLES: Record<SetupStep, string> = {
  welcome: `Welcome to ${PRODUCT_DISPLAY_NAME}`,
  provider: "Connect a model provider",
  model: "Choose a default model",
  project: "Open a project",
  ready: "You are set",
};

export interface SetupFacts {
  /** Providers with a credential right now; undefined while unknown. */
  providersConfigured: number | undefined;
  /** A default model is written in settings; undefined while unknown. */
  hasDefaultModel: boolean | undefined;
  /** Projects the host knows. Always known once sessions have loaded. */
  projects: number;
}

export function stepIndex(step: SetupStep): number {
  return SETUP_STEPS.indexOf(step);
}

/** The first step whose fact is missing, after the welcome; `ready` when none is. */
export function firstIncomplete(facts: SetupFacts): SetupStep | undefined {
  if (facts.providersConfigured === undefined || facts.hasDefaultModel === undefined) return undefined;
  if (facts.providersConfigured === 0) return "provider";
  if (!facts.hasDefaultModel) return "model";
  if (facts.projects === 0) return "project";
  return "ready";
}

/**
 * Where to put the person: the step they left, unless a fact says a step
 * before it is no longer done (a credential removed since) or a step they
 * have not reached is already satisfied (a project added from the phone). A
 * remembered step never skips past something missing, and never re-asks for
 * something present.
 */
export function resumeStep(facts: SetupFacts, remembered: SetupStep | undefined): SetupStep {
  // Never seen the flow on this device: start at the beginning, whatever is done.
  if (remembered === undefined) return "welcome";
  const incomplete = firstIncomplete(facts);
  if (incomplete === undefined) return remembered;
  if (remembered === "welcome") return incomplete;
  // A remembered step ahead of the first missing fact is not reachable yet.
  return stepIndex(remembered) > stepIndex(incomplete) ? incomplete : remembered;
}

export function nextStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, stepIndex(step) + 1)] ?? "ready";
}

export function previousStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.max(0, stepIndex(step) - 1)] ?? "welcome";
}

export const SETUP_STEP_KEY = storageKey("setup-step");

export function readRememberedStep(): SetupStep | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(SETUP_STEP_KEY);
    return raw && (SETUP_STEPS as readonly string[]).includes(raw) ? (raw as SetupStep) : undefined;
  } catch {
    return undefined;
  }
}

export function rememberStep(step: SetupStep | undefined): void {
  try {
    if (step === undefined) globalThis.localStorage?.removeItem(SETUP_STEP_KEY);
    else globalThis.localStorage?.setItem(SETUP_STEP_KEY, step);
  } catch {
    /* this tab only */
  }
}

/** Providers first by whether they are signed in, then the ones most people use, then by name. */
const FAMILIAR = ["anthropic", "openai", "openai-codex", "google", "gemini", "github-copilot", "openrouter", "xai", "groq", "mistral", "deepseek", "ollama"];

export function sortProviders<T extends { id: string; name: string; configured: boolean }>(providers: readonly T[]): T[] {
  const rank = (p: T) => {
    const familiar = FAMILIAR.indexOf(p.id.toLowerCase());
    return (p.configured ? 0 : 1000) + (familiar === -1 ? 500 : familiar);
  };
  return [...providers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
