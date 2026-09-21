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

/** What the ceiling is measured in, and what the provider request costs. */
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

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

  it("refuses the seventeenth at the slot itself, not only at the polite check before it", () => {
    const mentions = new SessionMentionContext();
    for (let at = 0; at < MENTION_CONTEXT_MESSAGES_MAX; at += 1) {
      mentions.admitted(mentions.reserve([projection(`TASK-${String(at + 1)}`)]), "followUp");
    }

    // Two sends can both pass `refuseIfFull` and then race to the last slot:
    // every route awaits in between. Only one can have it, and the other is
    // refused here — before the engine is asked anything — with the same
    // sentence the early check would have used.
    expect(() => mentions.reserve([projection("TASK-99")])).toThrow(ProtocolError);
    expect(() => mentions.reserve([projection("TASK-99")])).toThrow(/clear the queue/);
    // A refused reservation leaves nothing behind: no slot, no id, no block.
    expect(mentions.held()).toHaveLength(MENTION_CONTEXT_MESSAGES_MAX);
    expect(mentions.held().map((held) => held.mentions)).toEqual(Array(MENTION_CONTEXT_MESSAGES_MAX).fill(1));

    // A slot freed by the message that held it retiring is usable again.
    const first = mentions.held()[0]!.id;
    mentions.activate(first);
    mentions.settled();
    expect(() => mentions.reserve([projection("TASK-99")])).not.toThrow();
    expect(mentions.held()).toHaveLength(MENTION_CONTEXT_MESSAGES_MAX);
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
    const total = blocks.reduce((sum, block) => sum + bytes(block.text), 0);
    expect(total).toBeLessThanOrEqual(MENTION_CONTEXT_RENDER_MAX);
    expect(blocks[1]!.afterIndex, "the short one still stands beside its own message").toBe(1);
    expect(blocks[0]!.text).toContain("TASK-100");
    // Nothing vanished: the message whose details did not fit says so, names
    // what it mentioned, and keeps its projection for the next call.
    const cut = blocks.find((block) => block.text.includes("did not fit this call"));
    expect(cut?.text).toMatch(/TASK-100|SPEC-7/);
    expect(mentions.held()).toHaveLength(2);
  });

  it("counts the ceiling in bytes, not in characters", () => {
    // A projection whose render is comfortably under the ceiling *in
    // characters* and far over it in bytes: three bytes per character is an
    // ordinary Japanese or Arabic title, not a pathological case. Counting
    // characters would have sent ~36 KB of context in a 24 KB budget.
    const mentions = new SessionMentionContext();
    const excerpt = "\u3053\u306e\u8aac\u660e".repeat(300); // 1_200 characters, 3_600 bytes
    const id = mentions.reserve(
      Array.from({ length: 10 }, (_, at) => projection(`TASK-${String(at + 200)}`, { excerpt })),
    );
    mentions.admitted(id, "direct");
    mentions.activate(id);

    const [block] = mentions.blocks([user(id)]);
    expect(block).toBeDefined();
    expect(bytes(block!.text)).toBeLessThanOrEqual(MENTION_CONTEXT_RENDER_MAX);
    // The character count of the full render is what the old measure would
    // have compared, and it would have passed.
    expect(block!.text).not.toContain(excerpt);
    expect(block!.text).toContain("TASK-200");
    expect(mentions.held()[0]!.mentions, "the complete projection is kept for the next call").toBe(10);
  });

  it("keeps every waiting message's context inside the byte ceiling, whatever the alphabet", () => {
    const mentions = new SessionMentionContext();
    // The worst case the admission ceiling allows: sixteen messages, all being
    // read in one call, each mentioning eight pieces of work with multi-byte
    // titles, fields and excerpts.
    const ids: string[] = [];
    for (let message = 0; message < MENTION_CONTEXT_MESSAGES_MAX; message += 1) {
      const id = mentions.reserve(
        Array.from({ length: 8 }, (_, at) =>
          projection(`TASK-${String(message * 10 + at + 1)}`, {
            title: "\u30ea\u30ea\u30fc\u30b9\u306e\u8a08\u753b".repeat(8),
            excerpt: "\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 ".repeat(20),
            fields: [{ label: "\u7d50\u679c", value: "\u3053\u306e\u4ed5\u4e8b\u306e\u7d50\u679c".repeat(10) }],
          }),
        ),
      );
      mentions.admitted(id, message % 2 === 0 ? "direct" : "steer");
      mentions.activate(id);
      ids.push(id);
    }

    const blocks = mentions.blocks(ids.map((id) => user(id)));

    // Every message the model is reading has its own block, beside itself.
    expect(blocks).toHaveLength(MENTION_CONTEXT_MESSAGES_MAX);
    expect(blocks.map((block) => block.afterIndex)).toEqual(ids.map((_, at) => at));
    // And every key of every message is named in that message's own block:
    // no message is skipped, no message is evicted by the ones ahead of it.
    blocks.forEach((block, message) => {
      for (let at = 0; at < 8; at += 1) {
        expect(block.text, `message ${String(message)} names TASK-${String(message * 10 + at + 1)}`)
          .toContain(`TASK-${String(message * 10 + at + 1)}`);
      }
    });
    // The whole call, measured as the provider measures it.
    const total = blocks.reduce((sum, block) => sum + bytes(block.text), 0);
    expect(total).toBeLessThanOrEqual(MENTION_CONTEXT_RENDER_MAX);
    // ...and the ceiling is really used: this is a packed call, not a timid
    // one that stayed small by accident. It does not reach the ceiling exactly
    // because a message is upgraded whole or not at all — a projection is
    // never cut in half to fill the last bytes.
    expect(total).toBeGreaterThan(MENTION_CONTEXT_RENDER_MAX * 0.7);
    // The space left over after every message had its share went to the
    // oldest messages, in full, and the youngest kept their summary.
    expect(blocks[0]!.text, "the oldest message is upgraded first").toContain("\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644");
    expect(blocks.at(-1)!.text).toContain("did not fit this call");
    expect(blocks.filter((block) => block.text.includes("did not fit this call")).length).toBeGreaterThan(0);
    // Nothing was degraded in the carrier itself.
    expect(mentions.held().map((held) => held.mentions)).toEqual(Array(MENTION_CONTEXT_MESSAGES_MAX).fill(8));
  });

  it("tells a message that did not fit how to get its details without naming a tool it may not have", () => {
    const mentions = new SessionMentionContext();
    const ids = Array.from({ length: MENTION_CONTEXT_MESSAGES_MAX }, (_, message) => {
      const id = mentions.reserve(
        Array.from({ length: 20 }, (_, at) =>
          projection(`TASK-${String(message * 100 + at + 1)}`, { excerpt: "y".repeat(1_200) }),
        ),
      );
      mentions.admitted(id, "direct");
      mentions.activate(id);
      return id;
    });

    const blocks = mentions.blocks(ids.map((id) => user(id)));
    const summary = blocks.at(-1)!.text;

    // A projectless chat receives mention context and registers no lifecycle
    // tool at all, so the way out cannot be "call this tool".
    expect(summary).not.toContain("inspect_project_work");
    expect(summary).not.toMatch(/_project_work|\btool\b/);
    expect(summary).toContain("the person can send them again, a few at a time");
    // It still says exactly what the message named, and how much it is not
    // showing.
    expect(summary).toContain(`TASK-${String(15 * 100 + 1)}`);
    expect(summary).toMatch(/and \d+ more/);
    expect(bytes(summary)).toBeLessThanOrEqual(MENTION_CONTEXT_RENDER_MAX / MENTION_CONTEXT_MESSAGES_MAX);
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
