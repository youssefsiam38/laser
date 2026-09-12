"use client";
/**
 * The custom token editor (M11-T4, M11-T7).
 *
 * Every semantic colour token, editable, with a **contrast readout beside
 * each value** measuring the number you typed — not the number the compiler
 * would rescue it to. That distinction is the whole point: high contrast
 * silently raises a failing ink until it clears its ground, so a readout of
 * the resolved value would tell you your theme is fine when the theme itself
 * is not. Anything under 4.5:1 is flagged by name, in words, next to the
 * field that caused it.
 *
 * Optional tokens (the on-colours, the terminal set, syntax) are shown with
 * the value the compiler derives when they are unset, badged "derived".
 * Editing one pins it; "Use derived" unpins it. A preset that ships a value
 * counts as pinned, because it is.
 */
import { useId, useState } from "react";
import { ORIGINS } from "@lasercode/protocol";
import { AlertTriangle, ChevronRight, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  contrastRatio,
  MIN_CONTRAST,
  parseColor,
  resolveTokens,
  toHex,
  type ColorTokenName,
  type OptionalColorTokenName,
  type Theme,
  type ThemeIssue,
} from "@/theme";

type TokenName = ColorTokenName | OptionalColorTokenName;

/** Every group of tokens, and what each one is for in one line a person can act on. */
const GROUPS: ReadonlyArray<{ title: string; detail: string; tokens: readonly TokenName[]; advanced?: boolean }> = [
  {
    title: "Grounds",
    detail: "The page, the cards on it, the inset fields, and the hairlines between them.",
    tokens: ["bg", "surface", "surface-2", "line"],
  },
  {
    title: "Ink",
    detail: "Primary, secondary and tertiary text. Each must clear every ground.",
    tokens: ["ink", "ink-2", "ink-3"],
  },
  {
    title: "Status",
    detail: "Fixed meanings: running, needs you, error, done. The hues change; the meanings never do.",
    tokens: ["live", "attention", "danger", "ok"],
  },
  {
    title: "Text on a status colour",
    detail: "What is printed on a filled button or badge. Derived from the fill unless you pin it.",
    tokens: ["on-live", "on-attention", "on-danger", "on-ok"],
    advanced: true,
  },
  {
    title: "Terminal",
    detail: "Command output, dark in both themes so agent output reads the same everywhere.",
    tokens: ["terminal-bg", "terminal-ink", "terminal-ink-2", "terminal-line"],
    advanced: true,
  },
  {
    title: "Instruction sources",
    detail: "The origin rules and tints in captured instructions. Names remain visible without colour.",
    tokens: ORIGINS.map(origin => origin.token),
    advanced: true,
  },
  {
    title: "Syntax",
    detail: "Code highlighting. Kept away from the status hues so a keyword never reads as an error.",
    tokens: [
      "syntax-keyword",
      "syntax-string",
      "syntax-number",
      "syntax-comment",
      "syntax-function",
      "syntax-type",
      "syntax-variable",
      "syntax-punctuation",
    ],
    advanced: true,
  },
];

/** Which ground a token is measured against, and what it must clear there. */
function readout(theme: Theme, token: TokenName): { ratio: number; target: number; against: string; kind: "text" | "ground" | "line" } | undefined {
  const raw = theme.tokens as Partial<Record<TokenName, string>>;
  const grounds = ["bg", "surface", "surface-2"] as const;

  if (token === "bg" || token === "surface" || token === "surface-2") {
    return { ratio: contrastRatio(raw.ink ?? "", raw[token] ?? ""), target: MIN_CONTRAST, against: "ink", kind: "ground" };
  }
  if (token === "line") {
    return { ratio: contrastRatio(raw.line ?? "", raw.surface ?? ""), target: 1.25, against: "surface", kind: "line" };
  }
  if (token === "ink" || token === "ink-2" || token === "ink-3" || token === "live" || token === "attention" || token === "danger" || token === "ok") {
    let worst = Infinity;
    let where = "";
    for (const ground of grounds) {
      const ratio = contrastRatio(raw[token] ?? "", raw[ground] ?? "");
      if (ratio < worst) {
        worst = ratio;
        where = ground;
      }
    }
    return { ratio: worst, target: MIN_CONTRAST, against: where, kind: "text" };
  }
  if (token === "on-live" || token === "on-attention" || token === "on-danger" || token === "on-ok") {
    const fill = token.slice(3) as ColorTokenName;
    const resolved = resolveTokens(theme) as Record<string, string>;
    return {
      ratio: contrastRatio(resolved[token] ?? "", resolved[fill] ?? ""),
      target: MIN_CONTRAST,
      against: fill,
      kind: "text",
    };
  }
  if (token.startsWith("terminal-") && token !== "terminal-bg") {
    const resolved = resolveTokens(theme) as Record<string, string>;
    return {
      ratio: contrastRatio(resolved[token] ?? "", resolved["terminal-bg"] ?? ""),
      target: token === "terminal-line" ? 1.25 : MIN_CONTRAST,
      against: "terminal-bg",
      kind: token === "terminal-line" ? "line" : "text",
    };
  }
  if (token.startsWith("syntax-")) {
    const resolved = resolveTokens(theme) as Record<string, string>;
    return {
      ratio: contrastRatio(resolved[token] ?? "", resolved["surface-2"] ?? ""),
      target: MIN_CONTRAST,
      against: "surface-2",
      kind: "text",
    };
  }
  return undefined;
}

export interface TokenEditorProps {
  theme: Theme;
  issues: readonly ThemeIssue[];
  /** Pins a token to a value. */
  onSet: (token: TokenName, value: string) => void;
  /** Unpins a token so the compiler derives it again. Absent for required tokens. */
  onClear: (token: TokenName) => void;
}

export function TokenEditor({ theme, issues, onSet, onClear }: TokenEditorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const derived = resolveTokens(theme) as Record<string, string>;
  const simple = GROUPS.filter((group) => group.advanced !== true);
  const advanced = GROUPS.filter((group) => group.advanced === true);

  return (
    <div className="flex flex-col gap-5">
      {issues.length > 0 && <IssueList issues={issues} />}

      {simple.map((group) => (
        <TokenGroup key={group.title} group={group} theme={theme} derived={derived} onSet={onSet} onClear={onClear} />
      ))}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md py-1 text-start text-xs font-medium text-ink-2 outline-none",
            "hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("rtl:-scale-x-100",
              "size-3.5 transition-transform duration-(--motion-fast) motion-reduce:transition-none",
              advancedOpen && "rotate-90 rtl:-rotate-90",
            )}
          />
          Terminal, syntax and derived colours
          <span className="text-ink-3">· 16 more</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-5 pt-3">
            {advanced.map((group) => (
              <TokenGroup key={group.title} group={group} theme={theme} derived={derived} onSet={onSet} onClear={onClear} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function IssueList({ issues }: { issues: readonly ThemeIssue[] }) {
  const errors = issues.filter((issue) => issue.level === "error");
  const warnings = issues.filter((issue) => issue.level === "warning");
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2",
        errors.length > 0
          ? "bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger"
          : "bg-[color-mix(in_oklab,var(--attention)_12%,transparent)] text-attention",
      )}
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 text-xs leading-5">
        <p className="font-medium">
          {errors.length > 0
            ? `${errors.length} ${errors.length === 1 ? "colour keeps" : "colours keep"} this theme from being applied.`
            : `${warnings.length} ${warnings.length === 1 ? "colour is" : "colours are"} worth a second look.`}
        </p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {[...errors, ...warnings].slice(0, 6).map((issue, index) => (
            <li key={`${issue.token}-${index}`} className="opacity-90">
              {issue.message}
            </li>
          ))}
        </ul>
        {errors.length > 0 && (
          <p className="mt-1 opacity-90">The app keeps the last theme that worked until these are fixed.</p>
        )}
      </div>
    </div>
  );
}

function TokenGroup({
  group,
  theme,
  derived,
  onSet,
  onClear,
}: {
  group: { title: string; detail: string; tokens: readonly TokenName[] };
  theme: Theme;
  derived: Record<string, string>;
  onSet: (token: TokenName, value: string) => void;
  onClear: (token: TokenName) => void;
}) {
  const headingId = useId();
  return (
    <div aria-labelledby={headingId} role="group" className="flex flex-col gap-2">
      <div>
        <h4 id={headingId} className="text-xs font-semibold text-ink">
          {group.title}
        </h4>
        <p className="mt-0.5 text-xs leading-4 text-ink-3">{group.detail}</p>
      </div>
      <div className="flex flex-col rounded-lg border border-line">
        {group.tokens.map((token, index) => (
          <TokenRow
            key={token}
            token={token}
            theme={theme}
            derived={derived}
            first={index === 0}
            onSet={onSet}
            onClear={onClear}
          />
        ))}
      </div>
    </div>
  );
}

function TokenRow({
  token,
  theme,
  derived,
  first,
  onSet,
  onClear,
}: {
  token: TokenName;
  theme: Theme;
  derived: Record<string, string>;
  first: boolean;
  onSet: (token: TokenName, value: string) => void;
  onClear: (token: TokenName) => void;
}) {
  const raw = (theme.tokens as Partial<Record<TokenName, string>>)[token];
  const pinned = raw !== undefined;
  // `resolveTokens` fills in every token, so there is always a real value to
  // fall back to; a literal here would be a colour the theme cannot move.
  const fallback = derived[token] ?? theme.tokens.ink;
  const effective = raw ?? fallback;
  const hex = toHex(parseColor(effective) ? effective : fallback);
  const measure = readout(theme, token);
  const fails = measure !== undefined && measure.ratio < measure.target;
  const inputId = useId();

  /**
   * The text field keeps its own draft while it is being typed. Without it,
   * a half-typed hex is not a colour, so the store refuses the theme, the
   * value snaps back, and the field is unusable. The draft is
   * pushed up only when it parses; anything else is shown as invalid and
   * changes nothing.
   */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown = draft ?? effective;
  const valid = parseColor(shown) !== null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-2",
        !first && "hairline-t",
      )}
    >
      <label htmlFor={inputId} className="typed w-24 shrink-0 truncate text-ink-2 sm:w-32" title={`--${token}`}>
        {token}
      </label>

      <span className="relative inline-flex size-6 shrink-0 items-center justify-center">
        <input
          id={inputId}
          type="color"
          value={hex}
          onChange={(event) => {
            setDraft(undefined);
            onSet(token, event.target.value);
          }}
          aria-label={`${token} colour`}
          className={cn(
            "size-6 cursor-pointer rounded-md border border-line bg-transparent p-0 outline-none",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
            "[&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0",
            "[&::-webkit-color-swatch-wrapper]:p-0.5",
          )}
        />
      </span>

      <input
        type="text"
        value={shown}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${token} value`}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (parseColor(next)) onSet(token, next);
        }}
        onBlur={() => setDraft(undefined)}
        className={cn(
          "typed h-7 w-24 shrink-0 rounded-md border bg-surface px-2 text-ink outline-none sm:w-28",
          "transition-[border-color] duration-(--motion-instant) motion-reduce:transition-none",
          "focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
          valid ? "border-line" : "border-danger",
        )}
      />

      {/* At a phone width the readout takes its own line rather than being
          squeezed off the end of the row: a measurement nobody can read is
          the one thing this editor exists to show. */}
      <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
        {measure && (
          <span
            className={cn("typed tnum shrink-0", fails ? "text-danger" : "text-ink-3")}
            title={`${measure.ratio.toFixed(2)}:1 against ${measure.against}; needs ${measure.target}:1`}
          >
            {measure.ratio.toFixed(2)}:1
          </span>
        )}
        {measure && (
          <span className={cn("min-w-0 truncate text-xs leading-4", fails ? "text-danger" : "text-ink-3")}>
            {fails
              ? measure.kind === "line"
                ? `too close to ${measure.against} to see`
                : `unreadable on ${measure.against} — needs ${measure.target}:1`
              : `on ${measure.against}`}
          </span>
        )}
        {!pinned && <span className="shrink-0 text-xs text-ink-3">derived</span>}
      </span>

      {pinned && isOptional(token) && (
        <Button variant="ghost" size="xs" onClick={() => onClear(token)} title="Go back to the derived value">
          <RotateCcw aria-hidden="true" />
          Derived
        </Button>
      )}
    </div>
  );
}

const REQUIRED = new Set<string>([
  "bg",
  "surface",
  "surface-2",
  "line",
  "ink",
  "ink-2",
  "ink-3",
  "live",
  "attention",
  "danger",
  "ok",
]);

function isOptional(token: TokenName): boolean {
  return !REQUIRED.has(token);
}
