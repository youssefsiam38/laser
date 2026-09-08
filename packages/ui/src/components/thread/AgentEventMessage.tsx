"use client";
/**
 * The parent's side of an agent event (docs/agents.md "Events at a safe
 * boundary"): a `lasercode/agent-event` custom message, projected as
 * {@link AGENT_EVENT_DATA_PART}, drawn by the Handoff element's event card.
 * The child's chat is one press away — the message is stored once, in the
 * child, and this card is the parent's view of it.
 */
import { useAuiState } from "@assistant-ui/react";
import { useCallback } from "react";

import { AgentEventCard } from "@/components/assistant-ui/elements/agent-handoff";
import { messageTimeDescription, messageTimeLabel } from "@/components/assistant-ui/elements/message-timestamp";
import { MarkdownPreview } from "@/components/preview/MarkdownPreview";
import { useLaserStable, useLaserState, type AgentEventData } from "@/runtime";

const isEventData = (value: unknown): value is AgentEventData =>
  typeof value === "object" && value !== null && typeof (value as AgentEventData).subagentName === "string" && typeof (value as AgentEventData).type === "string";

/** The child's session path: from the event's run, else from the registry, else from the catalog. */
function useChildPath(data: AgentEventData | undefined): string | undefined {
  return useLaserState((s) => {
    if (!data) return undefined;
    if (data.run?.sessionPath) return data.run.sessionPath;
    const run = s.agents.runs[data.runId];
    if (run) return run.sessionPath;
    return s.sessions.find((session) => session.agent?.runId === data.runId || (session.id === data.sessionId && session.agent?.kind === "child"))?.path;
  });
}

export function AgentEventMessage({ data }: { data: unknown }) {
  const { actions } = useLaserStable();
  const event = isEventData(data) ? data : undefined;
  const childPath = useChildPath(event);
  const createdAt = useAuiState((s) => s.message.createdAt);
  const open = useCallback(() => {
    if (childPath) void actions.openSession(childPath);
  }, [actions, childPath]);
  if (!event) return null;
  return (
    <AgentEventCard
      subagentName={event.subagentName}
      agentName={event.agentName}
      kind={event.type}
      initiator={event.endedBy?.initiator}
      reason={event.endedBy?.reason}
      when={createdAt ? messageTimeLabel(createdAt) : undefined}
      whenTitle={createdAt ? messageTimeDescription(createdAt) : undefined}
      onOpen={childPath ? open : undefined}
      className="my-1"
    >
      {event.message.trim() ? <MarkdownPreview text={event.message} prose className="p-0" /> : null}
    </AgentEventCard>
  );
}
