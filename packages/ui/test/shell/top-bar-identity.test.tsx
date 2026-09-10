// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionAgentInfo } from "@lasercode/protocol";

import { SessionIdentity, persistedSessionAgent } from "../../src/components/shell/TopBar.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const renderIdentity = async (agentName: string | undefined, model: { provider: string; id: string } | null) => {
  await act(async () => root.render(<SessionIdentity agentName={agentName} model={model} />));
};

const agentLabel = () => container.querySelector<HTMLElement>('[data-slot="session-agent-identity"]');
const modelLabel = () => container.querySelector<HTMLElement>('[data-slot="session-model-identity"]');

describe("the top-bar session identity", () => {
  it("shows the persisted definition beside the model as restrained read-only text", async () => {
    await renderIdentity("long-agent-name-for-responsive-header-ui", { provider: "anthropic", id: "claude-sonnet-with-a-long-version" });

    const agent = agentLabel()!;
    const model = modelLabel()!;
    expect(agent.textContent).toBe("long-agent-name-for-responsive-header-ui");
    expect(agent.getAttribute("aria-label")).toBe("Agent: long-agent-name-for-responsive-header-ui");
    expect(agent.getAttribute("title")).toBe("Agent: long-agent-name-for-responsive-header-ui");
    expect(agent.className).toContain("max-w-20");
    expect(agent.querySelector("span")?.className).toContain("truncate");
    expect(model.textContent).toBe("claude-sonnet-with-a-long-version");
    expect(model.getAttribute("title")).toBe("anthropic/claude-sonnet-with-a-long-version");
    expect(agent.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("button,[role=button],[role=combobox]")).toBeNull();
  });

  it("uses the definition name for a child, not its instance name", async () => {
    const child: SessionAgentInfo = {
      agentName: "reviewer",
      kind: "child",
      subagentName: "reviewer-third-pass",
      parentPath: "/project/root.jsonl",
      rootPath: "/project/root.jsonl",
    };
    const persisted = persistedSessionAgent({ state: { agent: child } }, undefined);
    await renderIdentity(persisted?.agentName, null);
    expect(agentLabel()?.textContent).toBe("reviewer");
    expect(agentLabel()?.textContent).not.toContain("reviewer-third-pass");
  });

  it("prefers the open session record, falls back to its catalog record, and invents nothing", () => {
    const open: SessionAgentInfo = { agentName: "writer", kind: "root" };
    const catalog: SessionAgentInfo = { agentName: "reviewer", kind: "root" };
    expect(persistedSessionAgent({ state: { agent: open } }, { agent: catalog })).toBe(open);
    expect(persistedSessionAgent({ state: {} }, { agent: catalog })).toBe(catalog);
    expect(persistedSessionAgent({ state: {} }, {})).toBeUndefined();
  });

  it("keeps built-in identities visible and does not invent an agent for unattributed history", async () => {
    await renderIdentity("beam", { provider: "openai", id: "gpt-5" });
    expect(agentLabel()?.textContent).toBe("Beam");

    await renderIdentity("chat", { provider: "openai", id: "gpt-5" });
    expect(agentLabel()?.textContent).toBe("Chat");

    await renderIdentity(undefined, { provider: "openai", id: "gpt-5" });
    expect(agentLabel()).toBeNull();
    expect(modelLabel()?.textContent).toBe("gpt-5");
  });

  it("survives state rerenders and changes only when the selected session attribution changes", async () => {
    await renderIdentity("reviewer", { provider: "anthropic", id: "claude-sonnet" });
    expect(agentLabel()?.textContent).toBe("reviewer");

    // Prompt persistence, streaming and settling rerender this header without
    // changing its canonical attribution.
    await renderIdentity("reviewer", { provider: "anthropic", id: "claude-sonnet" });
    expect(agentLabel()?.textContent).toBe("reviewer");

    // Switching sessions replaces the label from that session's own record.
    await renderIdentity("writer", { provider: "openai", id: "gpt-5" });
    expect(agentLabel()?.textContent).toBe("writer");
    expect(modelLabel()?.textContent).toBe("gpt-5");
  });
});
