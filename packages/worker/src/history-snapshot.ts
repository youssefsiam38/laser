import { randomUUID } from "node:crypto";
import type { HistoryLiveSnapshot, SessionUpdate } from "@lasercode/protocol";

const wireCopy = <T>(value: T): T => {
  const json = JSON.stringify(value);
  return json === undefined ? value : JSON.parse(json) as T;
};

/** Fold the accepted event stream, not the engine's mutable future message.
 * A provider may fill the same message object before its queued deltas are
 * delivered. Reading that object with the current seq would replay them twice. */
export class HistorySnapshotAccumulator {
  private running = false;
  private message: { id: string; text: string; thinking: string; speaker?: NonNullable<HistoryLiveSnapshot["message"]>["speaker"] } | undefined;
  private tools = new Map<string, HistoryLiveSnapshot["tools"][number]>();

  note(update: SessionUpdate): void {
    switch (update.kind) {
      case "agent_start": this.running = true; return;
      case "state": this.running = update.state.isStreaming; return;
      case "message_start":
        if (update.role === "assistant" || update.speaker) this.message = { id: randomUUID(), text: "", thinking: "", ...(update.speaker ? { speaker: update.speaker } : {}) };
        return;
      case "text_delta":
        this.message ??= { id: randomUUID(), text: "", thinking: "" };
        this.message.text += update.delta;
        return;
      case "thinking_delta":
        this.message ??= { id: randomUUID(), text: "", thinking: "" };
        this.message.thinking += update.delta;
        return;
      case "message_end":
        if (update.role === "assistant" || (update.message as { role?: string } | null)?.role === "assistant" || update.speaker) this.message = undefined;
        return;
      case "tool_execution_start":
        this.tools.set(update.toolCallId, wireCopy({ toolCallId: update.toolCallId, toolName: update.toolName, args: update.args }));
        return;
      case "tool_execution_update": {
        const tool = this.tools.get(update.toolCallId);
        if (tool) this.tools.set(update.toolCallId, { ...tool, partial: wireCopy(update.partial) });
        return;
      }
      case "tool_execution_end": this.tools.delete(update.toolCallId); return;
      case "auto_retry_start": this.running = true; return;
      case "agent_end":
      case "agent_settled":
        this.running = update.kind === "agent_end" && update.willRetry === true;
        this.message = undefined;
        this.tools.clear();
        return;
    }
  }

  reset(): void {
    this.running = false;
    this.message = undefined;
    this.tools.clear();
  }

  snapshot(): HistoryLiveSnapshot {
    const message = this.message;
    return {
      running: this.running,
      ...(message ? { message: { id: message.id, ...(message.speaker ? { speaker: message.speaker } : {}), value: { role: "assistant", content: [
        ...(message.text ? [{ type: "text", text: message.text }] : []),
        ...(message.thinking ? [{ type: "thinking", thinking: message.thinking }] : []),
      ] } } } : {}),
      tools: wireCopy([...this.tools.values()]),
    };
  }
}
