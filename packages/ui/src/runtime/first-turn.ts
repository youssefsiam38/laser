import type { AppendMessage, ThreadComposerRuntime } from "@assistant-ui/react";
import type { ClientRequests, ModelRef, ThinkingLevel } from "@lasercode/protocol";
import { useEffect } from "react";

/** Configuration one composer attaches to its own pristine session's first prompt. */
export type TentativeFirstTurn = NonNullable<ClientRequests["session/prompt"]["params"]["firstTurn"]>;

const FIRST_TURN_KEY = "firstTurn";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type RunConfig = AppendMessage["runConfig"];

/** Read the first-turn choice captured on the message by the sending composer. */
export function firstTurnFromRunConfig(runConfig: RunConfig): TentativeFirstTurn | undefined {
  const candidate = runConfig?.custom?.[FIRST_TURN_KEY];
  if (!candidate || typeof candidate !== "object") return undefined;
  const { agentName, thinkingLevel } = candidate as { agentName?: unknown; thinkingLevel?: unknown };
  if (typeof agentName !== "string" || agentName === "") return undefined;
  if (thinkingLevel !== undefined && (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel))) return undefined;

  let modelIntent: Pick<TentativeFirstTurn, "model"> | undefined;
  if (Object.hasOwn(candidate, "model")) {
    const value = (candidate as { model?: unknown }).model;
    if (value === null) {
      modelIntent = { model: null };
    } else {
      if (!value || typeof value !== "object") return undefined;
      const raw = value as Record<string, unknown>;
      if (typeof raw["provider"] !== "string" || raw["provider"] === "" || typeof raw["id"] !== "string" || raw["id"] === "") return undefined;
      const model: ModelRef = { provider: raw["provider"], id: raw["id"] };
      if (typeof raw["name"] === "string") model.name = raw["name"];
      if (typeof raw["contextWindow"] === "number") model.contextWindow = raw["contextWindow"];
      if (typeof raw["reasoning"] === "boolean") model.reasoning = raw["reasoning"];
      if (typeof raw["vision"] === "boolean") model.vision = raw["vision"];
      modelIntent = { model };
    }
  }

  return {
    agentName,
    ...modelIntent,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as ThinkingLevel }),
  };
}

/**
 * The model the picker and thinking control must show for this composer.
 * An absent intent deliberately keeps the existing session/landing value;
 * only null follows the selected agent and then the project default.
 */
export function effectiveFirstTurnModel(
  firstTurn: TentativeFirstTurn | undefined,
  current: ModelRef | null | undefined,
  selectedAgent: ModelRef | null | undefined,
  projectDefault: ModelRef | null | undefined,
): ModelRef | null {
  if (firstTurn && Object.hasOwn(firstTurn, "model")) {
    return firstTurn.model ?? selectedAgent ?? projectDefault ?? null;
  }
  return current ?? selectedAgent ?? projectDefault ?? null;
}

/** Merge one custom field without dropping another send-time option. */
export function mergeRunConfigCustom(
  runConfig: RunConfig,
  custom: Record<string, unknown>,
): NonNullable<RunConfig> {
  return {
    ...runConfig,
    custom: {
      ...runConfig?.custom,
      ...custom,
    },
  };
}

export function withFirstTurn(runConfig: RunConfig, firstTurn: TentativeFirstTurn): NonNullable<RunConfig> {
  return mergeRunConfigCustom(runConfig, { [FIRST_TURN_KEY]: firstTurn });
}

/** The run config with the tentative choice gone and every other field as it was. */
export function withoutFirstTurn(runConfig: RunConfig): NonNullable<RunConfig> {
  const { [FIRST_TURN_KEY]: _dropped, ...custom } = runConfig?.custom ?? {};
  return { ...runConfig, custom };
}

/** The slice of a composer runtime the leave boundary touches; keeps tests free of a runtime. */
export type FirstTurnComposer = Pick<ThreadComposerRuntime, "getState" | "setRunConfig">;

/**
 * Drop the composer's tentative choice, if it holds one. Text, attachments and
 * the rest of the run config stay: only the choice was tentative.
 */
export function discardFirstTurn(composer: FirstTurnComposer): boolean {
  const current = composer.getState().runConfig;
  if (current?.custom?.[FIRST_TURN_KEY] === undefined) return false;
  composer.setRunConfig(withoutFirstTurn(current));
  return true;
}

/**
 * The leave boundary (M13-T89 U2). A tentative choice belongs to one composer
 * on one pristine session for as long as that session is the one on screen;
 * moving to another session — or the thread going away — discards it, and
 * nothing else about the draft.
 *
 * `bound` is whether the composer's own session is the one on screen. The
 * effect keys on that composer, so a composer that stays mounted after a
 * switch (assistant-ui keeps every loaded thread's runtime alive) is cleaned
 * up exactly once, and never through the composer that has since taken its
 * place — clearing "the current composer" on a path change would empty the
 * choice of the session the person just arrived at.
 */
export function useDiscardFirstTurnOnLeave(composer: FirstTurnComposer, bound: boolean): void {
  useEffect(() => {
    if (!bound) return;
    return () => {
      // A runtime being torn down can have released its composer already; the
      // draft dies with it, so there is nothing left to discard.
      try {
        discardFirstTurn(composer);
      } catch {
        /* composer no longer available */
      }
    };
  }, [bound, composer]);
}
