"use client";
/**
 * `markdown-text` (assistant-ui registry), restyled: the transcript renderer
 * (docs/ux-elements.md "Markdown text"). Also the document-panel body for
 * markdown, through `TextMessagePartProvider` (see preview/MarkdownPreview).
 *
 * What is the registry's: the primitive, the memoized component map, the
 * code header with a copy control, `defer` for large streaming messages.
 * What is laser's, each on purpose:
 *   - Every class reads a token; prose is `text-base` at the shared prose measure, typed things
 *     are mono at the 12px floor, headings are the type scale.
 *   - **Never raw HTML** (AGENTS.md invariant 9): remark-gfm and no
 *     rehype-raw, so an agent cannot inject markup. KaTeX output is built by
 *     the math renderer from the formula, not copied from the message.
 *   - Fences highlight through the Shiki element only once the part settles;
 *     a `mermaid` fence draws through the sanitizing Mermaid element.
 *   - Math via remark-math + rehype-katex, with the delimiter normalizer and
 *     the currency guard the markdown package ships — `$5` stays a price.
 *   - GFM footnote references draw as citation chips, so `[^1]` in an answer
 *     from web-access reads like a citation rather than a superscript link.
 *   - The streaming caret rides on the last block while the part runs.
 *   - `dot.css` is not imported: the caret is the streaming indicator here.
 */
import "katex/dist/katex.min.css";

import {
  MarkdownTextPrimitive,
  escapeCurrencyDollars,
  normalizeMathDelimiters,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import { Check, Copy } from "lucide-react";
import { memo, useMemo, useRef, type FC } from "react";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";
import { SourceFileLink } from "@/components/ui/source-file-link";
import { markdownUrl } from "@/lib/file-links";

import { citationChip } from "./inline-citation.js";
import { MermaidDiagram } from "./mermaid-diagram.aui.js";
import { SyntaxHighlighter } from "./shiki-highlighter.aui.js";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

/** `\(x\)` → `$x$`, `\[…\]` → `$$…$$`, and `$5` stays money. Code spans are left alone. */
const preprocess = (text: string): string => escapeCurrencyDollars(normalizeMathDelimiters(text));

type Components = Parameters<typeof memoizeMarkdownComponents>[0];

export interface MarkdownTextProps {
  className?: string | undefined;
  /** Per-render overrides, merged over the default map. */
  components?: Components | undefined;
}

const useShallowStable = <T extends Record<string, unknown> | undefined>(value: T): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

function CodeHeader({ language, code }: CodeHeaderProps) {
  const { copied, copy } = useCopy();
  return (
    <div
      data-slot="code-header"
      className="mt-3 flex h-8 items-center justify-between rounded-t-lg border border-b-0 border-line bg-surface-2 pe-1 ps-3"
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

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1 className={cn("mt-5 mb-2 text-xl font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn("mt-5 mb-2 text-lg font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn("mt-4 mb-1.5 text-md font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cn("mt-3 mb-1 text-base font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 className={cn("mt-3 mb-1 text-sm font-semibold text-ink first:mt-0 last:mb-0", className)} {...props} />
  ),
  h6: ({ className, ...props }) => <h6 className={cn("mt-3 mb-1 eyebrow first:mt-0 last:mb-0", className)} {...props} />,
  p: ({ className, ...props }) => <p className={cn("my-2 first:mt-0 last:mb-0", className)} {...props} />,
  a: ({ className, ...props }) => {
    // GFM footnote references (`[^1]`) are the citations a transcript actually
    // carries: draw them as the citation chip, in-page, not as external links.
    if ("data-footnote-ref" in props) {
      return <a className={cn(citationChip, className)} {...props} />;
    }
    return (
      <SourceFileLink
        className={cn("text-live underline decoration-live/40 underline-offset-[3px] hover:decoration-live", className)}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      />
    );
  },
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-2 border-s-2 border-line ps-3 text-ink-2", className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-2 list-disc ps-5 marker:text-ink-3 [&>li]:mt-1", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-2 list-decimal ps-5 marker:text-ink-3 marker:tnum [&>li]:mt-1", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("ps-1 [&>input]:me-1.5", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-5 border-line", className)} {...props} />,
  table: ({ className, ...props }) => (
    <div className="my-2 overflow-x-auto">
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
  del: ({ className, ...props }) => <del className={cn("text-ink-3", className)} {...props} />,
  sup: ({ className, ...props }) => <sup className={cn("align-baseline", className)} {...props} />,
  section: ({ className, ...props }) => (
    <section
      className={cn(
        // The footnotes block: a hairline above, then the list in secondary ink at 13px.
        "[&[data-footnotes]]:mt-5 [&[data-footnotes]]:border-t [&[data-footnotes]]:border-line [&[data-footnotes]]:pt-2 [&[data-footnotes]]:text-sm [&[data-footnotes]]:text-ink-2 [&[data-footnotes]>h2]:sr-only",
        className,
      )}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "mb-3 overflow-x-auto rounded-b-lg border border-line bg-surface-2 font-mono text-xs leading-sm text-ink last:mb-0 [&>code]:block [&>code]:p-3",
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
          !isBlock && "rounded-md border border-line/70 bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-ink",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
  SyntaxHighlighter,
});

const componentsByLanguage = {
  mermaid: { SyntaxHighlighter: MermaidDiagram },
};

/**
 * Transcript prose at the shared reading measure, never raw HTML. The streaming caret rides on
 * the last block while the part reports `running`.
 */
const MarkdownTextImpl: FC<MarkdownTextProps> = ({ className, components }) => {
  const stableComponents = useShallowStable(components);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return { ...defaultComponents, ...memoizeMarkdownComponents(stableComponents) };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      preprocess={preprocess}
      urlTransform={markdownUrl}
      components={markdownComponents}
      componentsByLanguage={componentsByLanguage}
      smooth={false}
      defer
      className={cn("md-body max-w-(--measure-prose) text-base break-words text-ink", "[&[data-status=running]>*:last-child]:caret", className)}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
