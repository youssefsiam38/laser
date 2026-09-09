/**
 * The pending tray — messages a person wrote while the agent was still working.
 *
 * The engine has two queues of its own (steering and follow-up) and no verb for
 * one item in either: `clearQueue()` empties both, there is no remove, no edit,
 * no reorder. That is why the composer used to offer exactly one action for the
 * whole queue, and why forcing a message through meant pressing Stop — which
 * left "You stopped it" in a transcript where nobody had stopped anything.
 *
 * So the waiting lane is Laser's own. A message written mid-run goes into the
 * worker's ordered list with an id, never into the engine's queue, and the
 * worker delivers it when the run settles. Only an explicit steer hands a
 * message to the engine, and that message leaves this list in the same breath:
 * nothing is ever in both, so the two can never disagree about what is waiting.
 *
 * Living in the worker rather than the browser is what makes the tray survive a
 * reload and show the same rows to a second client, and what lets the delivery
 * happen even when nobody is watching.
 */
import type { ContentBlock } from "./messages.js";

/**
 * `waiting` is the default and the whole point: it goes in when the turn ends.
 * `delivering` is the moment the worker is handing it to the engine.
 * `failed` is a delivery that did not land; the message stays in the tray with
 * the reason, and the next settle tries again.
 */
export type PendingMessageState = "waiting" | "delivering" | "failed";

export interface PendingMessage {
  /** Unique inside its session; stable for the life of the message. */
  id: string;
  /** What was written, whole — text and images, exactly as it would be sent. */
  content: ContentBlock[];
  /** The text of `content`, bounded, so a row can name itself without parsing. */
  text: string;
  /** How many images ride along; a row says so rather than drawing them. */
  images: number;
  createdAt: string;
  state: PendingMessageState;
  /** Why the last delivery failed, in the words a person reads. */
  error?: string;
}

/** Bytes of `text` kept on the wire. The whole `content` is still delivered. */
export const PENDING_TEXT_MAX = 4 * 1024;
/** How many messages one session's tray holds before it refuses more. */
export const PENDING_MAX = 50;

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * The whole tray, for a client that has just opened the session. Every
     * later change arrives as a numbered `pending_update` on the session's own
     * stream; this is the one snapshot that starts it, because a reload has no
     * watermark to replay from and the run it belongs to is still going.
     */
    "session/pending/list": { params: { path: string }; result: { messages: PendingMessage[] } };
    /**
     * Put a message in the tray. Answers with the row that appeared, so the
     * composer can clear itself without waiting for the notification.
     */
    "session/pending/add": { params: { path: string; content: ContentBlock[] }; result: { message: PendingMessage } };
    /** Rewrite one waiting message. Refused once it is on its way. */
    "session/pending/edit": { params: { path: string; id: string; content: ContentBlock[] }; result: { message: PendingMessage } };
    /**
     * Drop one message. `message` is what was dropped, so "Edit" can put the
     * text back in the composer; `null` when it had already gone.
     */
    "session/pending/remove": { params: { path: string; id: string }; result: { message: PendingMessage | null } };
    /**
     * Steer with this one message: it leaves the tray and goes to the engine's
     * steering queue, which delivers it at the next turn boundary. `steered` is
     * false when the id was already gone. Nothing is aborted and nothing is
     * stopped, so the transcript records only the message and the reply.
     */
    "session/pending/steer": { params: { path: string; id: string }; result: { steered: boolean } };
    /** Drop every waiting message and hand the text back. Never touches a run. */
    "session/pending/clear": { params: { path: string }; result: { messages: PendingMessage[] } };
  }
}
