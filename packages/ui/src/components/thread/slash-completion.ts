import type { Unstable_TriggerMatcher } from "@assistant-ui/react";

/** Slash commands are product commands only when the slash starts the draft. */
export const matchLeadingSlash: Unstable_TriggerMatcher = (text, triggerChar, cursorPosition) => {
  if (triggerChar !== "/" || !text.startsWith("/") || cursorPosition <= 0) return null;
  const firstWhitespace = text.search(/\s/u);
  const tokenEnd = firstWhitespace === -1 ? text.length : firstWhitespace;
  if (cursorPosition > tokenEnd) return null;
  return {
    query: text.slice(1, cursorPosition),
    offset: 0,
    endOffset: tokenEnd,
  };
};

/**
 * assistant-ui has already removed the typed `/query` when an action runs.
 * Put the chosen command in that exact place without discarding its suffix.
 */
export function completeLeadingSlash(command: string, remainder: string): string {
  const completed = command.startsWith("/") ? command : `/${command}`;
  if (remainder === "") return `${completed} `;
  return `${completed}${/^\s/u.test(remainder) ? "" : " "}${remainder}`;
}

type SlashCommandItem = { id: string; label?: string };

/**
 * Pi-style fuzzy matching over command identity only. All query characters
 * must occur in order, so `skbra` finds `skill:brave-search`; explanatory copy
 * can never make an unrelated command win Tab completion.
 */
export function rankSlashCommandMatches<T extends SlashCommandItem>(commands: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...commands];
  return commands
    .map((command, index) => ({ command, index, score: fuzzyCommandScore(commandName(command), needle) }))
    .filter((match): match is { command: T; index: number; score: number } => match.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ command }) => command);
}

export function slashCommandMatchesQuery(command: SlashCommandItem, query: string): boolean {
  return rankSlashCommandMatches([command], query).length === 1;
}

function commandName(command: SlashCommandItem): string {
  return (command.label ?? command.id).replace(/^\//u, "").toLocaleLowerCase();
}

/** Mirrors Pi's ordered-character scoring without importing its UI package. */
function fuzzyCommandScore(text: string, query: string): number | null {
  if (query.length > text.length) return null;
  let queryIndex = 0;
  let score = 0;
  let lastMatch = -1;
  let consecutive = 0;
  for (let index = 0; index < text.length && queryIndex < query.length; index += 1) {
    if (text[index] !== query[queryIndex]) continue;
    const boundary = index === 0 || /[\s\-_./:]/u.test(text[index - 1] ?? "");
    if (lastMatch === index - 1) {
      consecutive += 1;
      score -= consecutive * 5;
    } else {
      consecutive = 0;
      if (lastMatch >= 0) score += (index - lastMatch - 1) * 2;
    }
    if (boundary) score -= 10;
    score += index * 0.1;
    lastMatch = index;
    queryIndex += 1;
  }
  if (queryIndex < query.length) return null;
  if (query === text) score -= 100;
  return score;
}
