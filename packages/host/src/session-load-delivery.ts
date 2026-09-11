import type { JsonRpcNotification } from "@lasercode/protocol";

/**
 * One bounded delivery fence for one session/load on one connection.
 *
 * Numbered transcript replay and every non-question notification keep their
 * existing delivery path. Only questions that a fresh view cannot consume
 * before its load response are held. Closes are never held: they invalidate
 * every matching fence immediately and continue to retained views.
 */
export class SessionLoadDelivery {
  private readonly questions = new Map<string, JsonRpcNotification>();
  private readonly closed = new Set<string>();
  private disposed = false;

  constructor(readonly path: string) {}

  /** Return true only when this fence consumed (and therefore held) a question. */
  offer(notification: JsonRpcNotification): boolean {
    if (this.disposed) return false;
    const event = dialogEvent(notification);
    if (!event || event.path !== this.path) return false;
    if (event.kind === "close") {
      this.closed.add(event.id);
      this.questions.delete(event.id);
      return false;
    }
    if (!this.closed.has(event.id) && !this.questions.has(event.id)) {
      this.questions.set(event.id, notification);
    }
    return true;
  }

  /**
   * Deliver still-authoritative questions in their original order. `send`
   * confirms each message reached this fence's live connection generation.
   */
  async flush(send: (notification: JsonRpcNotification) => Promise<boolean>): Promise<boolean> {
    if (this.disposed) return false;
    while (this.questions.size > 0) {
      const next = this.questions.entries().next().value as [string, JsonRpcNotification] | undefined;
      if (!next) break;
      const [id, notification] = next;
      this.questions.delete(id);
      if (this.closed.has(id)) continue;
      if (!(await send(notification))) {
        this.dispose();
        return false;
      }
    }
    this.dispose();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.questions.clear();
    this.closed.clear();
  }
}

function dialogEvent(notification: JsonRpcNotification): { kind: "question" | "close"; path: string; id: string } | undefined {
  if (notification.method === "pi/ui/request") {
    const params = notification.params as { path?: unknown; id?: unknown };
    if (typeof params?.path === "string" && typeof params.id === "string") {
      return { kind: "question", path: params.path, id: params.id };
    }
    return undefined;
  }
  if (notification.method === "pi/ui/event") {
    const params = notification.params as { path?: unknown; method?: unknown; id?: unknown };
    if (params?.method === "dialogResolved" && typeof params.path === "string" && typeof params.id === "string") {
      return { kind: "close", path: params.path, id: params.id };
    }
  }
  return undefined;
}
