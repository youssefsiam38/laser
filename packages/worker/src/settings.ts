/**
 * Settings adapter — Laser's curated settings, translated to the pinned engine.
 *
 * Global engine state stays inside Laser's private agent directory. Project
 * choices belong to Laser and live in `<cwd>/.laser/settings.json`; the engine's
 * `<cwd>/.pi` directory is never read or written by this adapter.
 *
 * ## Why writes do not go through the typed setters
 *
 * `SettingsManager` exposes ~122 typed accessors, but they cover only part of
 * the surface: there is no setter for `sessionDir`, `httpProxy`, `defaultTools`,
 * `thinkingBudgets`, `branchSummary.*`, `retry.maxRetries`, `retry.provider.*`,
 * `markdown.codeBlockIndent`, `terminal.hyperlinks|images|trueColor`,
 * `externalEditor` or `websocketConnectTimeoutMs`, and every setter except the
 * five resource-list ones writes the *global* file only. A settings screen that
 * covers all 51 top-level keys at both scopes cannot be built on them.
 *
 * So this adapter borrows the manager's own `SettingsStorage` — the object
 * behind `SettingsManager.create()`, whose `withLock(scope, fn)` is a public
 * interface in Pi's types — and does a read-modify-write of just the paths the
 * caller named, under Pi's real lock, then calls `reload()`. That is exactly
 * what Pi's own `persistScopedSettings` does, minus the typed sugar. It reaches
 * one private property name (`storage`); if a future Pi renames it, the adapter
 * fails loudly with an actionable message instead of silently not saving
 * (see `piSettingsStorage`). Bumping the Pi pin is MX-T2 and must re-check it.
 *
 * Concurrency: laser is the only writer in this process, Pi's lock covers
 * other processes, and every write is a merge over current file content, so an
 * interleaved write by a terminal Pi loses nothing but the racing field.
 */

import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import {
  SettingsManager,
  VERSION,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
  SettingChange,
  SettingDescriptor,
  SettingsCatalog,
  SettingsFileState,
  SettingsProjectTrust,
  SettingsScope,
  SettingsSection,
  SettingsSnapshot,
} from "@lasercode/protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyDurableOverrides } from "./settings-overrides.js";

export const LASER_PROJECT_DIR_NAME = PROJECT_DIR_NAME;

// ---------------------------------------------------------------- catalogue

const THINKING_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
  value,
  label: value,
}));

/**
 * Every top-level key of Pi 0.85.0's `Settings` interface, in declaration
 * order. `test/settings.test.ts` asserts the catalogue below covers each
 * one, so a Pi upgrade that adds a key fails the test instead of shipping a
 * settings screen with a hole in it.
 *
 * (Pi's own `docs/settings.md` documents 50 of these: `lastChangelogVersion`
 * is written by Pi and not documented. `docs/research/findings.md` says "52";
 * the interface has 51.)
 */
export const PI_SETTINGS_TOP_LEVEL_KEYS: readonly string[] = [
  "lastChangelogVersion",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "modelThinkingLevels",
  "transport",
  "steeringMode",
  "followUpMode",
  "theme",
  "compaction",
  "branchSummary",
  "retry",
  "hideThinkingBlock",
  "showCacheMissNotices",
  "externalEditor",
  "shellPath",
  "quietStartup",
  "defaultProjectTrust",
  "shellCommandPrefix",
  "npmCommand",
  "collapseChangelog",
  "enableInstallTelemetry",
  "enableAnalytics",
  "trackingId",
  "packages",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "enableSkillCommands",
  "terminal",
  "images",
  "enabledModels",
  "defaultTools",
  "doubleEscapeAction",
  "treeFilterMode",
  "thinkingBudgets",
  "editorPaddingX",
  "outputPad",
  "autocompleteMaxVisible",
  "showHardwareCursor",
  "markdown",
  "warnings",
  "sessionDir",
  "httpProxy",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
  "tuiMode",
  "fullscreenExitOutput",
  "fullscreenScrollbar",
  "fullscreenCopyOnSelect",
];

/**
 * Keys the product defines for itself (AGENTS.md 6b). They live beside the
 * engine's keys in both settings files, are read and written only by the
 * product, and never cross into the engine as overrides.
 *
 * `disabledModels` is the off side of the model switches in Providers and
 * models (M13-T49). The engine's `enabledModels` is a pure allow-list with no
 * negation, so "everything except this one" cannot be written as a pattern
 * without enumerating every other model — and an enumerated list silently
 * hides every model added later. The disable list holds exact `provider/id`
 * references instead; a model it does not name stays offered.
 */
export const LASER_SETTINGS_KEYS: readonly string[] = ["disabledModels"];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "model", title: "Model and thinking", description: "Which model starts a session, and how hard it thinks." },
  { id: "interface", title: "Interface", description: "Theme, editor, and startup behaviour." },
  { id: "delivery", title: "Message delivery", description: "How steering and follow-up messages reach a running turn, and which transport carries them." },
  { id: "context", title: "Context and compaction", description: "When the agent summarizes history to make room." },
  { id: "retry", title: "Retry", description: "What happens when a provider request fails." },
  { id: "tools", title: "Tools", description: "Which built-in tools a session starts with." },
  { id: "shell", title: "Shell and npm", description: "How the agent runs commands and installs packages." },
  { id: "resources", title: "Packages and resources", description: "Where extensions, skills, prompts and themes are loaded from." },
  { id: "sessions", title: "Sessions", description: "Where session transcripts are stored." },
  { id: "images", title: "Images", description: "What happens to images before they reach the model." },
  { id: "network", title: "Network", description: "Proxying and connection timeouts." },
  { id: "privacy", title: "Trust and telemetry", description: "Project trust fallback, install ping, analytics." },
  { id: "warnings", title: "Warnings", description: "Which advisory notices the agent shows." },
  { id: "terminal", title: "Terminal display", description: `The agent's own terminal interface. ${PRODUCT_NAME} does not read these; they change how the agent looks when it is run in a terminal.` },
  { id: "markdown", title: "Markdown rendering", description: "How the agent renders markdown in a terminal." },
  { id: "managed", title: "Managed by the agent", description: `Written by the agent itself. Shown for completeness; ${PRODUCT_NAME} will not change them.` },
];

const PRODUCT_SECTIONS: readonly SettingsSection[] = [
  { id: "model", title: "Model behavior", description: "Defaults for new sessions and how reasoning is shown." },
  { id: "delivery", title: "Conversation flow", description: "How messages sent during a running turn are delivered." },
  { id: "context", title: "Context", description: `How ${PRODUCT_NAME} keeps long conversations within the model's context window.` },
  { id: "images", title: "Images", description: "How images are prepared before they reach the model." },
  { id: "retry", title: "Reliability", description: "Recovery behavior for temporary provider failures." },
  { id: "network", title: "Network", description: "Proxy and connection controls for unusual environments." },
  { id: "shell", title: "Command environment", description: "How project commands are launched." },
  { id: "warnings", title: "Safety notices", description: "Provider-specific notices that protect against unexpected usage." },
];

const GENERAL_KEYS = new Set([
  "defaultProvider", "defaultModel", "defaultThinkingLevel", "modelThinkingLevels", "enabledModels",
  "hideThinkingBlock", "steeringMode", "followUpMode", "compaction", "images",
]);
const ADVANCED_KEYS = new Set([
  "transport", "retry", "showCacheMissNotices", "shellPath", "shellCommandPrefix", "thinkingBudgets",
  "httpProxy", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "warnings",
]);
const INTERNAL_KEYS = new Set([
  "lastChangelogVersion", "theme", "defaultProjectTrust", "npmCommand", "enableInstallTelemetry",
  "enableAnalytics", "trackingId", "packages", "extensions", "skills", "prompts", "themes",
  "enableSkillCommands", "defaultTools", "sessionDir",
]);

export const SETTINGS_CLASSIFICATIONS = PI_SETTINGS_TOP_LEVEL_KEYS.map((key) => {
  if (GENERAL_KEYS.has(key)) return { key, disposition: "general" as const, reason: `A common ${PRODUCT_NAME} behavior people may choose.` };
  if (ADVANCED_KEYS.has(key)) return { key, disposition: "advanced" as const, reason: "A specialist engine control exposed with product language." };
  if (INTERNAL_KEYS.has(key)) return { key, disposition: "internal" as const, reason: `${PRODUCT_NAME} owns this value or exposes it through a dedicated product surface.` };
  return { key, disposition: "unsupported" as const, reason: `This changes the engine's terminal interface, not the ${PRODUCT_NAME} experience.` };
});

const BOTH: SettingsScope[] = ["global", "project"];
const GLOBAL_ONLY: SettingsScope[] = ["global"];

/**
 * The schema every settings form is generated from. Descriptions are Pi's own
 * wording from `docs/settings.md`, condensed to one sentence.
 */
export const SETTINGS_FIELDS: readonly SettingDescriptor[] = [
  // --- model -------------------------------------------------------------
  {
    path: "defaultProvider",
    key: "defaultProvider",
    label: "Default provider",
    description: 'Provider a new session starts on, for example "anthropic" or "openai".',
    section: "model",
    type: { control: "text", placeholder: "anthropic" },
    scopes: BOTH,
  },
  {
    path: "defaultModel",
    key: "defaultModel",
    label: "Default model",
    description: "Model id a new session starts on.",
    section: "model",
    type: { control: "text", placeholder: "claude-sonnet-4-20250514" },
    scopes: BOTH,
  },
  {
    path: "defaultThinkingLevel",
    key: "defaultThinkingLevel",
    label: "Default thinking level",
    description: "Thinking level a new session starts at.",
    section: "model",
    type: { control: "enum", options: THINKING_OPTIONS },
    default: "medium",
    scopes: BOTH,
  },
  {
    path: "modelThinkingLevels",
    key: "modelThinkingLevels",
    label: "Thinking level per model",
    description: 'Startup thinking level for specific models, keyed by "provider/modelId".',
    section: "model",
    type: { control: "enum-map", options: THINKING_OPTIONS, keyPlaceholder: "anthropic/claude-sonnet-4-20250514" },
    scopes: BOTH,
  },
  {
    path: "enabledModels",
    key: "enabledModels",
    label: "Enabled models",
    description: "Glob patterns limiting which models are offered. Unset means every model that is available.",
    section: "model",
    type: { control: "string-list", placeholder: "claude-*", hint: "One glob per line. The list replaces the global one; it does not extend it." },
    scopes: BOTH,
  },
  {
    path: "disabledModels",
    key: "disabledModels",
    label: "Switched-off models",
    description: "Models switched off in Providers and models, one per line as provider/id. Everything else stays offered, including models added later.",
    section: "model",
    type: { control: "string-list", placeholder: "openai/gpt-5", hint: "Exact references only, matched without regard to case. The project list replaces the global one; it does not extend it." },
    scopes: BOTH,
    advanced: true,
  },
  {
    path: "hideThinkingBlock",
    key: "hideThinkingBlock",
    label: "Hide thinking blocks",
    description: "Hide reasoning output.",
    section: "model",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },
  {
    path: "showCacheMissNotices",
    key: "showCacheMissNotices",
    label: "Show cache-miss notices",
    description: "Show transcript notices for significant prompt-cache misses, compaction usage, and provider recovery diagnostics.",
    section: "model",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },
  {
    path: "thinkingBudgets.minimal",
    key: "thinkingBudgets",
    label: "Thinking budget · minimal",
    description: "Token budget for the minimal thinking level. Used natively by Anthropic, Google and Bedrock.",
    section: "model",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    scopes: BOTH,
  },
  {
    path: "thinkingBudgets.low",
    key: "thinkingBudgets",
    label: "Thinking budget · low",
    description: "Token budget for the low thinking level.",
    section: "model",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    scopes: BOTH,
  },
  {
    path: "thinkingBudgets.medium",
    key: "thinkingBudgets",
    label: "Thinking budget · medium",
    description: "Token budget for the medium thinking level.",
    section: "model",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    scopes: BOTH,
  },
  {
    path: "thinkingBudgets.high",
    key: "thinkingBudgets",
    label: "Thinking budget · high",
    description: "Token budget for the high thinking level.",
    section: "model",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    scopes: BOTH,
  },

  // --- interface ---------------------------------------------------------
  {
    path: "theme",
    key: "theme",
    label: "Theme",
    description: `The agent\'s own terminal theme: "dark", "light", or a custom theme you loaded. ${PRODUCT_NAME}\'s appearance is set in Settings → Appearance.`,
    section: "interface",
    type: { control: "text", placeholder: "dark" },
    default: "dark",
    scopes: BOTH,
  },
  {
    path: "externalEditor",
    key: "externalEditor",
    label: "External editor",
    description: 'Command for the agent\'s Ctrl+G external editor in a terminal. Takes precedence over $VISUAL and $EDITOR. Include a wait flag, e.g. "code --wait".',
    section: "interface",
    type: { control: "text", placeholder: "code --wait" },
    scopes: BOTH,
  },
  {
    path: "quietStartup",
    key: "quietStartup",
    label: "Quiet startup",
    description: "Hide the agent's startup header in a terminal.",
    section: "interface",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },
  {
    path: "collapseChangelog",
    key: "collapseChangelog",
    label: "Collapse changelog",
    description: "Show a condensed changelog after the agent updates.",
    section: "interface",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },
  {
    path: "doubleEscapeAction",
    key: "doubleEscapeAction",
    label: "Double-escape action",
    description: "What double-escape does in the agent's terminal interface.",
    section: "interface",
    type: {
      control: "enum",
      options: [
        { value: "tree", label: "tree", hint: "open the session tree" },
        { value: "fork", label: "fork", hint: "fork at the previous message" },
        { value: "none", label: "none" },
      ],
    },
    default: "tree",
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "treeFilterMode",
    key: "treeFilterMode",
    label: "Tree filter",
    description: "Default filter for the agent's /tree view in a terminal.",
    section: "interface",
    type: {
      control: "enum",
      options: ["default", "no-tools", "user-only", "labeled-only", "all"].map((value) => ({ value, label: value })),
    },
    default: "default",
    scopes: BOTH,
    terminalOnly: true,
  },

  // --- delivery ----------------------------------------------------------
  {
    path: "steeringMode",
    key: "steeringMode",
    label: "Steering delivery",
    description: "Whether queued steering messages are delivered all at once or one per turn.",
    section: "delivery",
    type: {
      control: "enum",
      options: [
        { value: "one-at-a-time", label: "one-at-a-time" },
        { value: "all", label: "all" },
      ],
    },
    default: "one-at-a-time",
    scopes: BOTH,
  },
  {
    path: "followUpMode",
    key: "followUpMode",
    label: "Follow-up delivery",
    description: "Whether queued follow-up messages are delivered all at once or one per turn.",
    section: "delivery",
    type: {
      control: "enum",
      options: [
        { value: "one-at-a-time", label: "one-at-a-time" },
        { value: "all", label: "all" },
      ],
    },
    default: "one-at-a-time",
    scopes: BOTH,
  },
  {
    path: "transport",
    key: "transport",
    label: "Transport",
    description: "Preferred transport for providers that support more than one.",
    section: "delivery",
    type: {
      control: "enum",
      options: ["auto", "sse", "websocket", "websocket-cached"].map((value) => ({ value, label: value })),
    },
    default: "auto",
    scopes: BOTH,
  },
  {
    path: "httpIdleTimeoutMs",
    key: "httpIdleTimeoutMs",
    label: "HTTP idle timeout",
    description: "Header and body idle timeout, also used by providers with explicit stream idle timeouts. 0 disables it.",
    section: "delivery",
    type: { control: "number", min: 0, integer: true, unit: "ms" },
    default: 300_000,
    scopes: BOTH,
  },
  {
    path: "websocketConnectTimeoutMs",
    key: "websocketConnectTimeoutMs",
    label: "WebSocket connect timeout",
    description: "Handshake timeout for providers on a WebSocket transport. 0 disables it.",
    section: "delivery",
    type: { control: "number", min: 0, integer: true, unit: "ms" },
    default: 15_000,
    scopes: BOTH,
  },

  // --- context -----------------------------------------------------------
  {
    path: "compaction.enabled",
    key: "compaction",
    label: "Auto-compaction",
    description: "Summarize old history automatically when the context window fills.",
    section: "context",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
  },
  {
    path: "compaction.reserveTokens",
    key: "compaction",
    label: "Reserve tokens",
    description: "Tokens held back for the model's reply when deciding to compact.",
    section: "context",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    default: 16_384,
    scopes: BOTH,
  },
  {
    path: "compaction.keepRecentTokens",
    key: "compaction",
    label: "Keep recent tokens",
    description: "Recent history kept verbatim rather than summarized.",
    section: "context",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    default: 20_000,
    scopes: BOTH,
  },
  {
    path: "branchSummary.reserveTokens",
    key: "branchSummary",
    label: "Branch summary · reserve tokens",
    description: "Tokens reserved when selecting branch history for a summary. Output is capped at 4096 tokens.",
    section: "context",
    type: { control: "number", min: 0, integer: true, unit: "tokens" },
    default: 16_384,
    scopes: BOTH,
  },
  {
    path: "branchSummary.skipPrompt",
    key: "branchSummary",
    label: "Branch summary · skip prompt",
    description: 'Skip the "Summarize branch?" question when navigating the tree, and take no summary.',
    section: "context",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },

  // --- retry -------------------------------------------------------------
  {
    path: "retry.enabled",
    key: "retry",
    label: "Agent retry",
    description: "Retry the agent loop automatically on transient errors.",
    section: "retry",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
  },
  {
    path: "retry.maxRetries",
    key: "retry",
    label: "Max agent retries",
    description: "How many times the agent loop retries.",
    section: "retry",
    type: { control: "number", min: 0, max: 20, integer: true },
    default: 3,
    scopes: BOTH,
  },
  {
    path: "retry.baseDelayMs",
    key: "retry",
    label: "Retry base delay",
    description: "Base delay for exponential backoff between agent retries.",
    section: "retry",
    type: { control: "number", min: 0, integer: true, unit: "ms" },
    default: 2000,
    scopes: BOTH,
  },
  {
    path: "retry.provider.timeoutMs",
    key: "retry",
    label: "Provider request timeout",
    description: "SDK request timeout. Unset uses the provider SDK's own default.",
    section: "retry",
    type: { control: "number", min: 0, integer: true, unit: "ms" },
    scopes: BOTH,
    advanced: true,
  },
  {
    path: "retry.provider.maxRetries",
    key: "retry",
    label: "Provider retries",
    description: "SDK-level retries. Keep this at 0 unless you need it: above 0 the SDK can swallow out-of-quota errors before the agent sees them and block it until the quota resets.",
    section: "retry",
    type: { control: "number", min: 0, max: 10, integer: true },
    default: 0,
    scopes: BOTH,
    advanced: true,
  },
  {
    path: "retry.provider.maxRetryDelayMs",
    key: "retry",
    label: "Max server-requested delay",
    description: "Longest retry delay the agent will wait when a provider asks for one. Beyond it the request fails with an explanation instead of stalling. 0 removes the limit.",
    section: "retry",
    type: { control: "number", min: 0, integer: true, unit: "ms" },
    default: 60_000,
    scopes: BOTH,
    advanced: true,
  },

  // --- tools -------------------------------------------------------------
  {
    path: "defaultTools",
    key: "defaultTools",
    label: "Default built-in tools",
    description: "Built-in tools enabled at startup. Unset uses the standard defaults; an empty list starts with no built-ins but keeps extension and SDK tools.",
    section: "tools",
    type: {
      control: "string-list",
      placeholder: "bash",
      hint: "Built-ins: read, bash, powershell, edit, write, grep, find, ls. A project list replaces the global one.",
    },
    scopes: BOTH,
  },

  // --- shell -------------------------------------------------------------
  {
    path: "shellPath",
    key: "shellPath",
    label: "Shell path",
    description: "Shell binary for the bash tool. A leading ~ is expanded.",
    section: "shell",
    type: { control: "text", placeholder: "/bin/bash" },
    scopes: BOTH,
  },
  {
    path: "shellCommandPrefix",
    key: "shellCommandPrefix",
    label: "Shell command prefix",
    description: 'Prepended to every bash command, e.g. "shopt -s expand_aliases".',
    section: "shell",
    type: { control: "text", placeholder: "shopt -s expand_aliases" },
    scopes: BOTH,
  },
  {
    path: "npmCommand",
    key: "npmCommand",
    label: "npm command",
    description: "Argv used for every npm operation, including package installs. Give it exactly as the process should be launched.",
    section: "shell",
    type: { control: "string-list", placeholder: "npm", hint: 'Example: ["mise", "exec", "node@20", "--", "npm"].' },
    scopes: BOTH,
  },

  // --- resources ---------------------------------------------------------
  {
    path: "packages",
    key: "packages",
    label: "Packages",
    description: "npm or git packages to load extensions, skills, prompts and themes from. Manage these on the Packages tab; the JSON here is the same list.",
    section: "resources",
    type: { control: "json", hint: 'A string loads everything from the package; an object form filters, e.g. { "source": "pi-skills", "skills": ["brave-search"] }.' },
    default: [],
    scopes: BOTH,
  },
  {
    path: "extensions",
    key: "extensions",
    label: "Extension paths",
    description: "Local extension files or directories. Globs, !exclude, +force-include and -force-exclude are supported.",
    section: "resources",
    type: { control: "string-list", placeholder: "./extensions/my-extension.ts" },
    default: [],
    scopes: BOTH,
  },
  {
    path: "skills",
    key: "skills",
    label: "Skill paths",
    description: "Local skill files or directories.",
    section: "resources",
    type: { control: "string-list", placeholder: "./skills" },
    default: [],
    scopes: BOTH,
  },
  {
    path: "prompts",
    key: "prompts",
    label: "Prompt template paths",
    description: "Local prompt template files or directories.",
    section: "resources",
    type: { control: "string-list", placeholder: "./prompts" },
    default: [],
    scopes: BOTH,
  },
  {
    path: "themes",
    key: "themes",
    label: "Theme paths",
    description: "Local theme files or directories.",
    section: "resources",
    type: { control: "string-list", placeholder: "./themes" },
    default: [],
    scopes: BOTH,
  },
  {
    path: "enableSkillCommands",
    key: "enableSkillCommands",
    label: "Skill slash commands",
    description: "Register every loaded skill as a /skill:name command.",
    section: "resources",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
  },

  // --- sessions ----------------------------------------------------------
  {
    path: "sessionDir",
    key: "sessionDir",
    label: "Session directory",
    description: "Where session transcripts are written. Absolute, relative, or ~-prefixed. --session-dir and PI_CODING_AGENT_SESSION_DIR win over it.",
    section: "sessions",
    type: { control: "text", placeholder: ".pi/sessions" },
    scopes: BOTH,
  },

  // --- images ------------------------------------------------------------
  {
    path: "images.autoResize",
    key: "images",
    label: "Auto-resize images",
    description: "Resize images to at most 2000×2000 before sending. Applies to @file attachments, the read tool, and images returned by tools.",
    section: "images",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
  },
  {
    path: "images.blockImages",
    key: "images",
    label: "Block images",
    description: "Never send images to the model.",
    section: "images",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },

  // --- network -----------------------------------------------------------
  {
    path: "httpProxy",
    key: "httpProxy",
    label: "HTTP proxy",
    description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY. This is a global setting only; a project cannot override it.",
    section: "network",
    type: { control: "text", placeholder: "http://127.0.0.1:7890" },
    scopes: GLOBAL_ONLY,
  },

  // --- privacy -----------------------------------------------------------
  {
    path: "defaultProjectTrust",
    key: "defaultProjectTrust",
    label: "Default project trust",
    description: 'Fallback when a project has no saved trust decision. Non-interactive modes never prompt: "ask" and "never" ignore project resources, "always" trusts them. Global setting only.',
    section: "privacy",
    type: {
      control: "enum",
      options: [
        { value: "ask", label: "ask", hint: "ignore project resources when nobody can be asked" },
        { value: "always", label: "always", hint: "trust every project by default" },
        { value: "never", label: "never" },
      ],
    },
    default: "ask",
    scopes: GLOBAL_ONLY,
  },
  {
    path: "enableInstallTelemetry",
    key: "enableInstallTelemetry",
    label: "Install telemetry",
    description: "Send the agent's anonymous install/update ping and provider attribution headers. Does not control update checks.",
    section: "privacy",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
  },
  {
    path: "enableAnalytics",
    key: "enableAnalytics",
    label: "Analytics",
    description: "Opt in to the agent's analytics. Turning it on generates a tracking id.",
    section: "privacy",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
  },
  {
    path: "trackingId",
    key: "trackingId",
    label: "Tracking id",
    description: "Generated the first time analytics is enabled.",
    section: "managed",
    type: { control: "text" },
    scopes: GLOBAL_ONLY,
    managed: true,
  },

  // --- warnings ----------------------------------------------------------
  {
    path: "warnings.anthropicExtraUsage",
    key: "warnings",
    label: "Anthropic extra-usage warning",
    description: "Warn when Anthropic subscription auth may spill into paid extra usage.",
    section: "warnings",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
  },

  // --- terminal ----------------------------------------------------------
  {
    path: "terminal.showImages",
    key: "terminal",
    label: "Show images in terminal",
    description: "Render images inline when the terminal supports it.",
    section: "terminal",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "terminal.imageWidthCells",
    key: "terminal",
    label: "Inline image width",
    description: "Preferred inline image width, in terminal cells.",
    section: "terminal",
    type: { control: "number", min: 1, max: 400, integer: true, unit: "cells" },
    default: 60,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "terminal.clearOnShrink",
    key: "terminal",
    label: "Clear rows on shrink",
    description: "Clear empty rows when content shrinks. Can cause flicker.",
    section: "terminal",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "terminal.showTerminalProgress",
    key: "terminal",
    label: "Terminal progress reports",
    description: "Emit OSC 9;4 progress while working. Present in the agent's settings type but not in its settings documentation.",
    section: "terminal",
    type: { control: "boolean" },
    scopes: BOTH,
    terminalOnly: true,
    advanced: true,
  },
  {
    path: "terminal.hyperlinks",
    key: "terminal",
    label: "OSC 8 hyperlinks",
    description: "Override terminal hyperlink support detection.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: "auto", label: "auto", hint: "detect" },
        { value: true, label: "on" },
        { value: false, label: "off" },
      ],
    },
    default: "auto",
    scopes: BOTH,
    terminalOnly: true,
    advanced: true,
  },
  {
    path: "terminal.images",
    key: "terminal",
    label: "Image protocol",
    description: "Override the inline-image protocol the agent detects.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: "auto", label: "auto", hint: "detect" },
        { value: "kitty", label: "kitty" },
        { value: "iterm2", label: "iterm2" },
        { value: false, label: "off" },
      ],
    },
    default: "auto",
    scopes: BOTH,
    terminalOnly: true,
    advanced: true,
  },
  {
    path: "terminal.trueColor",
    key: "terminal",
    label: "Truecolor",
    description: "Override truecolor support detection.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: "auto", label: "auto", hint: "detect" },
        { value: true, label: "on" },
        { value: false, label: "off" },
      ],
    },
    default: "auto",
    scopes: BOTH,
    terminalOnly: true,
    advanced: true,
  },
  {
    path: "editorPaddingX",
    key: "editorPaddingX",
    label: "Editor horizontal padding",
    description: "Horizontal padding of the agent's input editor in a terminal.",
    section: "terminal",
    type: { control: "number", min: 0, max: 3, integer: true },
    default: 0,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "outputPad",
    key: "outputPad",
    label: "Output padding",
    description: "Horizontal padding for user messages, assistant messages and thinking.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: 0, label: "0" },
        { value: 1, label: "1" },
      ],
    },
    default: 1,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "autocompleteMaxVisible",
    key: "autocompleteMaxVisible",
    label: "Autocomplete rows",
    description: "How many items the agent's autocomplete dropdown shows in a terminal.",
    section: "terminal",
    type: { control: "number", min: 3, max: 20, integer: true },
    default: 5,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "showHardwareCursor",
    key: "showHardwareCursor",
    label: "Hardware cursor",
    description: "Show the terminal cursor while the TUI positions it, for IME support.",
    section: "terminal",
    type: { control: "boolean" },
    default: false,
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "tuiMode",
    key: "tuiMode",
    label: "TUI mode",
    description: "The agent's interactive mode in a terminal. --tui-mode overrides it at startup.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: "regular", label: "regular" },
        { value: "fullscreen", label: "fullscreen", hint: "experimental" },
      ],
    },
    default: "regular",
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "fullscreenExitOutput",
    key: "fullscreenExitOutput",
    label: "Fullscreen exit output",
    description: "What the agent leaves on screen when it exits fullscreen mode.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: "transcript", label: "transcript", hint: "print the transcript and a resume hint" },
        { value: "resume-hint", label: "resume-hint", hint: "restore the previous screen" },
      ],
    },
    default: "transcript",
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "fullscreenScrollbar",
    key: "fullscreenScrollbar",
    label: "Fullscreen scrollbar",
    description: "Transcript scrollbar behaviour in fullscreen mode.",
    section: "terminal",
    type: {
      control: "enum",
      options: [
        { value: "auto", label: "auto", hint: "appears while scrolling or hovering" },
        { value: "always", label: "always" },
        { value: "hidden", label: "hidden" },
      ],
    },
    default: "auto",
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "fullscreenCopyOnSelect",
    key: "fullscreenCopyOnSelect",
    label: "Copy on select",
    description: "Copy selected text automatically in fullscreen mode. When off, Ctrl+X copies the selection.",
    section: "terminal",
    type: { control: "boolean" },
    default: true,
    scopes: BOTH,
    terminalOnly: true,
  },

  // --- markdown ----------------------------------------------------------
  {
    path: "markdown.codeBlockIndent",
    key: "markdown",
    label: "Code block indent",
    description: "Indentation the agent puts in front of rendered code blocks.",
    section: "markdown",
    type: { control: "text", placeholder: "  " },
    default: "  ",
    scopes: BOTH,
    terminalOnly: true,
  },
  {
    path: "markdown.mermaid",
    key: "markdown",
    label: "Mermaid rendering",
    description: "How the agent renders mermaid diagrams.",
    section: "markdown",
    type: {
      control: "enum",
      options: [
        { value: "streaming", label: "streaming" },
        { value: "final", label: "final" },
        { value: "off", label: "off" },
      ],
    },
    default: "streaming",
    scopes: BOTH,
    terminalOnly: true,
  },

  // --- managed -----------------------------------------------------------
  {
    path: "lastChangelogVersion",
    key: "lastChangelogVersion",
    label: "Last changelog version",
    description: "The version whose changelog you were last shown.",
    section: "managed",
    type: { control: "text" },
    scopes: GLOBAL_ONLY,
    managed: true,
  },
];

const FIELD_BY_PATH = new Map(SETTINGS_FIELDS.map((field) => [field.path, field]));
const PRODUCT_SETTING_KEYS = new Set([
  ...SETTINGS_CLASSIFICATIONS
    .filter((entry) => entry.disposition === "general" || entry.disposition === "advanced")
    .map((entry) => entry.key),
  ...LASER_SETTINGS_KEYS,
]);

export function settingsCatalog(): SettingsCatalog {
  const disposition = new Map(SETTINGS_CLASSIFICATIONS.map((entry) => [entry.key, entry.disposition]));
  const fields = SETTINGS_FIELDS.flatMap((field) => {
    const audience = LASER_SETTINGS_KEYS.includes(field.key) ? "general" : disposition.get(field.key);
    if (audience !== "general" && audience !== "advanced") return [];
    return [{ ...field, audience, advanced: field.advanced ?? fullConfigurationOnly(field.path) }];
  });
  return {
    engineVersion: VERSION,
    sections: [...PRODUCT_SECTIONS],
    fields,
    topLevelKeys: [...PI_SETTINGS_TOP_LEVEL_KEYS],
    classifications: [...SETTINGS_CLASSIFICATIONS],
  };
}

function fullConfigurationOnly(path: string): boolean {
  return path !== "defaultProvider" && path !== "defaultModel" && path !== "defaultThinkingLevel" &&
    path !== "steeringMode" && path !== "followUpMode" && path !== "compaction.enabled" &&
    path !== "images.autoResize" && path !== "images.blockImages" && path !== "retry.enabled";
}

// ------------------------------------------------------------------ errors

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

// ------------------------------------------------------------- path helpers

type Doc = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ENGINE_PRIVATE_OVERRIDES: Doc = {
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
};

/** Only product-owned settings are read from `.laser`: the curated engine keys and the product's own. */
export function laserEngineSettings(value: unknown): Doc {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => PRODUCT_SETTING_KEYS.has(key)));
}

/** The engine's share of a settings document: the product's own keys never cross into it. */
export function engineSettingsOnly(doc: Doc): Doc {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !LASER_SETTINGS_KEYS.includes(key)));
}

/**
 * The `disabledModels` list as a set of lower-cased canonical references,
 * tolerant of a document that holds anything else there.
 */
export function disabledModelRefs(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""));
}

/** Whether a person switched this model off. Exact reference only: a model the list does not name is on. */
export function modelSwitchedOff(model: { provider: string; id: string }, refs: ReadonlySet<string>): boolean {
  return refs.has(`${model.provider}/${model.id}`.toLowerCase());
}

export function readLaserProjectSettings(cwd: string): Doc {
  const file = join(resolve(cwd), LASER_PROJECT_DIR_NAME, "settings.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    return laserEngineSettings(parsed);
  } catch {
    return {};
  }
}

/** The engine's global settings file as written, or `{}` when absent or unreadable. */
export function readGlobalSettingsFile(agentDir: string): Doc {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(resolve(agentDir), "settings.json"), "utf8").replace(/^\uFEFF/, ""));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * What the product's model switches resolve to right now: the global file
 * merged with the project's `.laser` values, read fresh. A live session's
 * own settings manager is not reloaded after a Settings write, so anything
 * that must reflect the switches immediately — a session's picker — reads
 * the files rather than the session (M13-T49).
 */
export function readEffectiveProductSettings(cwd: string, agentDir: string, projectTrusted: boolean | undefined): Doc {
  return mergeSettings(readGlobalSettingsFile(agentDir), projectTrusted === false ? {} : readLaserProjectSettings(cwd));
}

/** Read a dotted path. Returns undefined when any link is missing or not an object. */
export function getAtPath(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const segment of path.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Write a dotted path, creating intermediate objects. Mutates `doc`. */
export function setAtPath(doc: Doc, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop() as string;
  let cursor: Doc = doc;
  for (const segment of segments) {
    const next = cursor[segment];
    if (!isPlainObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as Doc;
  }
  cursor[last] = value;
}

/**
 * Remove a dotted path, then drop parent objects the removal emptied, so
 * unsetting `compaction.enabled` does not leave `"compaction": {}` behind.
 */
export function unsetAtPath(doc: Doc, path: string): void {
  const segments = path.split(".");
  const chain: Doc[] = [doc];
  let cursor: Doc = doc;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainObject(next)) return;
    cursor = next;
    chain.push(cursor);
  }
  delete cursor[segments[segments.length - 1] as string];
  for (let i = chain.length - 1; i > 0; i--) {
    const child = chain[i] as Doc;
    if (Object.keys(child).length > 0) break;
    delete (chain[i - 1] as Doc)[segments[i - 1] as string];
  }
}

/** Pi's merge: nested objects merge recursively, everything else replaces. */
export function mergeSettings(base: Doc, overrides: Doc): Doc {
  const result: Doc = { ...base };
  for (const key of Object.keys(overrides)) {
    const override = overrides[key];
    if (override === undefined) continue;
    const current = base[key];
    result[key] = isPlainObject(current) && isPlainObject(override) ? mergeSettings(current, override) : override;
  }
  return result;
}

// ------------------------------------------------------------- validation

/** Human-readable rejection, or undefined when the value is acceptable. */
export function validateSettingValue(field: SettingDescriptor, value: unknown): string | undefined {
  const type = field.type;
  switch (type.control) {
    case "boolean":
      return typeof value === "boolean" ? undefined : `${field.path} must be true or false.`;
    case "text":
      return typeof value === "string" ? undefined : `${field.path} must be a string.`;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return `${field.path} must be a number.`;
      if (type.integer && !Number.isInteger(value)) return `${field.path} must be a whole number.`;
      if (type.min !== undefined && value < type.min) return `${field.path} must be at least ${type.min}.`;
      if (type.max !== undefined && value > type.max) return `${field.path} must be at most ${type.max}.`;
      return undefined;
    }
    case "enum": {
      const allowed = type.options.map((option) => option.value);
      if (allowed.includes(value as string | number | boolean)) return undefined;
      return `${field.path} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
    }
    case "string-list": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return `${field.path} must be a list of strings.`;
      }
      return undefined;
    }
    case "enum-map": {
      if (!isPlainObject(value)) return `${field.path} must be an object.`;
      const allowed = type.options.map((option) => option.value);
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (!allowed.includes(entryValue as string | number | boolean)) {
          return `${field.path}["${entryKey}"] must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
        }
      }
      return undefined;
    }
    case "json":
      // Anything JSON-serializable. The value already came through JSON.
      return value === undefined ? `${field.path} must not be undefined.` : undefined;
  }
}

// ------------------------------------------------------------------ storage

/**
 * The half of Pi's `SettingsStorage` this adapter needs. `withLock` is public
 * in Pi's types (`SettingsStorage`); the property that holds the instance is
 * not, hence the guarded lookup in `piSettingsStorage`.
 */
interface PiSettingsStorage {
  withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

function piSettingsStorage(manager: SettingsManager): PiSettingsStorage {
  const candidate = (manager as unknown as { storage?: unknown }).storage as PiSettingsStorage | undefined;
  if (!candidate || typeof candidate.withLock !== "function") {
    throw new SettingsError(
      `${PRODUCT_NAME} cannot write settings safely with the agent it is running (${VERSION}), so nothing was changed. ` +
        `Your settings file is untouched. Reinstall ${PRODUCT_NAME} to get the agent it ships with; if this is a ` +
        `development build, packages/worker/src/settings.ts needs updating for this version (task MX-T2).`,
    );
  }
  return candidate;
}

// ------------------------------------------------------------------ adapter

export interface SettingsAdapterOptions {
  cwd: string;
  /** Pi's config directory; defaults to Pi's own resolution (~/.pi/agent). */
  agentDir?: string;
  /**
   * The host's own trust decision for this project, when it made one (M2-T4).
   * Laser records decisions in its own project registry rather than the
   * `trust.json` (two writers on Pi's lock is a bug), so without this the
   * adapter would read Pi's store, see nothing, and disagree with the driver
   * about the very same project. Omit when nobody decided.
   */
  hostTrusted?: boolean;
}

/**
 * One adapter per worker (one project directory). It owns the only
 * `SettingsManager` laser writes through.
 */
export class SettingsAdapter {
  readonly cwd: string;
  readonly agentDir: string;
  private readonly globalPath: string;
  private readonly projectPath: string;
  private manager: SettingsManager;
  private trust: SettingsProjectTrust;
  private readonly hostTrusted: boolean | undefined;

  constructor(options: SettingsAdapterOptions) {
    this.cwd = resolve(options.cwd);
    this.agentDir = resolve(options.agentDir ?? getAgentDir());
    this.globalPath = join(this.agentDir, "settings.json");
    this.projectPath = join(this.cwd, LASER_PROJECT_DIR_NAME, "settings.json");
    this.hostTrusted = options.hostTrusted;
    this.trust = this.computeTrust();
    // Never let the engine discover `<cwd>/.pi`. Laser feeds it only the
    // curated values read from `<cwd>/.laser` as in-memory overrides.
    this.manager = SettingsManager.create(this.cwd, this.agentDir, { projectTrusted: false });
    this.applyProjectOverrides();
  }

  /** Pi's manager, for the package and model adapters that need one. */
  get settingsManager(): SettingsManager {
    return this.manager;
  }

  catalog(): SettingsCatalog {
    return settingsCatalog();
  }

  /** Current trust state, without the side effects of building a snapshot. */
  get projectTrust(): SettingsProjectTrust {
    return this.trust;
  }

  /**
   * Re-read both files and re-evaluate trust. Cheap (two small JSON reads);
   * call it before any read the UI will show.
   */
  async refresh(): Promise<void> {
    this.trust = this.computeTrust();
    this.manager.setProjectTrusted(false);
    await this.manager.reload();
    this.applyProjectOverrides();
  }

  snapshot(): SettingsSnapshot {
    const errors = new Map<SettingsScope, string>();
    for (const error of this.manager.drainErrors()) {
      errors.set(error.scope, error.error.message);
    }
    const global = this.manager.getGlobalSettings() as Doc;
    const project = this.trust.trusted ? readLaserProjectSettings(this.cwd) : {};
    return {
      cwd: this.cwd,
      agentDir: this.agentDir,
      global: fileState(this.globalPath, global, errors.get("global")),
      project: fileState(this.projectPath, project, errors.get("project")),
      effective: mergeSettings(global, project),
      projectTrust: this.trust,
    };
  }

  /**
   * Apply `changes` to one scope. Validates first and writes nothing when any
   * change is rejected, so a bad value in a batch never half-applies.
   */
  async apply(scope: SettingsScope, changes: SettingChange[]): Promise<SettingsSnapshot> {
    if (changes.length === 0) throw new SettingsError("No changes were given.");
    if (scope === "project" && !this.trust.writable) {
      throw new SettingsError(
        `${PRODUCT_NAME} will not write ${this.projectPath}: ${this.trust.reason} ` +
          `Trust the project first, or make this change at global scope.`,
      );
    }

    for (const change of changes) {
      const field = FIELD_BY_PATH.get(change.path);
      if (!field || !PRODUCT_SETTING_KEYS.has(field.key)) {
        throw new SettingsError(
          `Unknown or unsupported setting "${change.path}". The Settings screen lists every choice ${PRODUCT_NAME} supports.`,
        );
      }
      if (field.managed) {
        throw new SettingsError(`"${change.path}" is written by the agent itself, so ${PRODUCT_NAME} will not change it.`);
      }
      if (!field.scopes.includes(scope)) {
        throw new SettingsError(
          `"${change.path}" can only be set at ${field.scopes.join(" or ")} scope.`,
        );
      }
      if (change.op === "set") {
        const problem = validateSettingValue(field, change.value);
        if (problem) throw new SettingsError(problem);
      }
    }

    if (scope === "project") {
      let doc: Doc = {};
      if (existsSync(this.projectPath)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(this.projectPath, "utf8").replace(/^﻿/, ""));
          if (!isPlainObject(parsed)) throw new Error("the file must contain a JSON object");
          doc = laserEngineSettings(parsed);
        } catch (error) {
          throw new SettingsError(
            `${this.projectPath} is not valid ${PRODUCT_DISPLAY_NAME} settings (${error instanceof Error ? error.message : String(error)}). ` +
              `Nothing was written.`,
          );
        }
      }
      for (const change of changes) {
        if (change.op === "set") setAtPath(doc, change.path, change.value);
        else unsetAtPath(doc, change.path);
      }
      writeLaserProjectSettings(this.projectPath, doc);
      await this.refresh();
      return this.snapshot();
    }

    // Let the engine flush anything it queued before we take the same lock.
    await this.manager.flush();

    const storage = piSettingsStorage(this.manager);
    const target = this.globalPath;
    let refused: string | undefined;
    storage.withLock("global", (current) => {
      let doc: Doc = {};
      if (current !== undefined && current.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(current.replace(/^﻿/, ""));
        } catch (error) {
          refused =
            `${target} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
            `Nothing was written — ${PRODUCT_NAME} will not overwrite a settings file it cannot read. Fix the file and try again.`;
          return undefined;
        }
        if (!isPlainObject(parsed)) {
          refused = `${target} does not contain a JSON object. Nothing was written.`;
          return undefined;
        }
        doc = parsed;
      }
      const before = JSON.stringify(doc);
      for (const change of changes) {
        if (change.op === "set") setAtPath(doc, change.path, change.value);
        else unsetAtPath(doc, change.path);
      }
      // A change that changes nothing must not touch the file. Otherwise
      // tabbing through the settings form is one lock-and-rewrite per field,
      // and on a project with no `.pi` yet it *creates* `.pi/settings.json`
      // — a trust-gated file Pi will then ignore.
      if (JSON.stringify(doc) === before) return undefined;
      return JSON.stringify(doc, null, 2);
    });
    if (refused) throw new SettingsError(refused);

    await this.refresh();
    return this.snapshot();
  }

  /**
   * Laser owns project trust. The engine's trust store and `.pi` discovery do
   * not participate in the product-facing decision.
   */
  private computeTrust(): SettingsProjectTrust {
    if (this.hostTrusted === true) {
      return {
        trusted: true,
        writable: true,
        reason: `You trusted this project, so ${PRODUCT_NAME} loads ${this.projectPath}.`,
      };
    }
    if (this.hostTrusted === false) {
      return {
        trusted: false,
        writable: false,
        reason: `You declined to trust this project, so ${PRODUCT_NAME} ignores ${this.projectPath} and will not edit it.`,
      };
    }
    return {
      trusted: true,
      writable: true,
      reason: existsSync(this.projectPath)
        ? `${PRODUCT_NAME} is using this project's own settings.`
        : `This project has no ${PRODUCT_NAME} settings yet.`,
    };
  }

  private applyProjectOverrides(): void {
    const project = this.trust.trusted ? readLaserProjectSettings(this.cwd) : {};
    // Durable: any reload of this manager — ours in `refresh()`, or one from a
    // consumer we hand it to — otherwise recomputes settings from the two files
    // and drops these values (M13-T12).
    applyDurableOverrides(this.manager, mergeSettings(engineSettingsOnly(project), ENGINE_PRIVATE_OVERRIDES));
  }
}

function writeLaserProjectSettings(path: string, doc: Doc): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.settings.tmp`);
  writeFileSync(temporary, `${JSON.stringify(laserEngineSettings(doc), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function fileState(path: string, values: Doc, error: string | undefined): SettingsFileState {
  return {
    path,
    exists: existsSync(path),
    values,
    ...(error !== undefined ? { error } : {}),
  };
}
