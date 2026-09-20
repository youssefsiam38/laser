import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, HISTORY_PAGE_BYTE_LIMIT, PRODUCT_NAME, boundedHistoryWindow, entryWithImageReferences, historyContentSerializedBytes, historyWindow, type HistoryWindowRequest } from "@lasercode/protocol";
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

  /**
   * `count` turns of four stored rows: a prompt, a reply that calls a tool, the
   * tool's result and a closing reply. `outputBytes` is the tool result's own
   * text, which is what makes a real session large.
   */
  function turnEntries(count: number, outputBytes = 64): unknown[] {
    const entries: unknown[] = [];
    let parent: string | null = null;
    const push = (id: string, message: Record<string, unknown>): void => {
      entries.push({ type: "message", id, parentId: parent, timestamp: "2026-01-01T00:00:01.000Z", message });
      parent = id;
    };
    for (let turn = 0; turn < count; turn++) {
      push(`u${turn}`, { role: "user", content: [{ type: "text", text: `Prompt ${turn}` }] });
      push(`a${turn}`, { role: "assistant", content: [{ type: "toolCall", id: `c${turn}`, name: "bash", arguments: { command: "ls" } }] });
      push(`r${turn}`, { role: "toolResult", toolCallId: `c${turn}`, content: [{ type: "text", text: "o".repeat(outputBytes) }] });
      push(`z${turn}`, { role: "assistant", content: [{ type: "text", text: `Reply ${turn}` }] });
    }
    return entries;
  }

  it("prices a reference exactly, so a long id or media type cannot make a page refuse itself (M16-T89)", async () => {
    // The index prices rows it has not read. A flat allowance over an entry id
    // and a media type — both copied verbatim out of an untrusted record — was
    // optimistic by about a hundred bytes for a 400-character media type or a
    // 400-character id, and the exact materialized check then answered
    // RevisionUnavailable: the precise failure M16-T89 exists to delete. The
    // error comes from those two strings, not from the payload, so the fixture
    // keeps its screenshots small.
    const shot = png(1512, 982, 64 * 1024);
    const entries = [
      message("e0", null, 0),
      { type: "message", id: "f47ac10b-58cc-4372-a567-0e02b2c3d479", parentId: "e0", timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "toolResult", toolCallId: "c1", content: [{ type: "image", mimeType: "image/png", data: shot }] } },
      { type: "message", id: "long-media-type", parentId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "c2", content: [{ type: "image", mimeType: `image/${"x".repeat(394)}`, data: shot }] } },
      { type: "message", id: "i".repeat(400), parentId: "long-media-type", timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "toolResult", toolCallId: "c3", content: [{ type: "image", mimeType: "image/png", data: shot }] } },
    ];
    const f = fixture(entries);
    try {
      const service = services();
      const indexed = await service.index.read(f.path);
      if (!indexed.ok) throw new Error("expected an index");
      // Every row is priced at exactly what the projection will send for it.
      indexed.index.entries.forEach((row, at) => {
        const actual = Buffer.byteLength(JSON.stringify(entryWithImageReferences(entries[at], sha256Hex)), "utf8");
        expect(row.servedLength, `row ${at}`).toBe(actual);
      });
      // And the page is served rather than refused.
      const page = await project(service.projection, f.path, { tail: 40 }, undefined, 16 * 1024);
      expect(page.entries).toHaveLength(entries.length);
      expect(page.window?.elided ?? []).toEqual([]);
      expect(historyContentSerializedBytes(page.entries, page.window?.context ?? [])).toBeLessThan(HISTORY_PAGE_BYTE_LIMIT / 8);
    } finally {
      f.cleanup();
    }
  });

  it("pages a stored conversation in user-anchored turns, identically to the live authority (M16-T90)", async () => {
    const entries = turnEntries(200);
    const f = fixture(entries);
    try {
      const service = services();
      const revision = await service.revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const liveScope = {
        sessionId: "session-1", epoch: "live", seq: 7,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live" as const, selection: { kind: "replace" as const },
      };
      const live = (window: HistoryWindowRequest) => boundedHistoryWindow({ entries, leafId: "z199" }, window, liveScope, { limit: 16 * 1024, digest: sha256Hex });
      const userIds = (rows: unknown[]) => rows.filter(row => (row as { message?: { role?: string } }).message?.role === "user").map(row => (row as { id: string }).id);

      const first = await project(service.projection, f.path, { turns: 10 }, undefined, 16 * 1024);
      expect(userIds(first.entries)).toEqual(Array.from({ length: 10 }, (_, index) => `u${190 + index}`));
      expect(first.entries).toHaveLength(40);
      expect(JSON.stringify(first.entries)).toBe(JSON.stringify(live({ turns: 10 })!.entries));
      expect(stableWindow(first.window!)).toEqual(stableWindow(live({ turns: 10 })!.window));

      const earlier = await project(service.projection, f.path, { before: first.window!.before!, turns: 20 }, first.window!.revision, 16 * 1024);
      expect(userIds(earlier.entries)).toHaveLength(20);
      expect(earlier.entries).toHaveLength(80);
      const liveEarlier = live({ before: first.window!.before!, turns: 20 })!;
      expect(JSON.stringify(earlier.entries)).toBe(JSON.stringify(liveEarlier.entries));
      expect(stableWindow(earlier.window!)).toEqual(stableWindow(liveEarlier.window));

      // Every row of the conversation, once, in order, in bounded pages, and
      // "there is more" is false exactly at the root.
      const seen: string[] = [...earlier.entries, ...first.entries].map(row => (row as { id: string }).id);
      let page = earlier;
      let pages = 2;
      while (page.window?.before) {
        page = await project(service.projection, f.path, { before: page.window.before, turns: 20 }, page.window.revision, 16 * 1024);
        seen.unshift(...page.entries.map(row => (row as { id: string }).id));
        pages++;
        expect(pages).toBeLessThan(50);
      }
      expect(pages).toBe(11);
      expect(seen).toEqual(entries.map(row => (row as { id: string }).id));
      expect(page.window?.before).toBeUndefined();

      // A newest-page turn read still answers a proved append delta.
      const appended = turnEntries(1).map((row, index) => ({ ...(row as object), id: `n${index}`, parentId: index ? `n${index - 1}` : "z199" }));
      for (const row of appended) appendFileSync(f.path, `${JSON.stringify(row)}\n`);
      const delta = await project(service.projection, f.path, { turns: 10 }, first.window!.revision, 16 * 1024);
      expect(delta.window?.mode).toBe("delta");
      expect(delta.entries.map(row => (row as { id: string }).id)).toEqual(["n0", "n1", "n2", "n3"]);
    } finally {
      f.cleanup();
    }
  });

  it("serves the heavy record that no body limit elides, exactly as the live authority does (M16-T90)", async () => {
    // The shape a planner cannot guess about: a record far larger than the
    // caller's body limit in aggregate, with **no single body** over it — a long
    // reply, long reasoning and a few tool calls. It is never elided, so pricing
    // it as if it were under-charged it fivefold and the durable authority
    // refused pages it had served before. Both authorities must agree, on the
    // newest page and on every page behind it.
    const heavy = (index: number, parentId: string | null) => ({
      type: "message", id: `a${index}`, parentId, timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "r".repeat(15 * 1024) },
        { type: "text", text: "t".repeat(15 * 1024) },
        ...Array.from({ length: 4 }, (_, call) => ({ type: "toolCall", id: `c${index}-${call}`, name: "bash", arguments: { command: "y".repeat(15 * 1024) } })),
      ] },
    });
    const entries: unknown[] = [];
    let parent: string | null = null;
    for (let turn = 0; turn < 60; turn++) {
      entries.push({ type: "message", id: `u${turn}`, parentId: parent, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `Prompt ${turn}` }] } });
      entries.push(heavy(turn, `u${turn}`));
      entries.push({ type: "message", id: `r${turn}`, parentId: `a${turn}`, timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: `c${turn}-0`, content: [{ type: "text", text: "ok" }] } });
      parent = `r${turn}`;
    }
    const f = fixture(entries);
    try {
      const service = services();
      const revision = await service.revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const liveScope = {
        sessionId: "session-1", epoch: "live", seq: 5,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live" as const, selection: { kind: "replace" as const },
      };
      const live = (window: HistoryWindowRequest) => boundedHistoryWindow({ entries, leafId: parent }, window, liveScope, { limit: 16 * 1024, digest: sha256Hex });
      const ids = (rows: unknown[]) => rows.map(row => (row as { id: string }).id);

      for (const [name, first, earlier] of [
        ["turns", { turns: 10 } as HistoryWindowRequest, (before: string): HistoryWindowRequest => ({ before, turns: 20 })],
        ["entries", { tail: 40 } as HistoryWindowRequest, (before: string): HistoryWindowRequest => ({ before, limit: 40 })],
      ] as const) {
        let page = await project(service.projection, f.path, first, undefined, 16 * 1024);
        const seen: string[] = [...ids(page.entries)];
        let pages = 1;
        // Nothing is elided — no body is over the limit — so the durable page and
        // the live page must be the same rows, on every page, not only the first.
        expect(page.window?.elided ?? [], name).toEqual([]);
        expect(ids(page.entries), `${name} first`).toEqual(ids(live(first)!.entries));
        while (page.window?.before) {
          const cursor = page.window.before;
          const liveEarlier = live(earlier(cursor));
          page = await project(service.projection, f.path, earlier(cursor), page.window.revision, 16 * 1024);
          expect(ids(page.entries), `${name} page ${pages + 1}`).toEqual(ids(liveEarlier!.entries));
          expect(page.window?.elided ?? [], name).toEqual([]);
          expect(historyContentSerializedBytes(page.entries, page.window?.context ?? []), name).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_LIMIT);
          seen.unshift(...ids(page.entries));
          pages++;
          expect(pages, name).toBeLessThan(60);
        }
        expect(seen, name).toEqual(ids(entries));
        expect(pages, name).toBeGreaterThan(1);
      }
    } finally {
      f.cleanup();
    }
  });

  it("re-plans a page smaller rather than refusing when its exact form does not fit (M16-T90)", async () => {
    // A row the index prices as elided but that carries an unbounded amount of
    // body metadata with it: a hundred small pictures in one record is M16-T88's
    // own named shape, and its elided identity is larger than the planner's
    // allowance for it. The page is re-planned against served bytes and served;
    // it is never a refusal a person has to read.
    const shots = (index: number, parentId: string | null) => ({
      type: "message", id: `shots${index}`, parentId, timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "toolResult", toolCallId: `c${index}`, content: [
        { type: "text", text: "x".repeat(20 * 1024) },
        ...Array.from({ length: 120 }, () => ({ type: "image", mimeType: "image/png", data: png(64, 64, 3 * 1024) })),
      ] },
    });
    const entries: unknown[] = [];
    let parent: string | null = null;
    for (let turn = 0; turn < 24; turn++) {
      entries.push({ type: "message", id: `u${turn}`, parentId: parent, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `Prompt ${turn}` }] } });
      entries.push(shots(turn, `u${turn}`));
      parent = `shots${turn}`;
    }
    const f = fixture(entries);
    try {
      const { projection } = services();
      let page = await project(projection, f.path, { turns: 10 }, undefined, 16 * 1024);
      const seen: string[] = page.entries.map(row => (row as { id: string }).id);
      const elided: string[] = (page.window?.elided ?? []).map(row => row.id);
      let pages = 1;
      while (page.window?.before) {
        page = await project(projection, f.path, { before: page.window.before, turns: 20 }, page.window.revision, 16 * 1024);
        seen.unshift(...page.entries.map(row => (row as { id: string }).id));
        elided.push(...(page.window?.elided ?? []).map(row => row.id));
        expect(historyContentSerializedBytes(page.entries, page.window?.context ?? [])
          + historyContentSerializedBytes(page.window?.elided ?? [], [])).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_LIMIT);
        pages++;
        expect(pages).toBeLessThan(60);
      }
      // Every row of the conversation is reachable, whole or as identity.
      expect([...seen, ...elided].sort()).toEqual(entries.map(row => (row as { id: string }).id).sort());
    } finally {
      f.cleanup();
    }
  });

  it("pages a conversation the size of the one that failed, in turns and in entries (M16-T90)", async () => {
    // About 27 MB of stored conversation: 200 turns whose tool results carry
    // 128 KB of output each, and the two screenshots that broke it.
    const entries = [...turnEntries(200, 128 * 1024)];
    entries.splice(400, 0,
      screenshot("shot-a", "z99", png(2560, 1440, 2_421_366)),
      screenshot("shot-b", "shot-a", png(2560, 1440, 2_405_990)),
    );
    // Re-link the branch across the inserted rows.
    (entries[402] as { parentId: string }).parentId = "shot-b";
    const f = fixture(entries);
    try {
      const { projection } = services();
      const stored = statSync(f.path).size;
      const walk = async (first: HistoryWindowRequest, earlier: (before: string) => HistoryWindowRequest) => {
        let page = await project(projection, f.path, first, undefined, 16 * 1024);
        const rows: string[] = page.entries.map(row => (row as { id: string }).id);
        const elided: string[] = (page.window?.elided ?? []).map(row => row.id);
        let pages = 1;
        while (page.window?.before) {
          page = await project(projection, f.path, earlier(page.window.before), page.window.revision, 16 * 1024);
          rows.unshift(...page.entries.map(row => (row as { id: string }).id));
          elided.push(...(page.window?.elided ?? []).map(row => row.id));
          pages++;
          expect(pages).toBeLessThan(400);
        }
        return { pages, rows, elided };
      };
      const byTurns = await walk({ turns: 10 }, before => ({ before, turns: 20 }));
      const byEntries = await walk({ tail: 40 }, before => ({ before, limit: 40 }));
      console.info(`M16-T90 ${(stored / 1024 / 1024).toFixed(1)} MB session, ${entries.length} entries: `
        + `${byTurns.pages} pages by turns (10 then 20), ${byEntries.pages} pages by entries (40)`);

      // The live authority serves the same first page of this heavy session,
      // byte for byte: an elided row is priced for what it will really cost.
      const revision = await services().revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const durableFirst = await project(projection, f.path, { turns: 10 }, undefined, 16 * 1024);
      const liveFirst = boundedHistoryWindow({ entries, leafId: "z199" }, { turns: 10 }, {
        sessionId: "session-1", epoch: "live", seq: 3,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", selection: { kind: "replace" },
      }, { limit: 16 * 1024, digest: sha256Hex });
      if (!liveFirst) throw new Error("the live authority refused the first page");
      expect(JSON.stringify(durableFirst.entries)).toBe(JSON.stringify(liveFirst.entries));
      expect(JSON.stringify(durableFirst.window!.elided ?? [])).toBe(JSON.stringify(liveFirst.window.elided ?? []));
      expect(stableWindow(durableFirst.window!)).toEqual(stableWindow(liveFirst.window));
      // Both families reach the root, and neither loses or repeats a row.
      const all = entries.map(row => (row as { id: string }).id);
      expect([...byTurns.rows, ...byTurns.elided].sort()).toEqual([...all].sort());
      expect([...byEntries.rows, ...byEntries.elided].sort()).toEqual([...all].sort());
      expect(byTurns.rows).toEqual(all.filter(id => byTurns.rows.includes(id)));
      expect(byTurns.pages).toBeLessThan(byEntries.pages);
    } finally {
      f.cleanup();
    }
  }, 120_000);

  it("serves the versions of a forked prompt from disk, matching the live authority", async () => {
    const entries = [
      ...messages(12),
      message("fork", "e1", 20),
      message("fork-a", "fork", 21),
    ];
    const f = fixture(entries);
    try {
      const { revisions, projection } = services();
      const durable = await project(projection, f.path, { versionsOf: "e2" });
      const revision = await revisions.read(f.path);
      if (revision.kind !== "answer") throw new Error("missing revision");
      const live = boundedHistoryWindow({ entries, leafId: "fork-a" }, { versionsOf: "e2" }, {
        sessionId: "session-1", epoch: "live", seq: 9,
        revision: revision.result.revision, environmentKey: revision.result.environmentKey,
        authority: "live", selection: { kind: "replace" },
      }, { digest: sha256Hex });
      if (!live) throw new Error("the live authority refused versions");
      expect(durable.entries.map(entry => (entry as { id: string }).id)).toEqual(["e2", "fork"]);
      expect(durable.entries).toEqual(live.entries);
      expect(durable.leafId).toBe(live.leafId);
      expect(stableWindow(durable.window!)).toEqual(stableWindow(live.window));
      expect(durable.window).toMatchObject({
        authority: "durable",
        mode: "replace",
        versions: { total: 2, leaves: [{ id: "e2", leafId: "e11" }, { id: "fork", leafId: "fork-a" }] },
      });
      await expect(projection.read(f.path, { versionsOf: "gone" })).rejects.toMatchObject({
        code: ErrorCodes.InvalidParams,
        message: "That message is not part of this conversation.",
      });
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
