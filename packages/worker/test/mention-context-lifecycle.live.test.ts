/**
 * A mention's projection through the events that move a turn (M21-T9/T17).
 *
 * `mention-context.live.test.ts` proves the identity: three byte-identical
 * messages, each with its own context, against the real engine. This file
 * proves the two lifecycle claims D-362 was accepted on, which nothing
 * synthetic can prove, plus the ownership of a reserved slot:
 *
 *   1. **An in-activity compaction.** The engine summarises the conversation
 *      *inside* the turn that is reading the message, and the message can
 *      leave the window it was sent in. The projection belongs to that turn,
 *      so it is still in front of the model afterwards — labelled for what it
 *      is, never re-attached to whatever message compaction left behind — and
 *      it is gone once the turn finally settles.
 *   2. **A fallback retry.** A provider dies mid-turn, the chain moves the
 *      same turn to the next model, and the retry must carry the same context:
 *      the settle that the fallback holds is not the settle that retires it.
 *   3. **A slot is owed to the message that was actually sent.** A send the
 *      engine was never asked to take — refused at the ceiling, refused at the
 *      preflight fence, thrown out by the caller's own invocation observer —
 *      gives its slot back, or sixteen refusals would close the door on the
 *      next real message.
 *
 * Everything here runs the real driver, the real pinned engine and stub
 * providers over loopback. No private engine field is read and no production
 * code is reshaped for the test: the seams are `driver.open`, `driver.prompt`,
 * `driver.steer`, the session's own updates, and what the provider received.
 */
import { PRODUCT_NAME, type ProjectWorkMentionProjection, type SessionUpdate } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { SessionMentionContext } from "../src/project-work/mentions.js";
import type { DriverEvent } from "../src/driver.js";
import { startStubProvider, type StubAnswer, type StubProvider, type StubRequest } from "./agents/stub-provider.js";

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
      ...(overrides.ref ?? {}),
    },
    key,
    kind: KIND_OF[key.split("-")[0]!]!,
    title: `${key} title`,
    state: "in_progress",
    provenance: `[from Acme ${key}@3]`,
    fields: [{ label: "Outcome", value: `${key} outcome line` }],
    excerpt: `${key} excerpt body`,
    ...overrides,
  };
}

type Which = "a" | "b";

const MODEL: Record<Which, { provider: string; id: string }> = {
  a: { provider: "stub", id: "stub-1" },
  b: { provider: "stub-b", id: "stub-b-1" },
};

const ok = (text: string): StubAnswer => ({ text });
const down = (): StubAnswer => ({ status: 500, body: { error: { message: "Internal server error" } } });
/** An answer whose reported usage nearly fills the model's window. */
const fat = (text: string): StubAnswer => ({
  text,
  usage: { prompt_tokens: 9_000, completion_tokens: 50, total_tokens: 9_050 },
});

let base: string;
let project: string;
let agentDir: string;
let sessionDir: string;
let driver: StableSdkDriver;
let mentions: SessionMentionContext;
let stubs: Record<Which, StubProvider>;
let script: Record<Which, (request: StubRequest, index: number) => StubAnswer>;
let updates: SessionUpdate[];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

function sessionFiles(): string {
  const walk = (at: string): string[] =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(at, entry.name)) : [join(at, entry.name)],
    );
  return walk(sessionDir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

/** The engine's configuration for one test: a chain, windows, compaction. */
function writeConfig(options: {
  chain?: Array<{ provider: string; id: string }>;
  windows?: Partial<Record<Which, number>>;
  compaction?: Record<string, unknown>;
} = {}): void {
  mkdirSync(agentDir, { recursive: true });
  const windowOf = (which: Which) => options.windows?.[which] ?? 8_000;
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: stubs.a.url,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "stub-1", name: "Stub A", contextWindow: windowOf("a"), maxTokens: 1_000 }],
        },
        "stub-b": {
          baseUrl: stubs.b.url,
          api: "openai-completions",
          apiKey: "k",
          models: [{ id: "stub-b-1", name: "Stub B", contextWindow: windowOf("b"), maxTokens: 1_000 }],
        },
      },
    }),
  );
  const chain = options.chain ?? [MODEL.a];
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: MODEL.a.provider,
      defaultModel: MODEL.a.id,
      // The engine's own retry loop, kept to milliseconds.
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 },
      ...(options.compaction ? { compaction: options.compaction } : {}),
      modelProfiles: [
        { id: "mp_mentionchain0000000000", name: "Balanced", models: chain, origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      defaultProfileId: "mp_mentionchain0000000000",
    }),
  );
}

async function open(): Promise<void> {
  driver = new StableSdkDriver();
  updates = [];
  driver.subscribe((event: DriverEvent) => {
    if (event.type === "update") updates.push(event.update);
  });
  await driver.open({ cwd: project, agentDir, sessionDir, projectTrusted: true, mentionContext: mentions });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-mention-life-`));
  project = join(base, "project");
  agentDir = join(base, "agent");
  sessionDir = join(base, "sessions");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  script = { a: () => ok("from a"), b: () => ok("from b") };
  const started = await Promise.all(
    (["a", "b"] as Which[]).map(
      async (which) => [which, await startStubProvider((request, index) => script[which](request, index))] as const,
    ),
  );
  stubs = Object.fromEntries(started) as Record<Which, StubProvider>;
  mentions = new SessionMentionContext();
  writeConfig();
});

afterEach(async () => {
  await driver?.dispose().catch(() => {});
  await Promise.all(Object.values(stubs).map((stub) => stub.close()));
  rmSync(base, { recursive: true, force: true });
});

/** Every message of one captured request, as role plus flattened text. */
function rows(request: StubRequest): Array<{ role: string; text: string }> {
  return request.messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") return { role: message.role, text: content };
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
      .map((block) => block.text)
      .join("");
    return { role: message.role, text };
  });
}

const bodyOf = (request: StubRequest) => JSON.stringify(request.messages);

describe("a mention's projection across the events that move a turn", () => {
  it("keeps the turn's context across an in-activity compaction, and only until that turn settles", async () => {
    // A window the reported usage crosses, and a recent-token budget small
    // enough that the cut lands *inside* the turn being read: the engine
    // summarises the person's own message away while the turn that has to
    // answer it is still running. Nothing here reads engine internals — the
    // settings are the engine's own, and the trigger is the usage a provider
    // reports.
    writeConfig({ windows: { a: 8_000 }, compaction: { enabled: true, keepRecentTokens: 60, reserveTokens: 0 } });
    // Request 0 answers an earlier turn, so there is history to summarise.
    // Request 1 answers the message that mentions, at length and with a usage
    // that crosses the threshold. The summary request takes its time, which is
    // the window in which the person sends the next message — that message is
    // what makes the engine call the model again *after* the compaction,
    // inside the same activity.
    script.a = (request, index) => {
      if (JSON.stringify(request.messages).includes("<conversation>")) return { text: "a summary", delayMs: 300 };
      return index === 1 ? fat(`working on it: ${"detail ".repeat(600)}`) : ok("carrying on");
    };
    await open();

    await driver.prompt([{ type: "text", text: "some earlier work in this conversation" }]);
    const words = "please look at the linked work";
    const turn = driver.prompt([{ type: "text", text: words }], {
      projectWork: [projection("TASK-44", { excerpt: "the picker excerpt" })],
    });
    // The person writes again while the engine is compacting: their message
    // waits in the engine's own queue and is read in the same activity, after
    // the summary replaced the history.
    await waitFor(() => updates.some((update) => update.kind === "compaction_start"), "the compaction to start");
    await driver.followUp([{ type: "text", text: "and this one as well" }], {
      projectWork: [projection("SPEC-7", { excerpt: "the composer excerpt" })],
    });
    await turn;
    await wait(100);

    // The compaction really happened, inside the activity.
    expect(updates.some((update) => update.kind === "compaction_start")).toBe(true);
    expect(updates.some((update) => update.kind === "compaction_end" && update.ok)).toBe(true);
    // ...and the turn went on to call the model again after it.
    // The engine's own summarisation calls are not the conversation: they are
    // a separate request with the conversation quoted inside one prompt, and
    // they carry no mention context (nothing is owed to a summary).
    const isSummary = (request: StubRequest) => bodyOf(request).includes("<conversation>");
    const summarised = stubs.a.requests.findIndex(isSummary);
    expect(summarised, "the summary request is in the captures").toBeGreaterThanOrEqual(0);
    for (const request of stubs.a.requests.filter(isSummary)) {
      expect(bodyOf(request)).not.toContain("[from Acme TASK-44@3]");
    }
    const continued = stubs.a.requests.filter((request, at) => at > summarised && !isSummary(request));
    expect(continued.length, "the turn called the model again after the compaction").toBeGreaterThan(0);
    // The message that mentioned is really gone from what the model reads:
    // this is the case nothing synthetic can produce, and the one the
    // labelling exists for.
    expect(
      continued.every((request) => !rows(request).some((row) => row.role === "user" && row.text.includes(words))),
      "the compaction took the person's own message out of the window",
    ).toBe(true);

    // Every call this turn made after the compaction still shows the model
    // what each message it is answering mentioned — the compacted-away one at
    // the end and labelled, the one still in the window beside itself.
    for (const request of continued) {
      const sent = rows(request);
      const orphan = sent.findIndex((row) => row.text.includes("[from Acme TASK-44@3]"));
      expect(orphan, "the compacted message's context is still in front of the model").toBeGreaterThanOrEqual(0);
      expect(sent[orphan]!.text).toContain("the picker excerpt");
      expect(sent[orphan]!.text, "labelled, never re-attached to another message").toContain("no longer in the window");
      expect(orphan, "at the end of the list").toBe(sent.length - 1);

      const owner = sent.findIndex((row) => row.role === "user" && row.text.includes("and this one as well"));
      expect(owner, "the queued message the model is now reading").toBeGreaterThanOrEqual(0);
      expect(sent[owner + 1]?.text).toContain("[from Acme SPEC-7@3]");
      expect(sent[owner + 1]?.text).toContain("mentioned in the message above");
    }

    // The activity is over, so nothing is owed any more: not to the next
    // message, and not to the compaction summary the engine now carries.
    expect(mentions.held()).toEqual([]);
    const before = stubs.a.requests.length;
    await driver.prompt([{ type: "text", text: "something else entirely" }]);
    for (const request of stubs.a.requests.slice(before)) {
      expect(bodyOf(request)).not.toContain("TASK-44");
      expect(bodyOf(request)).not.toContain("the picker excerpt");
      expect(bodyOf(request)).not.toContain("SPEC-7");
    }
    // And no part of any of it was ever written to the conversation.
    expect(sessionFiles()).toContain(words);
    expect(sessionFiles()).not.toContain("the picker excerpt");
    expect(sessionFiles()).not.toContain("[from Acme TASK-44@3]");
    expect(sessionFiles()).not.toContain("correlationId");
  }, 60_000);

  it("carries the same context onto the model a fallback retries the turn on", async () => {
    writeConfig({ chain: [MODEL.a, MODEL.b] });
    // The first model dies for this turn; the chain moves the same turn to the
    // second one, which answers it.
    script.a = () => down();
    script.b = () => ok("finished on b");
    await open();

    await driver.prompt([{ type: "text", text: "read the linked work" }], {
      projectWork: [projection("SPEC-7", { excerpt: "the composer excerpt" })],
    });
    await wait(50);

    // The turn really moved, and it moved once.
    const moves = updates.filter((update) => update.kind === "model_fallback");
    expect(moves.map((move) => move.phase)).toEqual(["switching", "switched"]);
    expect(driver.state().model?.id).toBe("stub-b-1");
    // The retry on the new model carries the projection, beside the very same
    // message: a held settle is not the settle that retires it.
    expect(stubs.b.requests.length).toBeGreaterThanOrEqual(1);
    for (const request of stubs.b.requests) {
      const sent = rows(request);
      const owner = sent.findIndex((row) => row.role === "user" && row.text.includes("read the linked work"));
      expect(owner, "the message is still the one being answered").toBeGreaterThanOrEqual(0);
      expect(sent[owner + 1]?.text).toContain("[from Acme SPEC-7@3]");
      expect(sent[owner + 1]?.text).toContain("the composer excerpt");
    }
    // The model that failed was asked before the switch and carried it too,
    // and neither provider was told anything about the routing.
    expect(bodyOf(stubs.b.requests.at(-1)!)).not.toContain("correlationId");
    expect(bodyOf(stubs.b.requests.at(-1)!)).not.toContain("lmc-");

    // Retired at the settle of the turn that finally answered, not at the one
    // the fallback held.
    expect(mentions.held()).toEqual([]);
    const before = stubs.b.requests.length;
    await driver.prompt([{ type: "text", text: "and now something unrelated" }]);
    for (const request of stubs.b.requests.slice(before)) expect(bodyOf(request)).not.toContain("SPEC-7");
    expect(sessionFiles()).not.toContain("the composer excerpt");
  }, 60_000);

  it("refuses a seventeenth mentioning message before the engine is asked anything", async () => {
    await open();
    // Sixteen messages already waiting with context, as the ceiling allows.
    for (let at = 0; at < 16; at += 1) {
      mentions.admitted(mentions.reserve([projection(`TASK-${String(at + 1)}`)]), "followUp");
    }
    expect(stubs.a.requests).toHaveLength(0);

    await expect(
      driver.prompt([{ type: "text", text: "one too many" }], { projectWork: [projection("TASK-99")] }),
    ).rejects.toThrow(/clear the queue/);
    await expect(
      driver.steer([{ type: "text", text: "one too many, steered" }], { projectWork: [projection("TASK-99")] }),
    ).rejects.toThrow(/clear the queue/);

    // Nothing reached the engine: no model call, and no message on disk.
    expect(stubs.a.requests, "the engine was never asked").toHaveLength(0);
    expect(sessionFiles()).not.toContain("one too many");
    // And the refusal cost the session nothing it was holding.
    expect(mentions.held()).toHaveLength(16);

    // A message that mentions nothing is never refused and holds no slot, so
    // it can never be the reason the next mentioning message is turned away.
    await driver.prompt([{ type: "text", text: "nothing mentioned here" }]);
    expect(bodyOf(stubs.a.requests.at(-1)!)).toContain("nothing mentioned here");
    expect(mentions.held()).toHaveLength(16);
  }, 60_000);

  it("gives the slot back when a concurrent prompt is refused at the preflight fence", async () => {
    script.a = () => ({ text: "ok", delayMs: 150 });
    await open();

    // Sent in the same tick: the first prompt has installed its preflight
    // fence and has not reached the engine yet, so the second is refused
    // there — the one exit from `prompt()` that returns before the engine is
    // ever asked and outside its own cleanup.
    const first = driver.prompt([{ type: "text", text: "the first message" }], {
      projectWork: [projection("TASK-44")],
    });
    const refused = await driver.prompt([{ type: "text", text: "the second message" }], {
      projectWork: [projection("SPEC-7")],
    });

    expect(refused).toEqual({ accepted: false, queued: false });
    expect(stubs.a.requests, "refused at the fence, before even the first message was sent").toHaveLength(0);
    expect(mentions.held(), "only the message that was actually sent holds a slot").toHaveLength(1);

    await first;
    await wait(50);
    // The sent message's context retired with its turn; the refused message
    // left nothing behind at all.
    expect(mentions.held()).toEqual([]);
    const sent = JSON.stringify(stubs.a.requests);
    expect(sent).toContain("[from Acme TASK-44@3]");
    expect(sent).not.toContain("the second message");
    expect(sent).not.toContain("SPEC-7");
  }, 60_000);

  it("gives the slot back when the caller's own invocation observer throws", async () => {
    await open();

    await expect(
      driver.prompt([{ type: "text", text: "observed badly" }], {
        projectWork: [projection("TASK-44")],
        onInvocation: () => {
          throw new Error("the observer failed");
        },
      }),
    ).rejects.toThrow("the observer failed");

    expect(stubs.a.requests, "the engine was never asked").toHaveLength(0);
    expect(mentions.held()).toEqual([]);

    // The next message goes through normally: the failed send released the
    // fence it had installed as well as the slot it had taken.
    await driver.prompt([{ type: "text", text: "after the failure" }], { projectWork: [projection("SPEC-7")] });
    const sent = JSON.stringify(stubs.a.requests);
    expect(sent).toContain("after the failure");
    expect(sent).toContain("[from Acme SPEC-7@3]");
    expect(sent).not.toContain("observed badly");
    expect(mentions.held()).toEqual([]);
  }, 60_000);
});
