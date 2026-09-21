/**
 * The mention context of one conversation, by itself (M21-T9).
 *
 * Every rule here is about *which* message a projection belongs to and how
 * long it is owed. The identity is the id the worker minted and the engine
 * carries; nothing in this file compares text, counts a queue or guesses a
 * position, because each of those was tried and each is wrong for two
 * identical messages sent through two different doors.
 */
import { describe, expect, it } from "vitest";
import { ProtocolError, type ProjectWorkMentionProjection } from "@lasercode/protocol";
import {
  MENTION_CONTEXT_MESSAGES_MAX,
  MENTION_CONTEXT_RENDER_MAX,
  SessionMentionContext,
  type MentionContextMessage,
} from "../../src/project-work/mentions.js";

const KIND_OF: Record<string, "spec" | "research" | "design" | "plan" | "task"> = {
  SPEC: "spec",
  RES: "research",
  DES: "design",
  PLAN: "plan",
  TASK: "task",
};

function projection(key: string, overrides: Partial<ProjectWorkMentionProjection> = {}): ProjectWorkMentionProjection {
  return {
    ref: {
      projectId: "p_a1",
      entityId: `e_${key.replace("-", "_")}`,
      revisionId: "r_3",
      kind: KIND_OF[key.split("-")[0]!]!,
      key,
      label: `${key} title`,
      digest: "8f1c".padEnd(64, "0"),
    },
    key,
    kind: KIND_OF[key.split("-")[0]!]!,
    title: `${key} title`,
    state: "in_progress",
    provenance: `[from Acme ${key}@3]`,
    fields: [{ label: "Outcome", value: `${key} outcome` }],
    excerpt: `${key} excerpt`,
    ...overrides,
  };
}

/** The same words, over and over: the case identity has to survive. */
const SAME = "look at this again";

function user(correlationId?: string): MentionContextMessage {
  return { role: "user", ...(correlationId ? { correlationId } : {}) };
}

describe("a session's mention context", () => {
  it("gives each message its own block, in its own place, however alike the words are", () => {
    const mentions = new SessionMentionContext();
    const first = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(first, "direct");
    const second = mentions.reserve([projection("SPEC-7")]);
    mentions.admitted(second, "steer");
    mentions.activate(first);
    mentions.activate(second);

    // Three user messages with the same words: one older than this session,
    // and the two this session admitted.
    const blocks = mentions.blocks([user(), { role: "assistant" }, user(first), user(second)]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.afterIndex, "beside its own message, never the older identical one").toBe(2);
    expect(blocks[0]!.text).toContain("[from Acme TASK-44@3]");
    expect(blocks[1]!.afterIndex).toBe(3);
    expect(blocks[1]!.text).toContain("[from Acme SPEC-7@3]");
    expect(blocks[1]!.text).not.toContain("TASK-44");
    void SAME;
  });

  it("gives nothing to a message this session did not send, and nothing to history", () => {
    const mentions = new SessionMentionContext();
    const id = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(id, "followUp");

    // A resumed conversation, a fork, another session's message: no id, or an
    // id nobody here minted.
    expect(mentions.blocks([user(), user("lmc-from-another-session")])).toEqual([]);
  });

  it("owes nothing until the engine delivers the message, and then owes it until the turn settles", () => {
    const mentions = new SessionMentionContext();
    const queued = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(queued, "followUp");
    expect(mentions.blocks([user("other")]), "still waiting in a queue").toEqual([]);

    mentions.activate(queued);
    expect(mentions.blocks([user(queued)])).toHaveLength(1);
    expect(mentions.blocks([user(queued)]), "read again in the same activity").toHaveLength(1);

    mentions.settled();
    expect(mentions.blocks([user(queued)]), "the activity that read it is over").toEqual([]);
    expect(mentions.held()).toEqual([]);
  });

  it("keeps a queued message's context through a settle it was not part of", () => {
    const mentions = new SessionMentionContext();
    const running = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(running, "direct");
    mentions.activate(running);
    const waiting = mentions.reserve([projection("SPEC-7")]);
    mentions.admitted(waiting, "steer");

    mentions.settled();

    expect(mentions.held()).toEqual([
      expect.objectContaining({ id: waiting, lane: "steer", state: "pending" }),
    ]);
  });

  it("drops what a cleared queue held, and only that", () => {
    const mentions = new SessionMentionContext();
    const reading = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(reading, "direct");
    mentions.activate(reading);
    const accepted = mentions.reserve([projection("PLAN-2")]);
    mentions.admitted(accepted, "direct");
    const queued = mentions.reserve([projection("SPEC-7")]);
    mentions.admitted(queued, "followUp");

    mentions.dropQueued();

    // The message being read, and a direct message accepted but not yet at its
    // first model call, were never in a queue for the person to clear.
    expect(mentions.held().map((held) => held.id)).toEqual([reading, accepted]);
  });

  it("forgets a queued message when the runtime it was queued in is replaced, and keeps the one being read", () => {
    const mentions = new SessionMentionContext();
    const reading = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(reading, "direct");
    mentions.activate(reading);
    const queued = mentions.reserve([projection("SPEC-7")]);
    mentions.admitted(queued, "steer");

    mentions.rebaseline();
    expect(mentions.held().map((held) => held.id)).toEqual([reading]);

    mentions.dropAll();
    expect(mentions.held()).toEqual([]);
  });

  it("forgets a message the engine never took", () => {
    const mentions = new SessionMentionContext();
    const id = mentions.reserve([projection("TASK-44")]);
    mentions.discard(id);
    expect(mentions.held()).toEqual([]);
    expect(mentions.blocks([user(id)])).toEqual([]);
  });

  it("tells a direct message that never reached the model from one still queued", () => {
    const mentions = new SessionMentionContext();
    const direct = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(direct, "direct");
    const queued = mentions.reserve([projection("SPEC-7")]);
    mentions.admitted(queued, "steer");

    expect(mentions.isPendingDirect(direct)).toBe(true);
    expect(mentions.isQueued(direct)).toBe(false);
    expect(mentions.isQueued(queued)).toBe(true);
    mentions.activate(direct);
    expect(mentions.isPendingDirect(direct), "being read is not waiting").toBe(false);
  });

  it("refuses a further mentioning message rather than accepting one it would not carry", () => {
    const mentions = new SessionMentionContext();
    for (let at = 0; at < MENTION_CONTEXT_MESSAGES_MAX; at += 1) {
      mentions.refuseIfFull([projection(`TASK-${String(at + 1)}`)]);
      mentions.admitted(mentions.reserve([projection(`TASK-${String(at + 1)}`)]), "followUp");
    }

    expect(() => mentions.refuseIfFull([projection("TASK-99")])).toThrow(ProtocolError);
    expect(() => mentions.refuseIfFull([projection("TASK-99")])).toThrow(/clear the queue/);
    // A message that mentions nothing costs nothing and is never refused.
    expect(() => mentions.refuseIfFull([])).not.toThrow();
    expect(() => mentions.refuseIfFull(undefined)).not.toThrow();
  });

  it("says what it could not fit in this call, beside the message it belongs to, and keeps it", () => {
    const mentions = new SessionMentionContext();
    const long = "x".repeat(1_100);
    const first = mentions.reserve(
      Array.from({ length: 20 }, (_, at) => projection(`TASK-${String(at + 100)}`, { excerpt: long })),
    );
    mentions.admitted(first, "direct");
    mentions.activate(first);
    const second = mentions.reserve([projection("SPEC-7")]);
    mentions.admitted(second, "steer");
    mentions.activate(second);

    const blocks = mentions.blocks([user(first), user(second)]);
    const total = blocks.reduce((sum, block) => sum + block.text.length, 0);
    expect(total).toBeLessThanOrEqual(MENTION_CONTEXT_RENDER_MAX);
    expect(blocks[1]!.afterIndex, "the short one still stands beside its own message").toBe(1);
    expect(blocks[0]!.text).toContain("TASK-100");
    // Nothing vanished: the message whose details did not fit says so, names
    // what it mentioned, and keeps its projection for the next call.
    const cut = blocks.find((block) => block.text.includes("not in this call"));
    expect(cut?.text).toMatch(/TASK-100|SPEC-7/);
    expect(mentions.held()).toHaveLength(2);
  });

  it("renders the host's projection and nothing of its own", () => {
    const mentions = new SessionMentionContext();
    const id = mentions.reserve([
      projection("TASK-44", { truncated: true }),
      projection("SPEC-7", {
        excerpt: undefined,
        unavailable: { reason: "unknown_revision", detail: "That revision is no longer stored on this computer." },
      }),
    ]);
    mentions.admitted(id, "direct");
    mentions.activate(id);

    const text = mentions.blocks([user(id)])[0]!.text;
    expect(text).toContain("[from Acme TASK-44@3] TASK-44 — TASK-44 title");
    expect(text).toContain("Kind: task · State: in_progress");
    expect(text).toContain("Outcome: TASK-44 outcome");
    expect(text).toContain("Excerpt: TASK-44 excerpt");
    expect(text).toContain("The excerpt above was cut at its bound.");
    expect(text).toContain("Not available: That revision is no longer stored on this computer.");
    expect(text).not.toContain("Excerpt: SPEC-7");
  });

  it("still owes the turn its context when compaction took the message out of the window", () => {
    const mentions = new SessionMentionContext();
    const id = mentions.reserve([projection("TASK-44")]);
    mentions.admitted(id, "direct");
    mentions.activate(id);

    // The message it belongs to is no longer in the list the model reads.
    const blocks = mentions.blocks([{ role: "user" }, { role: "assistant" }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.afterIndex, "at the end, never against some other message").toBe(1);
    expect(blocks[0]!.text).toContain("no longer in the window");
    expect(blocks[0]!.text).toContain("[from Acme TASK-44@3]");
  });

  it("keeps two conversations apart", () => {
    const one = new SessionMentionContext();
    const other = new SessionMentionContext();
    const id = one.reserve([projection("TASK-44")]);
    one.admitted(id, "direct");
    one.activate(id);

    expect(other.blocks([user(id)]), "another session's identity means nothing here").toEqual([]);
    expect(other.held()).toEqual([]);
    expect(one.blocks([user(id)])).toHaveLength(1);
  });
});
