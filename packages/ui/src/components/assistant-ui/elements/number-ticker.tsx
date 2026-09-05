"use client";
/**
 * Number ticker (`elements-number-ticker`): a value whose digits roll into
 * place. In laser it is the ONE live value a minimal island shows and the
 * live counters — elapsed time, tokens — on the status line and expanded
 * islands. Tabular, `typed`, and inline: it fits a row, it does not stand as
 * a 3xl figure with a caption beneath it.
 *
 * Divergences from the registry copy: `value` is an already-formatted string
 * (the caller owns units and rounding; `duration()` and `tokens()` produce
 * them), the layout is inline, the roll takes `--motion-slow`, and the label
 * lives in the accessible name and tooltip rather than under the number.
 */
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function RollingDigit({ digit }: { digit: number }) {
  return (
    <span className="inline-flex h-[1.15em] overflow-hidden">
      <span
        className="flex flex-col transition-transform duration-(--motion-slow) ease-morph motion-reduce:transition-none"
        style={{ transform: `translateY(-${digit * 1.15}em)` }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="h-[1.15em] leading-[1.15]">
            {i}
          </span>
        ))}
      </span>
    </span>
  );
}

export interface NumberTickerProps extends Omit<ComponentProps<"span">, "children"> {
  /** Formatted text: "12.4s", "1.2k", "3/7". Digits roll; other characters stay. */
  value: string | number;
  /** What the value is, for the accessible name and tooltip: "Turn time". */
  label?: string | undefined;
}

export function NumberTicker({ value, label, className, ...props }: NumberTickerProps) {
  const text = String(value);
  return (
    <span
      data-slot="number-ticker"
      role="img"
      aria-label={label ? `${label} ${text}` : text}
      title={label ? `${label}: ${text}` : undefined}
      className={cn("inline-flex items-baseline tnum", className)}
      {...props}
    >
      {text.split("").map((char, i) =>
        /\d/.test(char) ? (
          <RollingDigit key={i} digit={Number(char)} />
        ) : (
          <span key={i} className="h-[1.15em] leading-[1.15]">
            {char}
          </span>
        ),
      )}
    </span>
  );
}
