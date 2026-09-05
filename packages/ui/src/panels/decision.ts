/**
 * Small pure helpers the `decision` kind needs on top of its payload.
 *
 * The payload itself is `DecisionPanel` in `@piorbit/protocol`, and Pi's four
 * dialogs are mapped onto it in `fallback.ts`. What is left here is the one
 * judgement a renderer has to make that the payload cannot carry: some options
 * do not answer this question, they change how the session asks from now on,
 * and a person deserves to be told that before pressing one.
 */

/**
 * "Always allow", "Allow for this session", "Don't ask again": choosing one
 * changes the session's behaviour from now on, so the control says so under
 * the label instead of letting it look like a one-off (M7-T4).
 */
export function isModeChangingOption(option: string): boolean {
  return /\b(always|all(ow)? (for )?(this )?session|for this session|every time|don'?t ask|never ask|remember|from now on|auto[- ]?approve)\b/i.test(
    option,
  );
}

/** One line for a minimal surface: the question, truncated by the renderer. */
export function decisionSummary(title: string): string {
  return title.replace(/\s+/g, " ").trim() || "Needs you";
}
