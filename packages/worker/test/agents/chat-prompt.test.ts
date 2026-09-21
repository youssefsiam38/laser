/**
 * M23-T2 · a plain Chat's system prompt, against the real engine and the real
 * request that went out.
 *
 * `docs/plain-chat.md` is exact about this: the whole prompt is
 * `{{availableTools}}\n\n{{toolGuidelines}}\n\n{{availableSkills}}` rendered,
 * and nothing else — no identity paragraph, no product name, no project
 * instructions, no core instructions, no product-guidance skill and none of
 * the D-140 companion additions, which belong to agent runs.
 *
 * The proof is byte-for-byte: the instruction provenance the worker records
 * beside the request says which bytes of the sent prompt came from which
 * field, so the assertion is that the prompt *is* the three rendered fields
 * joined by one blank line, with not one character unaccounted for.
 */
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, type InstructionSourceSpan } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { CHAT_INSTRUCTION_TEMPLATE } from "../../src/agents/instruction-templates.js";
import { chatRecord, chatRole, rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import type { DriverAgentOptions, DriverEvent } from "../../src/driver.js";
import { startStubProvider, systemTextOf, writeStubModels, type StubProvider } from "./stub-provider.js";

let base: string;
let stub: StubProvider;
const drivers: StableSdkDriver[] = [];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-chat-prompt-`));
  mkdirSync(join(base, "workspace"), { recursive: true });
  mkdirSync(join(base, "project"), { recursive: true });
  stub = await startStubProvider(() => ({ text: "ok" }));
  writeStubModels(join(base, "agent"), stub.url);
  // A discovered global skill, so `{{availableSkills}}` is not empty: an empty
  // field would make the joined shape trivially true.
  const skill = join(base, "agent", "skills", "alpha-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: alpha-skill\ndescription: alpha test skill\n---\n\nUse alpha-skill.\n");
});

afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.dispose().catch(() => {});
  await stub.close();
  rmSync(base, { recursive: true, force: true });
});

interface Sent {
  system: string;
  spans: InstructionSourceSpan[];
}

/**
 * The harness bridge a Chat really gets from the worker: it has the harness
 * and background tools like any session (D-144), and it may delegate to
 * nothing, because it runs no definition.
 */
function chatBridge(): NonNullable<DriverAgentOptions["bridge"]> {
  const role = chatRole();
  return {
    role: () => role,
    canDelegate: () => false,
    catalog: () => [],
    onEvent: () => () => {},
    onRoleChange: () => () => {},
  } as unknown as NonNullable<DriverAgentOptions["bridge"]>;
}

async function sendOneTurn(agent: DriverAgentOptions, cwd: string): Promise<Sent> {
  const driver = new StableSdkDriver();
  drivers.push(driver);
  let captured: InstructionSourceSpan[] = [];
  const settled = new Promise<void>((resolve) => driver.subscribe((event: DriverEvent) => {
    if (event.type === "extension" && event.message.type === "lasercode/provider/request") {
      captured = (event.message.context?.instructionSources ?? []).flatMap((map) => map.spans);
    }
    if (event.type === "update" && event.update.kind === "agent_settled") resolve();
  }));
  await driver.open({ cwd, agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), projectTrusted: true, agent });
  await driver.prompt([{ type: "text", text: "hello" }]);
  await settled;
  return { system: systemTextOf(stub.requests[0]!), spans: captured };
}

/**
 * Where each field's bytes begin and end in the sent prompt. A field's own
 * spans are split further inside it — each discovered skill is attributed to
 * its own file — so the region is the first to the last span of that key.
 */
function regions(sent: Sent): Array<{ key: string; start: number; end: number }> {
  const ordered: Array<{ key: string; start: number; end: number }> = [];
  for (const span of [...sent.spans].sort((a, b) => a.start - b.start)) {
    const key = span.source.origin === "variable" ? span.source.fieldKey : undefined;
    if (!key) continue;
    const last = ordered.at(-1);
    if (last?.key === key) last.end = Math.max(last.end, span.end);
    else ordered.push({ key, start: span.start, end: span.end });
  }
  return ordered;
}

describe("a plain chat's system prompt", () => {
  it("is the three rendered fields, joined by one blank line, and nothing else", async () => {
    const sent = await sendOneTurn(
      { role: chatRole(), record: chatRecord(), policy: fallbackPolicy(), bridge: chatBridge() },
      join(base, "workspace"),
    );
    const rendered = regions(sent);
    expect(rendered.map((field) => field.key)).toEqual(["availableTools", "toolGuidelines", "availableSkills"]);
    const [toolsAt, guidanceAt, skillsAt] = rendered as [typeof rendered[0], typeof rendered[0], typeof rendered[0]];
    const tools = sent.system.slice(toolsAt.start, toolsAt.end);
    const guidance = sent.system.slice(guidanceAt.start, guidanceAt.end);
    const skills = sent.system.slice(skillsAt.start, skillsAt.end);
    // Byte-for-byte: the prompt that went to the provider is exactly the three
    // rendered fields with one blank line between them, and every byte of it
    // belongs to one of the three.
    expect(toolsAt.start).toBe(0);
    expect(sent.system.slice(toolsAt.end, guidanceAt.start)).toBe("\n\n");
    expect(sent.system.slice(guidanceAt.end, skillsAt.start)).toBe("\n\n");
    expect(skillsAt.end).toBe(sent.system.length);
    expect(sent.system).toBe(`${tools}\n\n${guidance}\n\n${skills}`);
    // …and the template those fields came from is the contract's own text.
    expect(CHAT_INSTRUCTION_TEMPLATE).toBe("{{availableTools}}\n\n{{toolGuidelines}}\n\n{{availableSkills}}");

    // Each field is the live thing it claims to be.
    expect(tools.startsWith("Available tools:\n- ")).toBe(true);
    expect(guidance.startsWith("Tool guidance:\n- ")).toBe(true);
    expect(skills).toContain("alpha-skill");

    // Nothing else is in there: no persona, no product name, no core block,
    // no delegation reminder, no role or goal block (D-140 applies to agent
    // runs), no project instructions.
    expect(sent.system).not.toMatch(/You are/);
    expect(sent.system).not.toContain(PRODUCT_DISPLAY_NAME);
    expect(sent.system).not.toContain("expert coding agent");
    expect(sent.system).not.toContain("# Your role");
    expect(sent.system).not.toContain("start_agent");
    expect(sent.system).not.toContain("<project_context>");
    // And no byte of the prompt is attributed to an agent definition, a file
    // or a skill root the product added.
    expect(sent.spans.filter((span) => span.source.kind === "unrecorded")).toEqual([]);
    expect(sent.spans.some((span) => span.source.label === "Core instructions")).toBe(false);
    expect(sent.spans.some((span) => span.source.agentName !== undefined)).toBe(false);
  }, 90_000);

  it("keeps a project session's prompt exactly as it was: identity, core block and project instructions", async () => {
    // The counterpart, so the absence above is the chat's own property and not
    // an accident of this harness.
    writeFileSync(join(base, "project", "AGENTS.md"), "Keep the exact project rule.\n");
    const definition = fallbackDefaultAgent();
    const sent = await sendOneTurn(
      { definition, role: rootRole(definition.name), record: rootRecord(definition.name), policy: fallbackPolicy() },
      join(base, "project"),
    );
    expect(sent.system).toContain("expert coding agent");
    expect(sent.system).toContain("Keep the exact project rule.");
    expect(sent.spans.some((span) => span.source.label === "Core instructions")).toBe(true);
  }, 90_000);
});
