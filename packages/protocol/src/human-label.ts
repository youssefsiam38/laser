/**
 * Turn a model-written display label into conservative sentence case.
 *
 * Only a single slug-shaped token is split. Existing sentences keep their
 * punctuation and internal capitals; code-shaped values stay byte-for-byte
 * unchanged so a path, command, URL, or identifier is never presented as
 * prose it was not meant to be.
 */

const COMMANDS = new Set([
  "bash", "bun", "cargo", "cd", "chmod", "cp", "curl", "deno", "docker",
  "git", "go", "grep", "java", "make", "mkdir", "mv", "node", "npm",
  "npx", "pnpm", "python", "python3", "rm", "rsync", "ruby", "sed", "sh",
  "ssh", "tar", "tsx", "vitest", "yarn",
]);

function isCodeShaped(value: string): boolean {
  if (/^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/i.test(value)) return true;
  if (!/\s/.test(value) && (/^(?:\.{0,2}|~)?[\\/]/.test(value) || /[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value))) return true;
  if (/^[`$>]/.test(value)) return true;
  const first = value.match(/^([^\s]+)/)?.[1]?.toLowerCase();
  if (first && COMMANDS.has(first)) return true;
  if (!/\s/.test(value) && (/[()[\]{}.:@#]/.test(value) || /[a-z][A-Z]/.test(value))) return true;
  return false;
}

/**
 * Humanise an agent-written name without rewriting deliberate prose.
 *
 * - A lone dash/underscore-separated token becomes spaced sentence case.
 * - Everything else only gains an initial capital when it starts lowercase.
 * - Whole paths, commands, URLs, and identifiers are returned unchanged.
 */
export function humanizeLabel(value: string): string {
  if (value === "" || isCodeShaped(value)) return value;
  const words = !/\s/.test(value) && /[-_]/.test(value)
    ? value.replace(/[-_]+/g, " ")
    : value;
  return words.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}
