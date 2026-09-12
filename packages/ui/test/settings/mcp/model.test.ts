import { describe, expect, it } from "vitest";
import { MCP_KNOWN_SERVERS, type McpServerConfig } from "@lasercode/protocol";

import {
  allToolsOff,
  buildArgs,
  catalogForm,
  configToForm,
  defaultCatalogOptions,
  deriveName,
  formIssues,
  formToConfig,
  initialArgValues,
  keepsStoredSecret,
  policyPatternLocks,
  nameIssue,
  parseCommandLine,
  schemaFields,
  schemaToShape,
  scopeNote,
  setToolApproved,
  setToolEnabled,
  statusWords,
  toolState,
  toolCountLabel,
  toolVisibilityNote,
  transportSummary,
} from "../../../src/components/settings/mcp/model.js";

describe("the words a row says", () => {
  it("renders every protocol status for a person", () => {
    expect(statusWords("connected").label).toBe("Connected");
    expect(statusWords("ready").label).toBe("Ready");
    expect(statusWords("starting").working).toBe(true);
    expect(statusWords("needs-auth").label).toBe("Needs sign-in");
    expect(statusWords("failed").tone).toBe("danger");
    expect(statusWords("off").label).toBe("Off");
    expect(statusWords("unknown").label).toBe("Not seen yet");
  });

  it("summarises each transport the way the design asks", () => {
    expect(transportSummary({ kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] })).toMatchObject({
      text: "npx @playwright/mcp",
      kind: "Command",
      full: "npx -y @playwright/mcp@latest",
    });
    expect(transportSummary({ kind: "http", url: "https://mcp.context7.com/mcp" })).toMatchObject({ text: "mcp.context7.com", kind: "HTTP" });
    expect(transportSummary({ kind: "socket", path: "/run/user/1000/memory.sock" })).toMatchObject({ text: "…/memory.sock", kind: "Socket" });
  });

  it("counts tools with the direct share, and explains a shadowed entry", () => {
    expect(toolCountLabel({ toolCount: 24, directToolCount: 24 })).toBe("24 tools · 24 direct");
    expect(toolCountLabel({ toolCount: 1, directToolCount: 0 })).toBe("1 tool · 0 direct");
    expect(toolCountLabel({})).toBeUndefined();
    expect(scopeNote({ scope: "global", config: { name: "a", transport: { kind: "socket", path: "/a" } }, status: "off", shadowed: true })).toContain(
      "not what it uses here",
    );
    expect(
      scopeNote({ scope: "project", config: { name: "a", transport: { kind: "socket", path: "/a" } }, status: "off", overridesGlobal: true }),
    ).toContain("switches the every-project server");
  });
});

describe("names and command lines", () => {
  it("derives a name from a label and refuses what the protocol refuses", () => {
    expect(deriveName("Playwright browser")).toBe("playwright-browser");
    expect(deriveName("  My Server!!  ")).toBe("my-server");
    expect(nameIssue("playwright_2")).toBeUndefined();
    expect(nameIssue("with space")).toContain("letters, digits");
    expect(nameIssue("_leading")).toContain("Start with a letter or a digit");
    expect(nameIssue("")).toContain("Give the server a name");
    expect(nameIssue("x".repeat(65))).toContain("64");
  });

  it("parses a pasted command line, quotes and all", () => {
    expect(parseCommandLine("npx -y @playwright/mcp@latest")).toEqual({ command: "npx", args: ["-y", "@playwright/mcp@latest"] });
    expect(parseCommandLine('node "/a path/server.js" --port 3000')).toEqual({
      command: "node",
      args: ["/a path/server.js", "--port", "3000"],
    });
    expect(parseCommandLine("   ")).toEqual({ command: "", args: [] });
  });
});


describe("the input schema, compactly", () => {
  it("writes an object schema as a shape with enums and defaults", () => {
    expect(
      schemaToShape({
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string" },
          fullPage: { type: "boolean" },
          mode: { enum: ["light", "dark"], default: "light" },
          tags: { type: "array", items: { type: "string" } },
        },
      }),
    ).toBe('{ url: string; fullPage?: boolean; mode?: "light" | "dark" = "light"; tags?: string[] }');
    expect(schemaToShape({ type: "string" })).toBeUndefined();
  });

  it("turns the properties it can type into fields and everything else into JSON", () => {
    const fields = schemaFields({
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Where to go" },
        count: { type: "integer", default: 2 },
        fullPage: { type: "boolean" },
        mode: { enum: ["light", "dark"] },
        tags: { type: "array", items: { type: "string" } },
        filter: { type: "object" },
      },
    });
    expect(fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["url", "string", true],
      ["count", "number", false],
      ["fullPage", "boolean", false],
      ["mode", "enum", false],
      ["tags", "string-list", false],
      ["filter", "json", false],
    ]);
    const values = { ...initialArgValues(fields), url: "https://example.com", count: "3", fullPage: true, tags: "a\nb", filter: '{"x":1}' };
    expect(buildArgs(fields, values)).toEqual({
      args: { url: "https://example.com", count: 3, fullPage: true, tags: ["a", "b"], filter: { x: 1 } },
    });
    expect(buildArgs(fields, { ...initialArgValues(fields), count: "no" })).toEqual({ error: "url is required." });
    expect(buildArgs(fields, { ...initialArgValues(fields), url: "u", count: "no" })).toEqual({ error: "count has to be a number." });
  });
});

describe("tool policy arithmetic", () => {
  const tools = ["navigate", "click", "screenshot"];

  it("maintains exclude and approve as lists of original names", () => {
    let policy = setToolEnabled({ alwaysLoad: false }, "click", false);
    expect(policy.exclude).toEqual(["click"]);
    policy = setToolEnabled(policy, "click", true);
    expect(policy.exclude).toBeUndefined();


    policy = setToolApproved({ alwaysLoad: false }, "screenshot", true);
    expect(policy.approve).toEqual(["screenshot"]);
    expect(setToolApproved({ alwaysLoad: false, approve: true }, "screenshot", false).approve).toBe(true);
  });

  it("bulk actions clear or fill the whole list", () => {
    expect(allToolsOff({ alwaysLoad: false }, tools).exclude).toEqual(["click", "navigate", "screenshot"]);
  });

  it("takes each tool's state from the worker's effective answer, not from a second reading", () => {
    expect(toolState({ visibility: "direct", approval: false })).toEqual({ enabled: true, ask: false });
    expect(toolState({ visibility: "on-demand", approval: true })).toEqual({ enabled: true, ask: true });
    expect(toolState({ visibility: "excluded", approval: false })).toEqual({ enabled: false, ask: false });
    expect(toolVisibilityNote({ visibility: "direct" })).toBeUndefined();
    expect(toolVisibilityNote({ visibility: "excluded" })).toContain("Switched off");
    expect(toolVisibilityNote({ visibility: "on-demand" })).toContain("on demand");
  });


  it("locks the switches a pattern owns", () => {
    expect(policyPatternLocks({ alwaysLoad: false })).toMatchObject({ enabled: false, ask: false, any: false });
    expect(policyPatternLocks({ alwaysLoad: false, exclude: ["browser_*"] })).toMatchObject({ enabled: true, any: true });
    expect(policyPatternLocks({ alwaysLoad: false, include: ["navigate"] })).toMatchObject({ enabled: true, any: true });
    expect(policyPatternLocks({ alwaysLoad: false, approve: true })).toMatchObject({ ask: true });
  });
});

describe("the form", () => {
  it("composes the gallery definition with the options a person chose", () => {
    const playwright = MCP_KNOWN_SERVERS.find((entry) => entry.id === "playwright")!;
    const chosen = defaultCatalogOptions(playwright);
    expect([...chosen]).toEqual(["browser:isolated"]);
    const config = formToConfig(catalogForm(playwright, chosen));
    expect(config).toMatchObject({
      name: "playwright",
      label: "Playwright",
      catalogId: "playwright",
      transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--isolated"] },
      tools: { alwaysLoad: false },
    });
  });

  it("composes exclusive browser args and ignores headless outside the isolated choice", () => {
    const entry = MCP_KNOWN_SERVERS.find((candidate) => candidate.id === "playwright")!;
    for (const [mode, expected] of [["isolated", ["--isolated", "--headless"]], ["extension", ["--extension"]], ["cdp", ["--cdp-endpoint=chrome"]]] as const) {
      const form = catalogForm(entry, new Set([`browser:${mode}`, "headless"]));
      expect(parseCommandLine(form.commandLine).args).toEqual(["-y", "@playwright/mcp@latest", ...expected]);
    }
    const saved: McpServerConfig = { name: "custom-browser", catalogId: "playwright", transport: { kind: "stdio", command: "npx", args: ["@playwright/mcp", "--user-data-dir=/custom"] } };
    expect(formToConfig(configToForm(saved)).transport).toEqual(saved.transport);
  });

  it("keeps a stored secret as a reference and sends a typed one as a value", () => {
    const saved: McpServerConfig = {
      name: "docs",
      transport: { kind: "http", url: "https://example.com/mcp", headers: { "X-Key": { secret: true, present: true } } },
      auth: { kind: "bearer", token: { secret: true, present: true } },
    };
    const untouched = formToConfig(configToForm(saved));
    expect(untouched.transport).toMatchObject({ headers: { "X-Key": { secret: true } } });
    expect(untouched.auth).toEqual({ kind: "bearer", token: { secret: true } });

    const form = configToForm(saved);
    form.token = { value: "new-token", stored: true };
    form.headers = form.headers.map((row) => ({ ...row, value: "typed" }));
    const replaced = formToConfig(form);
    expect(replaced.auth).toEqual({ kind: "bearer", token: { secret: true, value: "new-token" } });
    expect(replaced.transport).toMatchObject({ headers: { "X-Key": { secret: true, value: "typed" } } });
  });

  it("keeps a saved secret when the row is un-marked, and refuses an empty token", () => {
    const saved: McpServerConfig = {
      name: "docs",
      transport: { kind: "http", url: "https://example.com/mcp", headers: { "X-Key": { secret: true, present: true } } },
      auth: { kind: "bearer", token: { secret: true, present: true } },
    };
    // Un-marking is how you look at a field, not how you delete what is in it.
    const form = configToForm(saved);
    form.headers = form.headers.map((row) => ({ ...row, secret: false }));
    expect(keepsStoredSecret(form.headers[0]!)).toBe(true);
    expect(formToConfig(form).transport).toMatchObject({ headers: { "X-Key": { secret: true } } });
    form.headers = form.headers.map((row) => ({ ...row, value: "plain" }));
    expect(formToConfig(form).transport).toMatchObject({ headers: { "X-Key": "plain" } });

    const empty = configToForm({ name: "docs", transport: { kind: "http", url: "https://example.com/mcp" } } as McpServerConfig);
    empty.authKind = "bearer";
    expect(formIssues(empty).token).toContain("Enter the token");
    expect(formIssues(configToForm(saved)).token).toBeUndefined();
  });

  it("refuses an empty command, a bare host and a nameless server", () => {
    const form = configToForm({ name: "", transport: { kind: "stdio", command: "" } } as McpServerConfig);
    expect(formIssues(form).name).toBeDefined();
    expect(formIssues(form).commandLine).toBeDefined();
    const http = configToForm({ name: "ok", transport: { kind: "http", url: "example.com" } } as McpServerConfig);
    expect(formIssues(http).url).toContain("http://");
  });
});

describe("result content", () => {
  it("turns an image or audio block into something the browser can show", async () => {
    const { contentDataUri } = await import("../../../src/components/settings/mcp/model.js");
    expect(contentDataUri({ data: "aGk=", mimeType: "image/png" })).toBe("data:image/png;base64,aGk=");
  });
});
