import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import { useAuiState } from "@assistant-ui/react";
import { Check, Copy } from "lucide-react";
import { lazy, memo, Suspense } from "react";
import remarkGfm from "remark-gfm";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];

/** Highlighter code splits: it only loads once a closed fence needs color. */
const LazyHighlighter = lazy(() => import("./highlighter.js"));

/**
 * Plain, unhighlighted fence while the part streams (tokenizing partial code
 * flickers); real highlighting only after the part settles.
 */
function SyntaxHighlighter(props: SyntaxHighlighterProps) {
  const running = useAuiState((s) => s.part.status.type === "running");
  const { Pre, Code } = props.components;
  const plain = (
    <Pre>
      <Code>{props.code}</Code>
    </Pre>
  );
  if (running || !props.language) return plain;
  return (
    <Suspense fallback={plain}>
      <LazyHighlighter {...props} />
    </Suspense>
  );
}

function CodeHeader({ language, code }: CodeHeaderProps) {
  const { copied, copy } = useCopy();
  return (
    <div
      data-slot="code-header"
      className="mt-4 flex h-8 items-center justify-between rounded-t-lg border border-b-0 border-line bg-surface-2 pe-1 ps-3"
    >
      <span className="eyebrow">{language || "code"}</span>
      <TooltipIconButton
        tooltip={copied ? "Copied" : "Copy code"}
        size="icon-xs"
        onClick={() => void copy(code)}
        className={cn(copied && "text-ok hover:text-ok")}
      >
        {copied ? <Check /> : <Copy />}
      </TooltipIconButton>
    </div>
  );
}

const components = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1 className={cn("mt-6 mb-2 text-xl font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn("mt-6 mb-2 text-lg font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn("mt-5 mb-1.5 text-md font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cn("mt-4 mb-1 text-base font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 className={cn("mt-4 mb-1 text-sm font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h6: ({ className, ...props }) => (
    <h6 className={cn("mt-4 mb-1 eyebrow first:mt-0 last:mb-0", className)} {...props} />
  ),
  p: ({ className, ...props }) => <p className={cn("my-3 first:mt-0 last:mb-0", className)} {...props} />,
  a: ({ className, ...props }) => (
    <a
      className={cn("text-live underline decoration-live/40 underline-offset-[3px] hover:decoration-live", className)}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-3 border-s-2 border-line ps-4 text-ink-2", className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-3 list-disc ps-6 marker:text-ink-3 [&>li]:mt-1", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-3 list-decimal ps-6 marker:text-ink-3 marker:tnum [&>li]:mt-1", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("ps-1", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-6 border-line", className)} {...props} />,
  table: ({ className, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border-b border-line px-3 py-1.5 text-start font-medium text-ink-2 [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "border-b border-line px-3 py-1.5 align-top [[align=center]]:text-center [[align=right]]:text-right [[align=right]]:tnum",
        className,
      )}
      {...props}
    />
  ),
  strong: ({ className, ...props }) => <strong className={cn("font-semibold text-ink", className)} {...props} />,
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "mb-4 overflow-x-auto rounded-b-lg border border-line bg-surface-2 font-mono text-xs leading-[18px] text-ink last:mb-0 [&>code]:block [&>code]:p-3.5",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isBlock && "rounded-[5px] border border-line/70 bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-ink",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
  SyntaxHighlighter,
});

/**
 * Transcript prose: Host Grotesk 15/24 at max 72ch, never raw HTML
 * (AGENTS.md inv. 9 — no rehype-raw). The streaming caret rides on the last
 * block while the part reports `running`.
 */
function MarkdownTextImpl({ className }: { className?: string | undefined }) {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      components={components}
      smooth={false}
      defer
      className={cn(
        "piorbit-md max-w-[72ch] text-md break-words text-ink",
        "[&[data-status=running]>*:last-child]:caret",
        className,
      )}
    />
  );
}

export const MarkdownText = memo(MarkdownTextImpl);
