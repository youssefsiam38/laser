/**
 * The pending tray for one session (`@lasercode/protocol` `pending.ts`).
 *
 * A message written while the agent is working waits here, in order, with an
 * id — not in the engine's queue, which has no verb for one item. The tray
 * delivers its head when the run settles, and hands a message to the engine
 * only when the person explicitly steers it. A steered message leaves the tray
 * in the same call, so a message is never in both places.
 *
 * Nothing here aborts a run. Steering is the engine's own queued steer, which
 * lands at the next turn boundary: the person redirected the agent, so the
 * transcript records their message and the reply, and no stop notice.
 */
import { randomBytes } from "node:crypto";
import { ErrorCodes, PENDING_MAX, PENDING_TEXT_MAX, ProtocolError, type ContentBlock, type PendingMessage } from "@lasercode/protocol";

export interface PendingTrayDeps {
  /** Hand one message to the engine's steering queue. */
  steer(content: ContentBlock[]): Promise<void>;
  /** Start a turn with one message; mirrors `session/prompt`'s answer. */
  prompt(content: ContentBlock[]): Promise<{ accepted: boolean }>;
  /** Whether the agent is working right now. */
  streaming(): boolean;
  /** The tray changed. Called with the list as clients should see it. */
  publish(messages: PendingMessage[]): void;
  /** Test seams. */
  now?: () => string;
  newId?: () => string;
}

export class PendingTray {
  private messages: PendingMessage[] = [];
  private draining = false;

  constructor(private readonly deps: PendingTrayDeps) {}

  list(): PendingMessage[] {
    return this.messages.map(clone);
  }

  add(content: ContentBlock[]): PendingMessage {
    if (content.length === 0) throw new ProtocolError(ErrorCodes.InvalidParams, "There is nothing in that message to queue.");
    if (this.messages.length >= PENDING_MAX) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `${PENDING_MAX} messages are already waiting for this agent. Send or drop some before adding more.`,
      );
    }
    const message: PendingMessage = {
      id: this.deps.newId?.() ?? `p-${randomBytes(4).toString("hex")}`,
      content,
      text: textOf(content),
      images: content.filter((block) => block.type === "image").length,
      createdAt: this.deps.now?.() ?? new Date().toISOString(),
      state: "waiting",
    };
    this.messages = [...this.messages, message];
    this.publish();
    return clone(message);
  }

  edit(id: string, content: ContentBlock[]): PendingMessage {
    const current = this.require(id);
    // Rewriting a message the engine is already reading would change what was
    // sent after it was sent. The row stops offering Edit at the same moment.
    if (current.state === "delivering") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That message is already on its way to the agent.");
    }
    const next: PendingMessage = {
      ...current,
      content,
      text: textOf(content),
      images: content.filter((block) => block.type === "image").length,
      state: "waiting",
    };
    delete next.error;
    this.messages = this.messages.map((message) => (message.id === id ? next : message));
    this.publish();
    return clone(next);
  }

  /** Drop one message; answers with what was dropped so its text is not lost. */
  remove(id: string): PendingMessage | null {
    const found = this.messages.find((message) => message.id === id);
    if (!found) return null;
    if (found.state === "delivering") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That message is already on its way to the agent.");
    }
    this.messages = this.messages.filter((message) => message.id !== id);
    this.publish();
    return clone(found);
  }

  /** Drop everything still waiting; answers with the messages, in order. */
  clear(): PendingMessage[] {
    const dropped = this.messages.filter((message) => message.state !== "delivering");
    if (dropped.length === 0) return [];
    this.messages = this.messages.filter((message) => message.state === "delivering");
    this.publish();
    return dropped.map(clone);
  }

  /**
   * Steer with one message. It leaves the tray and goes to the engine, which
   * delivers it at the next turn boundary; the engine's own queue then owns it
   * and reports it through `queue_update`.
   *
   * With nothing running there is nothing to interrupt, and the person still
   * meant "send this now": the message moves to the head and is delivered as an
   * ordinary prompt rather than parked in a queue no turn will ever read.
   */
  async steer(id: string): Promise<boolean> {
    const found = this.messages.find((message) => message.id === id);
    if (!found || found.state === "delivering") return false;
    if (!this.deps.streaming()) {
      this.messages = [found, ...this.messages.filter((message) => message.id !== id)];
      this.publish();
      await this.drain();
      return true;
    }
    // Out of the tray first: a steer that succeeded while the row was still
    // drawn would show the same message in both lanes for a frame.
    this.messages = this.messages.filter((message) => message.id !== id);
    this.publish();
    try {
      await this.deps.steer(found.content);
      return true;
    } catch (error) {
      this.messages = [{ ...found, state: "failed", error: reasonOf(error) }, ...this.messages];
      this.publish();
      throw error;
    }
  }

  /**
   * Deliver the head, if the agent is idle and something is waiting. Each
   * message is its own turn, in the order it was written, so the next settle
   * takes the next one. A delivery that fails keeps its message and its reason
   * and stops the pass; the next settle tries again.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.messages.length > 0 && !this.deps.streaming()) {
        const head = this.messages[0]!;
        this.patch(head.id, "delivering");
        let delivered = false;
        try {
          const { accepted } = await this.deps.prompt(head.content);
          // An extension is holding the prompt (a blocking dialog, a command).
          // Steering it in is what `sendToSession` does for the same refusal.
          if (!accepted) await this.deps.steer(head.content);
          delivered = true;
        } catch (error) {
          this.patch(head.id, "failed", reasonOf(error));
          return;
        }
        if (delivered) {
          this.messages = this.messages.filter((message) => message.id !== head.id);
          this.publish();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private require(id: string): PendingMessage {
    const found = this.messages.find((message) => message.id === id);
    if (!found) throw new ProtocolError(ErrorCodes.InvalidParams, "That message is no longer waiting; it has already gone to the agent.");
    return found;
  }

  /** Set one message's state, clearing any stale reason unless a new one is given. */
  private patch(id: string, state: PendingMessage["state"], error?: string): void {
    this.messages = this.messages.map((message) => {
      if (message.id !== id) return message;
      const next: PendingMessage = { ...message, state };
      if (error === undefined) delete next.error;
      else next.error = error;
      return next;
    });
    this.publish();
  }

  private publish(): void {
    this.deps.publish(this.list());
  }
}

function clone(message: PendingMessage): PendingMessage {
  return { ...message, content: message.content.map((block) => ({ ...block })) };
}

/** The text of a message, joined and bounded; images contribute no words. */
function textOf(content: ContentBlock[]): string {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  return text.length > PENDING_TEXT_MAX ? text.slice(0, PENDING_TEXT_MAX) : text;
}

/** Never a stack trace: the row shows this to a person. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "The agent did not take this message." : message;
}
