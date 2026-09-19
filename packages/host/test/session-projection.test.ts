import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, HISTORY_PAGE_BYTE_LIMIT, PRODUCT_NAME, boundedHistoryWindow, historyContentSerializedBytes, historyWindow, type HistoryWindowRequest } from "@lasercode/protocol";
import { sha256Hex } from "../src/session-body-range.js";
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

/** A base64 PNG of `width × height` and `payloadBytes` of payload (M16-T89). */
function png(width: number, height: number, payloadBytes: number): string {
  const bytes = Buffer.alloc(Math.max(32, payloadBytes), 0x7a);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

/** A tool result carrying a screenshot, the shape that stopped a conversation paging. */
const screenshot = (id: string, parentId: string | null, data: string) => ({
  type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "toolResult", toolCallId: `c-${id}`, content: [{ type: "text", text: "screenshot taken" }, { type: "image", mimeType: "image/png", data }] },
});

/** Every image reference a served page carries, in page order. */
function pageImageRefs(page: { entries: unknown[]; window?: { context?: unknown[] } }): unknown[] {
  return [...page.entries, ...(page.window?.context ?? [])].flatMap(entry => {
    const value = entry as { content?: unknown[]; message?: { content?: unknown[] } };
    return (value.message?.content ?? value.content ?? []).flatMap(part => {
      const row = part as { ref?: unknown };
      return row.ref ? [row.ref] : [];
    });
  });
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

async function project(projection: SessionProjection, path: string, window?: HistoryWindowRequest, baseRevision?: string, bodyLimit?: number) {
  const answer = await projection.read(path, window, baseRevision, bodyLimit);
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
    // The failing shape: a 2.4 MB screenshot in a tool result. Both
    // authorities must publish the same reference for it, byte for byte.
    ["screenshot", [message("e0", null, 0), screenshot("e1", "e0", png(2560, 1440, 2_405_990))]],
  ] as const)("matches the canonical live display projection for %s", async (_name, entries) => {
    const f = fixture([...entries]);
    try {
      const { revisions, projection } = services();
      const durable = await project(projection, f.path, { tail: 40 });
      const revision = await revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const snapshot = { entries: [...entries], leafId: (entries.at(-1) as { id?: string } | undefined)?.id ?? null };
      // The live authority's own projection, digest and all: the durable page
      // must be identical to it, references for images included (M16-T89).
      const live = boundedHistoryWindow(snapshot, { tail: 40 }, {
        sessionId: "session-1", epoch: "live", seq: 9,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", selection: { kind: "replace" },
      }, { digest: sha256Hex });
      if (!live) throw new Error("the live authority refused this page");
      expect(durable.entries).toEqual(live.entries);
      expect(JSON.stringify(durable.entries)).toBe(JSON.stringify(live.entries));
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
          environmentKey: revision.result.environmentKey, authority: "live", selection: { kind: "replace" },
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
      const older = await project(projection, f.path, { before: tail.window!.before! }, tail.window!.revision);
      expect(older.entries).toEqual(entries.slice(-80, -40));
      expect(reads).toEqual(entries.slice(-80, -40).map(entry => (entry as { id: string }).id));
      reads.length = 0;
      const recovered = await project(projection, f.path, { beforeEntry: "e200", limit: 40 }, tail.window!.revision);
      expect(recovered.entries).toEqual(older.entries);
      expect(recovered.window?.before).toBe(older.window?.before);
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
      const older = await project(projection, f.path, { before: tail.window!.before!, limit: 4 }, tail.window!.revision);
      expect(older.entries).toEqual(messages(12).slice(4, 8));
      expect(older.window!.revision).not.toBe(tail.window!.revision);
      expect((await project(projection, f.path, { beforeEntry: "e8", limit: 4 }, tail.window!.revision)).entries).toEqual(older.entries);

      appendFileSync(f.path, `${JSON.stringify(message("fork", "e1", 14))}\n`);
      await expect(projection.read(f.path, { before: tail.window!.before!, limit: 4 }, tail.window!.revision)).resolves.toMatchObject({ kind: "refuse", error: { code: ErrorCodes.RevisionUnavailable } });
      await expect(projection.read(f.path, { beforeEntry: "e8", limit: 4 }, tail.window!.revision)).resolves.toMatchObject({ kind: "refuse", error: { code: ErrorCodes.RevisionUnavailable } });
    } finally {
      f.cleanup();
    }
  });

  it("keeps every non-live-edge request exact for current and prefix bases", async () => {
    const entries = messages(12);
    const f = fixture(entries);
    try {
      const { revisions, projection } = services();
      const base = await revisions.read(f.path);
      if (base.kind !== "answer") throw new Error("missing base");
      const tail = await project(projection, f.path, { tail: 4 });
      const shapes = [
        { name: "tail", request: { tail: 4 } as const, current: [] as unknown[], prefix: [] as unknown[] },
        { name: "before", request: { before: tail.window!.before!, limit: 4 } as const, current: entries.slice(4, 8), prefix: entries.slice(4, 8) },
        { name: "from", request: { from: "e4" } as const, current: entries.slice(4), prefix: [] as unknown[] },
        { name: "all", request: { all: true } as const, current: entries, prefix: [] as unknown[] },
      ];
      for (const shape of shapes) {
        const current = await project(projection, f.path, shape.request, base.result.revision);
        expect(current.entries, `${shape.name} current entries`).toEqual(shape.current);
        expect(current.window?.mode, `${shape.name} current mode`).toBe(shape.name === "tail" ? "delta" : "replace");
        if (shape.name === "tail") {
          expect(current.window?.anchor).toBeUndefined();
          expect(current.window?.before).toBeUndefined();
          expect(current.window?.context).toEqual([]);
          const live = boundedHistoryWindow({ entries, leafId: "e11" }, shape.request, {
            sessionId: "session-1", epoch: "live", seq: 1,
            revision: base.result.revision, environmentKey: base.result.environmentKey,
            authority: "live", selection: { kind: "delta", after: "e11" },
          });
          expect(current.entries).toEqual(live?.entries);
          expect(stableWindow(current.window!)).toEqual(stableWindow(live!.window));
        }
      }

      const appended = [message("e12", "e11", 12), message("e13", "e12", 13)];
      for (const entry of appended) appendFileSync(f.path, `${JSON.stringify(entry)}\n`);
      for (const shape of shapes) {
        const prefix = await project(projection, f.path, shape.request, base.result.revision);
        const expected = shape.name === "tail" ? appended
          : shape.name === "from" ? [...entries, ...appended].slice(4)
            : shape.name === "all" ? [...entries, ...appended]
              : shape.prefix;
        expect(prefix.entries, `${shape.name} prefix entries`).toEqual(expected);
        expect(prefix.window?.mode, `${shape.name} prefix mode`).toBe(shape.name === "tail" ? "delta" : "replace");
        if (shape.name === "tail") {
          expect(prefix.window).toMatchObject({ anchor: "e12", before: expect.any(String) });
          expect(() => JSON.parse(prefix.window!.before!)).toThrow();
          const latest = await revisions.read(f.path);
          if (latest.kind !== "answer") throw new Error("missing latest revision");
          const live = boundedHistoryWindow({ entries: [...entries, ...appended], leafId: "e13" }, shape.request, {
            sessionId: "session-1", epoch: "live", seq: 2,
            revision: latest.result.revision, environmentKey: latest.result.environmentKey,
            authority: "live", selection: { kind: "delta", after: "e11" },
          });
          expect(prefix.entries).toEqual(live?.entries);
          expect(stableWindow(prefix.window!)).toEqual(stableWindow(live!.window));
        }
      }
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
    const entries = messages(100).map((entry, index) => ({
      ...(entry as object),
      message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(30_000) }] },
    }));
    const f = fixture(entries);
    try {
      const service = services();
      const page = await project(service.projection, f.path, { tail: 40 });
      const revision = await service.revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const live = boundedHistoryWindow({ entries, leafId: "e99" }, { tail: 40 }, {
        sessionId: "session-1", epoch: "live", seq: 1,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", selection: { kind: "replace" },
      });
      expect(live).toBeDefined();
      expect(page.window?.mode).toBe("replace");
      expect(page.entries.length).toBeLessThan(40);
      expect(page.entries).toEqual(live!.entries);
      expect(stableWindow(page.window!)).toEqual(stableWindow(live!.window));
      expect(historyContentSerializedBytes(page.entries, page.window?.context ?? [])).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_LIMIT);
      const before = await project(service.projection, f.path, { before: page.window!.before!, limit: 40 }, page.window!.revision);
      expect(before.window).toMatchObject({ mode: "replace", before: expect.any(String) });
      expect(before.entries.length).toBeLessThan(40);
      expect(historyContentSerializedBytes(before.entries, before.window?.context ?? [])).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_LIMIT);
    } finally {
      f.cleanup();
    }
  });

  it("plans retained prompt text by its escaped wire cost and returns a bounded useful page", async () => {
    // A prompt whose prose fits the caller's body limit, in a record no page can
    // carry for a reason that is not a body at all: an attachment part this
    // version does not name (M16-T88). An image would no longer do — it travels
    // as a reference at any size (M16-T89) — and the thing under test here is
    // that the planner prices the *retained prose* at its escaped wire cost.
    const retainedPrompt = (index: number, text: string, blobBytes: number) => ({
      type: "message", id: `blob-${index}`, parentId: index ? `blob-${index - 1}` : null,
      message: { role: "user", content: [
        { type: "text", text },
        { type: "file", mimeType: "application/pdf", data: "A".repeat(blobBytes) },
      ] },
    });
    const cases = [
      { name: "ordinary", entries: Array.from({ length: 12 }, (_, index) => retainedPrompt(index, "p".repeat(15 * 1024), HISTORY_PAGE_BYTE_LIMIT)), limit: 16 * 1024 },
      // One byte in the body becomes six bytes in JSON; UTF-8 body bytes alone
      // are therefore not a safe estimate of this retained row's wire cost.
      { name: "escaped", entries: Array.from({ length: 12 }, (_, index) => retainedPrompt(index, "\u0001".repeat(15 * 1024), HISTORY_PAGE_BYTE_LIMIT)), limit: 16 * 1024 },
      // At the schema maximum, one unnameable attachment may make the source row
      // larger than a page even though its elided identity plus a small prompt
      // fits easily.
      { name: "maximum bodyLimit", entries: [retainedPrompt(0, "small prompt", HISTORY_PAGE_BYTE_LIMIT + 1)], limit: HISTORY_PAGE_BYTE_LIMIT },
    ];
    for (const scenario of cases) {
      const f = fixture(scenario.entries);
      try {
        const page = await project(services().projection, f.path, { tail: scenario.entries.length }, undefined, scenario.limit);
        const elided = page.window?.elided ?? [];
        expect(elided.length, scenario.name).toBeGreaterThan(0);
        expect(elided.length, scenario.name).toBeLessThanOrEqual(scenario.entries.length);
        expect(historyContentSerializedBytes(page.entries, page.window?.context ?? [])
          + historyContentSerializedBytes(elided, []), scenario.name).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_LIMIT);
        expect(elided.at(-1)?.id, scenario.name).toBe(`blob-${scenario.entries.length - 1}`);
      } finally {
        f.cleanup();
      }
    }
  });

  it("serves the shape that stopped a conversation paging, whole and at every body limit (M16-T89)", async () => {
    // Twenty ordinary messages and the two tool results that broke a 27 MB
    // conversation: 2,421,366 B and 2,405,990 B of base64 screenshot. A page
    // holding either used to be impossible, so every older page was refused.
    const ordinary = messages(20);
    const entries = [...ordinary,
      screenshot("shot-a", "e19", png(2560, 1440, 2_421_366)),
      screenshot("shot-b", "shot-a", png(2560, 1440, 2_405_990)),
    ];
    const f = fixture(entries);
    try {
      const service = services();
      const before = historyContentSerializedBytes(entries, []);
      for (const bodyLimit of [undefined, 16 * 1024, HISTORY_PAGE_BYTE_LIMIT]) {
        const answer = await service.projection.read(f.path, { tail: 40 }, undefined, bodyLimit);
        expect(answer.kind, `bodyLimit ${String(bodyLimit)}`).toBe("answer");
        if (answer.kind !== "answer") throw new Error("the failing shape was refused");
        const page = answer.result;
        const after = historyContentSerializedBytes(page.entries, page.window?.context ?? [])
          + historyContentSerializedBytes(page.window?.elided ?? [], []);
        expect(page.entries).toHaveLength(entries.length);
        expect(page.window?.elided ?? []).toEqual([]);
        expect(after).toBeLessThan(HISTORY_PAGE_BYTE_LIMIT / 8);
        expect(JSON.stringify(page)).not.toContain("zzzz");
        expect(pageImageRefs(page)).toEqual([
          { entryId: "shot-a", component: { kind: "image", index: 0 }, mimeType: "image/png", totalBytes: 3_228_488, contentDigest: expect.any(String), width: 2560, height: 1440 },
          { entryId: "shot-b", component: { kind: "image", index: 0 }, mimeType: "image/png", totalBytes: 3_207_988, contentDigest: expect.any(String), width: 2560, height: 1440 },
        ]);
        if (bodyLimit === undefined) console.info(`M16-T89 durable failing-shape page: ${before} B before, ${after} B after`);

        // The live authority answers the same request with the same bytes.
        const revision = await service.revisions.read(f.path);
        if (revision.kind !== "answer") throw new Error("missing revision");
        const live = boundedHistoryWindow({ entries, leafId: "shot-b" }, { tail: 40 }, {
          sessionId: "session-1", epoch: "live", seq: 1,
          revision: revision.result.revision, environmentKey: revision.result.environmentKey,
          authority: "live", selection: { kind: "replace" },
        }, { ...(bodyLimit === undefined ? {} : { limit: bodyLimit }), digest: sha256Hex });
        if (!live) throw new Error("the live authority refused the failing shape");
        expect(JSON.stringify(page.entries)).toBe(JSON.stringify(live.entries));
        expect(stableWindow(page.window!)).toEqual(stableWindow(live.window));
      }
    } finally {
      f.cleanup();
    }
  });

  it("refuses oversized all/from, and pages inside a last turn no page can hold whole", async () => {
    const ordinary = messages(20_000);
    const huge = [
      { type: "message", id: "huge-u", parentId: "e19999", message: { role: "user", content: "x".repeat(600_000) } },
      { type: "message", id: "huge-a", parentId: "huge-u", message: { role: "assistant", content: "y".repeat(600_000) } },
    ];
    const f = fixture([...ordinary, ...huge]);
    try {
      const reads = vi.fn();
      const { projection } = services({}, { onMaterializeRead: reads });
      const started = performance.now();
      const tail = await projection.read(f.path, { tail: 200 });
      const tailElapsedMs = performance.now() - started;
      // The turn is split between prompt and reply, never refused.
      expect(tail.kind).toBe("answer");
      if (tail.kind !== "answer") throw new Error("expected a page");
      expect(tail.result.entries.map(entry => (entry as { id: string }).id)).toEqual(["huge-a"]);
      expect(tail.result.window?.before).toBeTruthy();
      console.info(`RP-12 pathological 20k/tail:200: ${tailElapsedMs.toFixed(2)} ms`);
      const older = await projection.read(f.path, { before: tail.result.window!.before! }, tail.result.window!.revision);
      if (older.kind !== "answer") throw new Error("expected the prompt page");
      expect(older.result.entries.map(entry => (entry as { id: string }).id).at(-1)).toBe("huge-u");
      reads.mockClear();
      for (const request of [{ from: "e0" }, { all: true }] as const) {
        const answer = await projection.read(f.path, request);
        expect(answer.kind).toBe("refuse");
        if (answer.kind !== "refuse") throw new Error("expected refusal");
        expect(answer.error.code).toBe(ErrorCodes.RevisionUnavailable);
      }
      expect(reads).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("uses parsed wire size, not JSONL whitespace, identically to the live authority", async () => {
    const entry = message("e0", null, 0);
    const f = fixture([]);
    try {
      writeFileSync(f.path, `${header()}\n{${" ".repeat(HISTORY_PAGE_BYTE_LIMIT + 1)}${JSON.stringify(entry).slice(1)}\n`);
      const service = services();
      const durable = await project(service.projection, f.path, { tail: 1 });
      const revision = await service.revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const live = boundedHistoryWindow({ entries: [entry], leafId: "e0" }, { tail: 1 }, {
        sessionId: "session-1", epoch: "live", seq: 1,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", selection: { kind: "replace" },
      });
      expect(durable.entries).toEqual(live?.entries);
      expect(stableWindow(durable.window!)).toEqual(stableWindow(live!.window));
    } finally {
      f.cleanup();
    }
  });

  it("elides an oversized context record rather than refusing the page (M16-T88)", async () => {
    const entries = [
      { type: "custom", id: "goal", parentId: null, customType: "goal-state", data: { body: "x".repeat(HISTORY_PAGE_BYTE_LIMIT) } },
      message("old", "goal", 0),
      message("latest", "old", 1),
    ];
    const f = fixture(entries);
    try {
      const service = services();
      // The record is bigger than any page can carry, so it travels as identity
      // and body metadata; both authorities answer the same way, and neither
      // leaves the conversation unreadable behind it (M16-T88).
      const answer = await service.projection.read(f.path, { tail: 1 });
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") throw new Error("expected an answer");
      expect(answer.result.window.elided?.map(row => row.id)).toContain("goal");
      const revision = await service.revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const live = boundedHistoryWindow({ entries, leafId: "latest" }, { tail: 1 }, {
        sessionId: "session-1", epoch: "live", seq: 1,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", selection: { kind: "replace" },
      }, { digest: sha256Hex });
      expect(live?.window.elided?.map(row => row.id)).toContain("goal");
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
