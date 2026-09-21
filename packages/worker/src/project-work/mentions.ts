/**
 * The mention context of one conversation (M21-T9/T17).
 *
 * The host validates every project-work mention a person's message carries and
 * hands the worker a bounded projection per mention (`session/prompt` and its
 * four siblings, `docs/project-mentions.md` "Send time, and what the worker
 * gets"). This is where that projection becomes **ephemeral model context for
 * the message that carried it** — never a transcript entry, never a second
 * copy of an artifact, never a re-read of the current revision.
 *
 * Three properties matter:
 *
 * - **It is identified, not inferred.** Every admitted message is sent with an
 *   opaque `correlationId` the engine carries on the message it creates (the
 *   pinned patch, `docs/upstream.md`). A block is rendered against the message
 *   that holds its id. No text is compared, no position is guessed, no queue
 *   depth is counted — all three were tried and are wrong for two identical
 *   messages sent as a prompt, a steer and a follow-up.
 * - **It is read-only.** This object formats what the host already read. It
 *   holds no bridge, makes no call, resolves no project and changes no
 *   directory, which is why a projectless Chat and a cross-project mention get
 *   their context without gaining any authority (leap, "Cross-session mentions
 *   and context").
 * - **Nothing accepted is silently forgotten.** A send past the ceiling is
 *   refused before the engine is asked; a message that does not fit one model
 *   call says so in its own words and keeps its projection for the next one.
 */
import { ErrorCodes, ProtocolError, type ProjectWorkMentionProjection } from "@lasercode/protocol";
import { randomBytes } from "node:crypto";

/** How many messages may be waiting with project-work context at once. */
export const MENTION_CONTEXT_MESSAGES_MAX = 16;
/** How much mention context one model call may carry. */
export const MENTION_CONTEXT_RENDER_MAX = 24_000;

/** Which of the engine's three doors a message went through. */
export type MentionSendLane = "direct" | "steer" | "followUp";

/** One message the model is about to read, as the module sees it. */
export interface MentionContextMessage {
  role: string;
  correlationId?: string | undefined;
}

/** One block, and the message it belongs beside. */
export interface MentionContextBlock {
  /** Index of the message this block follows; the block is inserted after it. */
  afterIndex: number;
  text: string;
}

interface Envelope {
  id: string;
  lane: MentionSendLane;
  /**
   * `pending` — accepted by the engine, not yet read by the model (it may be
   * waiting in a queue). `active` — the model is reading it now.
   */
  state: "pending" | "active";
  projections: ProjectWorkMentionProjection[];
}

const KEYS_MAX = 8;

export class SessionMentionContext {
  private readonly envelopes: Envelope[] = [];

  /**
   * Whether one more message carrying mentions can be admitted.
   *
   * Asked **before** the engine is told anything, so a refusal is a refusal to
   * send rather than a promise quietly dropped afterwards.
   */
  refuseIfFull(projections: readonly ProjectWorkMentionProjection[] | undefined): void {
    if (!projections || projections.length === 0) return;
    if (this.envelopes.length < MENTION_CONTEXT_MESSAGES_MAX) return;
    throw new ProtocolError(
      ErrorCodes.SessionBusy,
      `${String(MENTION_CONTEXT_MESSAGES_MAX)} messages that mention project work are already waiting for this agent. Let it read some, or clear the queue, then send this again.`,
    );
  }

  /**
   * Take an identity for a message about to be offered to the engine.
   *
   * Reserved **before** the call, because the engine can start delivering a
   * message before the call that submitted it resolves: a steer is injected
   * from the running turn, and a direct prompt's `message_start` arrives while
   * `prompt()` is still awaiting its turn. A reservation that has not been
   * admitted is dropped by {@link discard}.
   */
  reserve(projections: readonly ProjectWorkMentionProjection[]): string {
    const id = `lmc-${randomBytes(9).toString("hex")}`;
    this.envelopes.push({ id, lane: "direct", state: "pending", projections: [...projections] });
    return id;
  }

  /** The engine accepted the message: record which door it went through. */
  admitted(id: string, lane: MentionSendLane): void {
    const envelope = this.find(id);
    if (envelope) envelope.lane = lane;
  }

  /** The engine never took it (a refusal, a throw, a rolled-back first turn). */
  discard(id: string): void {
    const at = this.envelopes.findIndex((envelope) => envelope.id === id);
    if (at >= 0) this.envelopes.splice(at, 1);
  }

  /**
   * The engine is delivering this exact message to the model (its user
   * `message_start`, or its id appearing in the list the model is about to
   * read). Either signal means the same thing and neither is a guess.
   */
  activate(id: string): void {
    const envelope = this.find(id);
    if (envelope) envelope.state = "active";
  }

  /** True while this message is still waiting in one of the engine's queues. */
  isQueued(id: string): boolean {
    const envelope = this.find(id);
    return envelope !== undefined && envelope.state === "pending" && envelope.lane !== "direct";
  }

  /**
   * True for a message the engine took as this turn's own and never delivered
   * to the model — a text it dispatched as an extension command, say. Once its
   * call has returned there is nothing left to wait for.
   */
  isPendingDirect(id: string): boolean {
    const envelope = this.find(id);
    return envelope !== undefined && envelope.state === "pending" && envelope.lane === "direct";
  }

  /**
   * The activity settled: everything the model read in it is done with.
   *
   * A message still queued in the engine is **not** dropped here — a cancelled
   * turn leaves the person's queued message in place, and its context belongs
   * to the turn that will read it.
   */
  settled(): void {
    for (let at = this.envelopes.length - 1; at >= 0; at -= 1) {
      if (this.envelopes[at]!.state === "active") this.envelopes.splice(at, 1);
    }
  }

  /**
   * The person emptied the engine's queues. Exactly the messages that were
   * waiting in them go, by their own identity: a direct message that has been
   * accepted but has not reached its first model call yet is not in a queue
   * and is not touched.
   */
  dropQueued(): void {
    for (let at = this.envelopes.length - 1; at >= 0; at -= 1) {
      const envelope = this.envelopes[at]!;
      if (envelope.state === "pending" && envelope.lane !== "direct") this.envelopes.splice(at, 1);
    }
  }

  /**
   * The runtime was replaced (a first-turn agent choice, a model failover).
   * The new runtime has empty queues, so a message that was waiting in the old
   * one is gone; a message the model is reading survives, because a failover
   * retries the same turn.
   */
  rebaseline(): void {
    this.dropQueued();
  }

  /** The session is going away. */
  dropAll(): void {
    this.envelopes.length = 0;
  }

  /** For tests and diagnostics: what is held, and in what state. */
  held(): Array<{ id: string; lane: MentionSendLane; state: "pending" | "active"; mentions: number }> {
    return this.envelopes.map((envelope) => ({
      id: envelope.id,
      lane: envelope.lane,
      state: envelope.state,
      mentions: envelope.projections.length,
    }));
  }

  /**
   * What this model call reads, and where.
   *
   * A block goes immediately after the message whose id it carries. A message
   * the engine has dropped from the window — compaction runs inside an
   * activity — leaves its block at the end of the list, labelled for what it
   * is, because the projection still belongs to the turn in flight and must
   * never be matched to some other message instead.
   */
  blocks(messages: readonly MentionContextMessage[]): MentionContextBlock[] {
    const positions = new Map<string, number>();
    messages.forEach((message, index) => {
      if (message.correlationId !== undefined && !positions.has(message.correlationId)) {
        positions.set(message.correlationId, index);
      }
    });
    // A message in the list the model is about to read is being read now,
    // whatever else was observed: this is the same fact as its `message_start`.
    for (const envelope of this.envelopes) {
      if (positions.has(envelope.id)) envelope.state = "active";
    }
    const blocks: MentionContextBlock[] = [];
    let budget = MENTION_CONTEXT_RENDER_MAX;
    for (const envelope of this.envelopes) {
      if (envelope.state !== "active") continue;
      const at = positions.get(envelope.id);
      const full = renderProjections(envelope.projections, at === undefined);
      // Past the budget a message says what it named and where to read it,
      // which is short and bounded by the keys themselves. It is never simply
      // left out: a message whose context was promised always says something.
      const text = full.length <= budget ? full : renderKeysOnly(envelope.projections, at === undefined);
      budget -= text.length;
      blocks.push({ afterIndex: at ?? messages.length - 1, text });
    }
    return blocks;
  }

  private find(id: string): Envelope | undefined {
    return this.envelopes.find((envelope) => envelope.id === id);
  }
}

const ORPHAN_HEADER =
  "Project work mentioned in the message this turn is answering (that message is no longer in the window shown above).";
const HEADER = "Project work mentioned in the message above.";
const PREAMBLE =
  "Read at the exact revision the message named, bounded, and not re-read at the current revision.";

/** One projection, exactly as the host supplied it. */
function renderProjection(projection: ProjectWorkMentionProjection): string {
  const lines: string[] = [];
  lines.push(`${projection.provenance} ${projection.key} — ${projection.title}`);
  lines.push(`Kind: ${projection.kind} · State: ${projection.state}`);
  for (const field of projection.fields) lines.push(`${field.label}: ${field.value}`);
  if (projection.excerpt) lines.push(`Excerpt: ${projection.excerpt}`);
  if (projection.truncated) lines.push("The excerpt above was cut at its bound.");
  if (projection.unavailable) lines.push(`Not available: ${projection.unavailable.detail}`);
  return lines.join("\n");
}

function renderProjections(projections: readonly ProjectWorkMentionProjection[], orphaned: boolean): string {
  const head = orphaned ? ORPHAN_HEADER : HEADER;
  return [`## ${head}`, PREAMBLE, "", ...projections.map(renderProjection)].join("\n\n");
}

/**
 * The same message's mentions as identities alone, when the whole projection
 * does not fit this model call. It is never dropped: the keys say what was
 * named and how to read the rest, and the projection itself is still held for
 * the next call.
 */
function renderKeysOnly(projections: readonly ProjectWorkMentionProjection[], orphaned: boolean): string {
  const keys = projections.map((projection) => projection.key);
  const shown = keys.slice(0, KEYS_MAX).join(", ");
  const rest = keys.length > KEYS_MAX ? ` and ${String(keys.length - KEYS_MAX)} more` : "";
  const head = orphaned ? ORPHAN_HEADER : HEADER;
  return [
    `## ${head}`,
    `This message named ${shown}${rest}. Their details are not in this call because the context for the messages waiting ahead of it filled the space. Read them with inspect_project_work.`,
  ].join("\n\n");
}
