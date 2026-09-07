/** Internal prompt recognition requires this marker AND a known durable goal ID.
 * Never hide user prose merely because it resembles goal instructions. */
export function goalPromptId(text: string): string | undefined {
  if (!/<!-- pi-goal-prompt:[^\n]+ -->\s*$/.test(text)) return undefined;
  return /<goal_id>\s*([^\s<>]+)\s*<\/goal_id>/.exec(text)?.[1];
}
