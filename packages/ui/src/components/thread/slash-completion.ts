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
    endOffset: cursorPosition,
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

/** Match command identity only; explanatory copy must never hijack Tab. */
export function slashCommandMatchesQuery(command: { id: string; label?: string }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  const name = (command.label ?? command.id).replace(/^\//u, "").toLocaleLowerCase();
  return name.includes(needle);
}
