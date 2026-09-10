import type { AppendMessage } from "@assistant-ui/react";
import type { ClientRequests, ThinkingLevel } from "@lasercode/protocol";

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
  if (thinkingLevel === undefined) return { agentName };
  if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)) return undefined;
  return { agentName, thinkingLevel: thinkingLevel as ThinkingLevel };
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
