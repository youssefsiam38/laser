/**
 * M21-T9: the `@` picker's project-work half, and what a pick becomes.
 *
 * Nothing here draws: this is the model the composer, the send path and the
 * transcript all read. What is proven is the contract — what the query asks
 * for, what ranks first, what the draft says, what the message carries, and
 * what happens to a key nobody picked.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  projectWorkMentionDefinitions,
  projectWorkMentionProse,
  projectWorkMentionSpans,
  type ProjectWorkRef,
} from "@lasercode/protocol";

import {
  candidateOfListItem,
  clearWorkMentionPins,
  decodeWorkMentionItemId,
  expandWorkMentions,
  nextWorkMentionLabel,
  parseWorkMentionQuery,
  parseWorkMentionSegment,
  pinWorkMention,
  rankWorkMentions,
  workMentionItemId,
  workMentionSegmentId,
  workMentionToken,
  type MentionProject,
  type WorkMentionCandidate,
} from "../../src/project-work/mentions.js";

import { item } from "./fixture.js";

const here: MentionProject = { projectId: "p1", name: "acme", current: true };
const there: MentionProject = { projectId: "p2", name: "relay", current: false };

const refOf = (over: Partial<ProjectWorkRef> & { key: string }): ProjectWorkRef => ({
  projectId: "p1",
  kind: "task",
  entityId: "e1",
  revisionId: "r1",
  digest: "a".repeat(64),
  label: "Rework the picker",
  ...over,
});

const candidate = (over: Partial<WorkMentionCandidate> & { key: string }): WorkMentionCandidate => ({
  ref: refOf({ key: over.key, ...(over.ref ?? {}) }),
  kind: over.kind ?? "task",
  key: over.key,
  title: over.title ?? over.key,
  state: over.state ?? "draft",
  project: over.project ?? here,
  exactKey: over.exactKey ?? false,
  score: over.score ?? 0,
});

afterEach(() => clearWorkMentionPins());

describe("what the typed @ asks project work", () => {
  it("reads the five kind prefixes, a key, and a title", () => {
    expect(parseWorkMentionQuery("spec:phone")).toEqual({ kinds: ["spec"], text: "phone", key: undefined });
    expect(parseWorkMentionQuery("task:")).toEqual({ kinds: ["task"], text: "", key: undefined });
    expect(parseWorkMentionQuery("TASK-44")).toEqual({ kinds: [], text: "TASK-44", key: "TASK-44" });
    // Lower case is how people type a key they are halfway through.
    expect(parseWorkMentionQuery("task-44")?.key).toBe("TASK-44");
    expect(parseWorkMentionQuery("footer")).toEqual({ kinds: [], text: "footer", key: undefined });
  });

  it("asks it nothing for a path, or for `@` alone", () => {
    expect(parseWorkMentionQuery("")).toBeUndefined();
    expect(parseWorkMentionQuery("./server/")).toBeUndefined();
    expect(parseWorkMentionQuery("~/notes")).toBeUndefined();
    expect(parseWorkMentionQuery("two words")).toBeUndefined();
    // A search field is not a composer: it may ask in a sentence.
    expect(parseWorkMentionQuery("two words", { freeText: true })).toEqual({ kinds: [], text: "two words", key: undefined });
  });
});

describe("the order the picker draws", () => {
  it("puts the exact key first, then this project, then the others in blocks", () => {
    const rows = rankWorkMentions([
      candidate({ key: "TASK-10", project: there, ref: { projectId: "p2", entityId: "e10" } }),
      candidate({ key: "TASK-2", project: here, ref: { entityId: "e2" }, score: 5 }),
      candidate({ key: "TASK-11", project: there, ref: { projectId: "p2", entityId: "e11" } }),
      candidate({ key: "TASK-44", project: there, ref: { projectId: "p2", entityId: "e44" }, exactKey: true }),
      candidate({ key: "TASK-3", project: here, ref: { entityId: "e3" }, score: 9 }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["TASK-44", "TASK-3", "TASK-2", "TASK-10", "TASK-11"]);
    // Every row from another project says which one, so a key is never
    // ambiguous between two projects.
    expect(rows.filter((row) => !row.project.current).map((row) => row.project.name)).toEqual(["relay", "relay", "relay"]);
  });

  it("never lists the same entity twice, however many sources found it", () => {
    const row = item({ entityId: "e1", kind: "spec", number: 4, title: "The relay" });
    const rows = rankWorkMentions([
      candidateOfListItem(row, here, "SPEC-4"),
      candidateOfListItem(row, here, "SPEC-4"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exactKey).toBe(true);
  });
});

describe("what a pick writes, and what the message carries", () => {
  it("writes the human form and keeps the identity beside it", () => {
    const ref = refOf({ key: "TASK-44", entityId: "e44", revisionId: "r3" });
    const label = nextWorkMentionLabel("Finish ", ref);
    const token = workMentionToken(ref, label);
    expect(token).toBe('@TASK-44 "Rework the picker"');

    pinWorkMention(label, ref);
    const draft = `Finish ${token} today.`;
    const sent = expandWorkMentions(draft);

    // The visible text is untouched; the identity rides under it.
    expect(sent.startsWith(draft)).toBe(true);
    expect(projectWorkMentionProse(sent)).toBe(draft);
    const [definition] = projectWorkMentionDefinitions(sent);
    expect(definition!.ref).toMatchObject({
      projectId: "p1",
      kind: "task",
      entityId: "e44",
      revisionId: "r3",
      digest: ref.digest,
      key: "TASK-44",
    });
  });

  it("keeps two revisions of one key apart in the same message", () => {
    const current = refOf({ key: "TASK-44", entityId: "e44", revisionId: "r3" });
    const older = refOf({ key: "TASK-44", entityId: "e44", revisionId: "r1", digest: "b".repeat(64) });
    const first = nextWorkMentionLabel("", current);
    pinWorkMention(first, current);
    const draft = `${workMentionToken(current, first)} changed since `;
    const second = nextWorkMentionLabel(draft, older);
    pinWorkMention(second, older);
    expect(second).toBe("TASK-44#2");

    const sent = expandWorkMentions(`${draft}${workMentionToken(older, second)}`);
    expect(projectWorkMentionSpans(sent).map((span) => span.ref?.revisionId)).toEqual(["r3", "r1"]);
  });

  it("resolves a key somebody simply typed against the project they are writing in", () => {
    const row = item({ entityId: "e7", kind: "spec", number: 7, title: "Mentions" });
    const sent = expandWorkMentions("read @SPEC-7 first", { byKey: (key) => (key === "SPEC-7" ? row.ref : undefined) });
    expect(projectWorkMentionSpans(sent)[0]!.ref).toMatchObject({ entityId: "e7", key: "SPEC-7" });
  });

  it("leaves a key nothing can resolve as ordinary words", () => {
    const sent = expandWorkMentions("read @SPEC-99 first");
    expect(sent).toBe("read @SPEC-99 first");
    expect(projectWorkMentionDefinitions(sent)).toHaveLength(0);
  });

  it("does not stack a second identity when the same message is sent again", () => {
    const ref = refOf({ key: "TASK-44" });
    pinWorkMention("TASK-44", ref);
    const once = expandWorkMentions('do @TASK-44 "Rework the picker"');
    expect(expandWorkMentions(once)).toBe(once);
  });
});

describe("the identity a row and a chip carry", () => {
  it("survives a round trip through a picker row's id", () => {
    const ref = refOf({ key: "DES-2", kind: "design", entityId: "e2", revisionId: "r9", label: "The footer" });
    const decoded = decodeWorkMentionItemId(workMentionItemId(ref), `DES-2 ${ref.label}`);
    expect(decoded).toEqual(ref);
    expect(decodeWorkMentionItemId("agent:00", "x")).toBeUndefined();
  });

  it("survives a round trip through a transcript chip's id", () => {
    const ref = refOf({ key: "RES-3", kind: "research", entityId: "e3", revisionId: "r2" });
    const parsed = parseWorkMentionSegment(workMentionSegmentId(ref));
    expect(parsed?.key).toBe("RES-3");
    expect(parsed?.target).toEqual({ projectId: "p1", kind: "research", entityId: "e3", revisionId: "r2" });
    // A key whose kind disagrees with the link is two identities, not one.
    expect(parseWorkMentionSegment(`${workMentionSegmentId(ref).split("?")[0]}?key=TASK-3`)).toBeUndefined();
  });
});
