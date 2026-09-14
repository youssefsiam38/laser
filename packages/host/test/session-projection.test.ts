import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, PRODUCT_NAME, historyWindow, type HistoryWindowRequest } from "@lasercode/protocol";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionProjection } from "../src/session-projection.js";
import { SessionRevisions } from "../src/session-revision.js";

const ENVIRONMENT = "11111111-2222-4333-8444-555555555555";
const CWD = "/projects/a";
const header = (id = "session-1") => JSON.stringify({ type: "session", version: 3, id, cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" });
const message = (id: string, parentId: string | null, index: number, extra: Record<string, unknown> = {}) => ({
  type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${index}` }] },
  ...extra,
});

function messages(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => message(`e${index}`, index ? `e${index - 1}` : null, index));
}

function fixture(entries: unknown[], options: { finalNewline?: boolean; tail?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-projection-`));
  const path = join(dir, "session.jsonl");
  const body = [header(), ...entries.map(entry => JSON.stringify(entry))].join("\n") + (options.tail ?? (options.finalNewline === false ? "" : "\n"));
  writeFileSync(path, body);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function services(options: ConstructorParameters<typeof SessionIndexCache>[0] = {}, hooks: Partial<ConstructorParameters<typeof SessionProjection>[0]> = {}) {
  const index = new SessionIndexCache(options);
  const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
  const projection = new SessionProjection({ index, revisions, ...hooks });
  return { index, revisions, projection };
}

async function project(projection: SessionProjection, path: string, window?: HistoryWindowRequest, baseRevision?: string) {
  const answer = await projection.read(path, window, baseRevision);
  if (answer.kind === "refuse") throw answer.error;
  if (answer.kind === "route-live") throw new Error(`unexpected live route: ${answer.reason.reason}`);
  return answer.result;
}

function stableWindow(window: NonNullable<Awaited<ReturnType<typeof project>>["window"]>) {
  const { epoch: _epoch, seq: _seq, authority: _authority, mode: _mode, live: _live, ...stable } = window;
  return stable;
}

describe("worker-free session projection", () => {
  it.each([
    ["empty", []],
    ["one", messages(1)],
    ["240", messages(240)],
    ["2,000", messages(2_000)],
    ["branched", [...messages(8), message("fork", "e1", 10)]],
    ["compacted", [...messages(8), { type: "compaction", id: "compact", parentId: "e7", summary: "Earlier context" }]],
    ["goal", [{ type: "custom", id: "goal", parentId: null, customType: "goal-state", data: { goal: { id: "g1" } } }, ...messages(4).map((entry, index) => ({ ...(entry as object), parentId: index ? `e${index - 1}` : "goal" }))]],
    ["image", [message("e0", null, 0, { message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] } })]],
  ] as const)("matches the canonical live display projection for %s", async (_name, entries) => {
    const f = fixture([...entries]);
    try {
      const { revisions, projection } = services();
      const durable = await project(projection, f.path, { tail: 40 });
      const revision = await revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const snapshot = { entries: [...entries], leafId: (entries.at(-1) as { id?: string } | undefined)?.id ?? null };
      const live = historyWindow(snapshot, { tail: 40 }, {
        sessionId: "session-1", epoch: "live", seq: 9,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", mode: "replace",
      });
      expect(durable.entries).toEqual(live.entries);
      expect(durable.leafId).toBe(live.leafId);
      expect(stableWindow(durable.window!)).toEqual(stableWindow(live.window));
      expect(durable.window).toMatchObject({ authority: "durable", mode: "replace", seq: 0 });
      expect(durable.window).not.toHaveProperty("live");
    } finally {
      f.cleanup();
    }
  });

  it("keeps valid unterminated records and excludes a torn tail without changing either file", async () => {
    for (const [tail, expected] of [["", 2], ["\n{\"type\":\"message\",\"id\":\"torn\"", 2]] as const) {
      const f = fixture(messages(2), { finalNewline: false, tail });
      try {
        const before = readFileSync(f.path);
        const stats = statSync(f.path);
        const service = services();
        const page = await project(service.projection, f.path, { tail: 40 });
        expect(page.entries).toHaveLength(expected);
        const revision = await service.revisions.read(f.path);
        if (revision.kind !== "answer") throw new Error("missing revision");
        const live = historyWindow({ entries: messages(expected), leafId: `e${expected - 1}` }, { tail: 40 }, {
          sessionId: "session-1", epoch: "live", seq: 1, revision: revision.result.revision,
          environmentKey: revision.result.environmentKey, authority: "live", mode: "replace",
        });
        expect(page.entries).toEqual(live.entries);
        expect(stableWindow(page.window!)).toEqual(stableWindow(live.window));
        expect(readFileSync(f.path)).toEqual(before);
        expect(statSync(f.path)).toMatchObject({ size: stats.size, ino: stats.ino, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs });
      } finally {
        f.cleanup();
      }
    }
  });

  it("reads only selected line bodies, pages older rows by opaque cursor, and leaves JSONL untouched", async () => {
    const entries = messages(240);
    ((entries[0] as { message: { content: unknown[] } }).message.content).push({ type: "image", mimeType: "image/png", data: `large-old-image-${"x".repeat(256 * 1024)}` });
    const f = fixture(entries);
    const reads: string[] = [];
    try {
      const before = readFileSync(f.path);
      const { projection } = services({}, { onMaterializeRead: row => { if (row.id) reads.push(row.id); } });
      const tail = await project(projection, f.path, undefined);
      expect(tail.entries).toEqual(entries.slice(-40));
      expect(JSON.stringify(tail)).not.toContain("large-old-image");
      expect(reads).toEqual(entries.slice(-40).map(entry => (entry as { id: string }).id));
      expect(JSON.stringify(tail.window?.before)).not.toContain(f.path);
      reads.length = 0;
      const older = await project(projection, f.path, { before: tail.window!.before! });
      expect(older.entries).toEqual(entries.slice(-80, -40));
      expect(reads).toEqual(entries.slice(-80, -40).map(entry => (entry as { id: string }).id));
      expect(readFileSync(f.path)).toEqual(before);
    } finally {
      f.cleanup();
    }
  });

  it("keeps an older-page cursor across appends and refuses it after the active branch forks away", async () => {
    const f = fixture(messages(12));
    try {
      const { projection } = services();
      const tail = await project(projection, f.path, { tail: 4 });
      appendFileSync(f.path, `${JSON.stringify(message("e12", "e11", 12))}\n`);
      const older = await project(projection, f.path, { before: tail.window!.before!, limit: 4 });
      expect(older.entries).toEqual(messages(12).slice(4, 8));

      appendFileSync(f.path, `${JSON.stringify(message("fork", "e1", 14))}\n`);
      await expect(projection.read(f.path, { before: tail.window!.before!, limit: 4 })).rejects.toThrow("history changed");
    } finally {
      f.cleanup();
    }
  });

  it("returns a proved append delta and replaces for branch, compaction, or an oversized suffix", async () => {
    const f = fixture(messages(4));
    try {
      const { revisions, projection } = services();
      const base = await revisions.read(f.path);
      if (base.kind !== "answer") throw new Error("missing base");
      appendFileSync(f.path, `${JSON.stringify(message("e4", "e3", 4))}\n`);
      const delta = await project(projection, f.path, { tail: 40 }, base.result.revision);
      expect(delta).toMatchObject({ entries: [message("e4", "e3", 4)], window: { mode: "delta", authority: "durable" } });

      appendFileSync(f.path, `${JSON.stringify({ type: "compaction", id: "compact", parentId: "e4", summary: "Earlier" })}\n`);
      expect((await project(projection, f.path, { tail: 40 }, delta.window!.revision)).window?.mode).toBe("replace");

      appendFileSync(f.path, `${JSON.stringify(message("fork", "e1", 8))}\n`);
      expect((await project(projection, f.path, { tail: 40 }, base.result.revision)).window?.mode).toBe("replace");
    } finally {
      f.cleanup();
    }

    const many = fixture(messages(4));
    try {
      const { revisions, projection } = services();
      const base = await revisions.read(many.path);
      if (base.kind !== "answer") throw new Error("missing base");
      for (let index = 4; index < 240; index++) appendFileSync(many.path, `${JSON.stringify(message(`e${index}`, `e${index - 1}`, index))}\n`);
      const answer = await project(projection, many.path, { tail: 40 }, base.result.revision);
      expect(answer.window?.mode).toBe("replace");
      expect(answer.entries.length).toBeLessThanOrEqual(200);
    } finally {
      many.cleanup();
    }
  });

  it("shrinks a replacement until its serialized bodies fit the one-MiB page bound", async () => {
    const entries = messages(50).map((entry, index) => ({
      ...(entry as object),
      message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(30_000) }] },
    }));
    const f = fixture(entries);
    try {
      const page = await project(services().projection, f.path, { tail: 40 });
      expect(page.window?.mode).toBe("replace");
      expect(page.entries.length).toBeLessThan(40);
      expect(Buffer.byteLength(JSON.stringify(page.entries))).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      f.cleanup();
    }
  });

  it("reindexes once across an append race and refuses a second stale-line interleaving", async () => {
    const appended = fixture(messages(2));
    try {
      let hooks = 0;
      const { projection } = services({}, { beforeMaterialize: (_index, attempt) => {
        hooks++;
        if (attempt === 0) appendFileSync(appended.path, `${JSON.stringify(message("e2", "e1", 2))}\n`);
      } });
      const page = await project(projection, appended.path, { tail: 40 });
      expect(page.entries).toHaveLength(3);
      expect(hooks).toBe(2);
    } finally {
      appended.cleanup();
    }

    const changed = fixture(messages(2));
    try {
      let hooks = 0;
      const { projection } = services({}, { onMaterializeRead: (row) => {
        if (row.id !== "e1" && row.id !== "z1") return;
        hooks++;
        const fd = openSync(changed.path, "r+");
        try {
          const current = readFileSync(changed.path).subarray(row.offset, row.offset + row.length).toString("utf8");
          const next = current.includes('"id":"e1"') ? current.replace('"id":"e1"', '"id":"z1"') : current.replace('"id":"z1"', '"id":"e1"');
          const bytes = Buffer.from(next);
          expect(writeSync(fd, bytes, 0, bytes.length, row.offset)).toBe(row.length);
        } finally { closeSync(fd); }
      } });
      const answer = await projection.read(changed.path, { tail: 40 });
      expect(answer.kind).toBe("refuse");
      if (answer.kind !== "refuse") throw new Error("expected refusal");
      expect(answer.error.code).toBe(ErrorCodes.InvalidParams);
      expect(hooks).toBe(2);
    } finally {
      changed.cleanup();
    }
  });

  it("refuses an over-cap index and never materialises a body", async () => {
    const f = fixture(messages(3));
    try {
      const read = vi.fn();
      const { projection } = services({ limits: { entries: 2 } }, { onMaterializeRead: read });
      const answer = await projection.read(f.path, { tail: 40 });
      expect(answer.kind).toBe("refuse");
      if (answer.kind !== "refuse") throw new Error("expected refusal");
      expect(answer.error.code).toBe(ErrorCodes.RevisionUnavailable);
      expect(read).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });
});
