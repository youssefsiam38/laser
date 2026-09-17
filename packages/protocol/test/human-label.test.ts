import { describe, expect, it } from "vitest";
import { humanizeLabel } from "../src/human-label.js";

const CASES = [
  ["mention-format", "Mention format", "dash-separated name"],
  ["activity_labels_on_rows", "Activity labels on rows", "underscore-separated name"],
  ["goal--pause__forensics", "Goal pause forensics", "repeated separators"],
  ["Re-running tests", "Re-running tests", "sentence with a dash"],
  ["Fix the e-mail parser", "Fix the e-mail parser", "sentence with a hyphenated word"],
  ["Checking CI/CD config", "Checking CI/CD config", "sentence with a slash"],
  ["Read MCP config", "Read MCP config", "deliberate internal capitals"],
  ["checking the suite", "Checking the suite", "leading lowercase sentence"],
  ["packages/ui/src/store.ts", "packages/ui/src/store.ts", "path"],
  ["./scripts/check.sh", "./scripts/check.sh", "relative path"],
  ["pnpm test", "pnpm test", "command"],
  ["$ npm run build", "$ npm run build", "shell command"],
  ["https://example.com/build-log", "https://example.com/build-log", "URL"],
  ["activityLabel", "activityLabel", "camel-case identifier"],
  ["Tool.run()", "Tool.run()", "qualified identifier"],
  ["", "", "empty label"],
] as const;

describe("humanizeLabel", () => {
  it.each(CASES)("turns %s into %s (%s)", (input, expected) => {
    expect(humanizeLabel(input)).toBe(expected);
  });

  it.each(CASES)("is idempotent for %s", (input) => {
    const once = humanizeLabel(input);
    expect(humanizeLabel(once)).toBe(once);
  });
});
