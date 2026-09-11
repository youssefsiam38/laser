// Shared fixtures and DOM helpers for the MCP settings tests. Not a test file.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect } from "vitest";
import type { McpInspection, McpServerState, McpToolInfo } from "@lasercode/protocol";

export function serverState(partial: Partial<McpServerState> & Pick<McpServerState, "config">): McpServerState {
  return { scope: "global", status: "unknown", ...partial };
}

export function tool(name: string, partial: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    name: `playwright_${name}`,
    originalName: name,
    description: `${name} something`,
    visibility: "direct",
    approval: false,
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" }, fullPage: { type: "boolean" } } },
    ...partial,
  };
}

export function inspection(partial: Partial<McpInspection> & Pick<McpInspection, "name">): McpInspection {
  return {
    scope: "global",
    status: "connected",
    server: { name: "Playwright", version: "1.2.3" },
    protocolVersion: "2026-07-28",
    capabilities: { tools: true, resources: false, prompts: false, logging: false, toolListChanged: true },
    tools: [],
    resources: [],
    prompts: [],
    latencyMs: 42,
    ...partial,
  };
}

export function manyTools(count: number): McpToolInfo[] {
  return Array.from({ length: count }, (_, index) => tool(`tool_${index}`));
}

/** Everything rendered, including whatever Radix put in a portal. */
export function text(): string {
  return document.body.textContent ?? "";
}

export function buttons(root: ParentNode = document.body): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("button")];
}

export function findButton(label: string, root: ParentNode = document.body): HTMLButtonElement | undefined {
  return buttons(root).find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
}

export async function click(label: string, root: ParentNode = document.body): Promise<void> {
  const button = findButton(label, root);
  expect(button, `button: ${label}`).toBeDefined();
  await act(async () => button!.click());
}

export async function clickElement(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

export function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const byAria = document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (byAria) return byAria;
  const labels = [...document.body.querySelectorAll("label")];
  const match = labels.find((entry) => entry.textContent?.trim().startsWith(label));
  expect(match, `label: ${label}`).toBeDefined();
  const target = match!.getAttribute("for")
    ? document.getElementById(match!.getAttribute("for")!)
    : match!.querySelector("input, textarea, select");
  expect(target, `control for: ${label}`).toBeTruthy();
  return target as HTMLInputElement;
}

export async function type(label: string, value: string): Promise<void> {
  const control = field(label);
  await act(async () => {
    setValue(control, value);
  });
}

export async function choose(label: string, value: string): Promise<void> {
  const control = field(label) as HTMLSelectElement;
  await act(async () => {
    control.value = value;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function render(node: React.ReactNode): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { root, container };
}
