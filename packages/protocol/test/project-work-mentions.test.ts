/**
 * M21-T9: the mention token grammar both the composer and the host read.
 *
 * The rules that matter: the prose keeps the human form, the identity lives in
 * the definitions at the foot of the message, a token without a definition is
 * a key somebody typed (never a guessed revision), and the search projection
 * stores the prose once.
 */
import { describe, expect, it } from "vitest";

import {
  PROJECT_WORK_MENTION_MAX,
  projectWorkMentionDefinition,
  projectWorkMentionDefinitions,
  projectWorkMentionProse,
  projectWorkMentionSpans,
  projectWorkMentionToken,
  projectWorkMentionUrl,
  withProjectWorkMentions,
  type ProjectWorkRef,
} from "../src/index.js";

const digest = "a".repeat(64);
const other = "b".repeat(64);

const task: ProjectWorkRef = {
  projectId: "p_a1",
  kind: "task",
  entityId: "e_9",
  revisionId: "r_3",
  digest,
  key: "TASK-44",
  label: "Rework the picker",
};
const spec: ProjectWorkRef = {
  projectId: "p_b2",
  kind: "spec",
  entityId: "e_2",
  revisionId: "r_1",
  digest: other,
  key: "SPEC-7",
  label: "Mentions",
};

describe("the human form", () => {
  it("is the key and the title, quoted so a title with spaces survives", () => {
    expect(projectWorkMentionToken(task)).toBe('@TASK-44 "Rework the picker"');
    expect(projectWorkMentionToken({ key: "SPEC-7", label: "" })).toBe("@SPEC-7");
  });

  it("carries the four parts of the identity in its definition", () => {
    expect(projectWorkMentionDefinition("TASK-44", task)).toBe(
      `[TASK-44]: ${projectWorkMentionUrl(task)} "sha256-${digest}"`,
    );
  });
});

describe("parsing a sent message", () => {
  const sent = withProjectWorkMentions(
    'Compare @TASK-44 "Rework the picker" with @SPEC-7 "Mentions".',
    new Map([
      ["TASK-44", task],
      ["SPEC-7", spec],
    ]),
  );

  it("pins each token to the identity its message defines", () => {
    const spans = projectWorkMentionSpans(sent);
    expect(spans.map((span) => span.key)).toEqual(["TASK-44", "SPEC-7"]);
    expect(spans[0]!.ref).toMatchObject({ projectId: "p_a1", entityId: "e_9", revisionId: "r_3", digest });
    expect(spans[1]!.ref).toMatchObject({ projectId: "p_b2", revisionId: "r_1", digest: other });
    // The title in the prose is what the person sees, so it is what the chip says.
    expect(spans[0]!.title).toBe("Rework the picker");
  });

  it("leaves the prose exactly as the person wrote it", () => {
    expect(projectWorkMentionProse(sent)).toBe('Compare @TASK-44 "Rework the picker" with @SPEC-7 "Mentions".');
    expect(sent.startsWith('Compare @TASK-44 "Rework the picker" with @SPEC-7 "Mentions".')).toBe(true);
  });

  it("is idempotent: sending the same text again stacks no second identity", () => {
    const again = withProjectWorkMentions(sent, new Map([["TASK-44", { ...task, revisionId: "r_9" }]]));
    expect(again).toBe(sent);
    expect(projectWorkMentionDefinitions(again)).toHaveLength(2);
  });

  it("never invents a revision for a key somebody simply typed", () => {
    const spans = projectWorkMentionSpans("look at TASK-44 and @SPEC-7 please");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.ref).toBeUndefined();
    expect(spans[0]!.key).toBe("SPEC-7");
  });

  it("reads a token only where it opens and closes a word", () => {
    expect(projectWorkMentionSpans("mail me@TASK-44 now")).toHaveLength(0);
    expect(projectWorkMentionSpans("@TASK-44x")).toHaveLength(0);
    expect(projectWorkMentionSpans("see @TASK-44.").map((span) => span.key)).toEqual(["TASK-44"]);
  });

  it("refuses a definition whose link is malformed rather than repairing it", () => {
    const withoutRevision = projectWorkMentionUrl(task).replace(/\/r_3$/u, "");
    expect(projectWorkMentionDefinitions(`[TASK-44]: ${withoutRevision} "sha256-${digest}"`)).toHaveLength(0);
    expect(projectWorkMentionDefinitions(`[TASK-44]: ${projectWorkMentionUrl(task)}`)).toHaveLength(0);
    // A key whose prefix disagrees with the link's kind is two identities.
    expect(projectWorkMentionDefinitions(`[SPEC-7]: ${projectWorkMentionUrl(task)} "sha256-${digest}"`)).toHaveLength(0);
  });

  it("distinguishes two pins of the same key in one message", () => {
    const older: ProjectWorkRef = { ...task, revisionId: "r_1", digest: other };
    const text = withProjectWorkMentions(
      "@TASK-44 changed since @TASK-44#2",
      new Map([
        ["TASK-44", task],
        ["TASK-44#2", older],
      ]),
    );
    const spans = projectWorkMentionSpans(text);
    expect(spans.map((span) => span.ref?.revisionId)).toEqual(["r_3", "r_1"]);
  });

  it("writes no more definitions than a message may carry", () => {
    const keys = Array.from({ length: PROJECT_WORK_MENTION_MAX + 4 }, (_, index) => `TASK-${index + 1}`);
    const pinned = new Map(keys.map((key) => [key, { ...task, key, entityId: `e_${key}` }]));
    const text = withProjectWorkMentions(keys.map((key) => `@${key}`).join(" "), pinned);
    expect(projectWorkMentionDefinitions(text)).toHaveLength(PROJECT_WORK_MENTION_MAX);
  });
});

describe("what a search index stores", () => {
  it("is the prose once, never the identity lines beside it", () => {
    const sent = withProjectWorkMentions('Read @TASK-44 "Rework the picker" first.', new Map([["TASK-44", task]]));
    const indexed = projectWorkMentionProse(sent);
    expect(indexed).toBe('Read @TASK-44 "Rework the picker" first.');
    expect(indexed).not.toContain("sha256-");
    expect(indexed).not.toContain("work/p_a1");
    expect(indexed).not.toContain(projectWorkMentionUrl(task));
    // The key is in the index exactly once: the prose carries it, the
    // definition is gone, so a search for TASK-44 cannot score it twice.
    expect(indexed.split("TASK-44")).toHaveLength(2);
  });
});
