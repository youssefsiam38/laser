"use client";
/**
 * Composer trigger popover — the picker behind `/` and `@` in the composer
 * (docs/ux-elements.md "AUI-connected"). Installed from
 * `composer-trigger-popover`, with one shared interaction layer around the
 * registry's selection, categories and ARIA. Focus stays in the composer.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ComponentPropsWithoutRef, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, SparklesIcon, XIcon, ExternalLinkIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type IconComponent = FC<{ className?: string }>;

type DirectiveBehaviorProps = {
  /** Formatter used to serialize the selected item into composer text. */
  formatter?: Unstable_DirectiveFormatter | undefined;
  /** Called after the directive text has been inserted into the composer. */
  onInserted?: ((item: Unstable_TriggerItem) => void) | undefined;
};

type ActionBehaviorProps = {
  /** Formatter used to serialize the audit-trail chip (when `removeOnExecute` is false). */
  formatter?: Unstable_DirectiveFormatter | undefined;
  /** Invoked with the selected item at the moment of selection. */
  onExecute: (item: Unstable_TriggerItem) => void;
  /** If `true`, strip the trigger text from the composer after executing. @default false */
  removeOnExecute?: boolean | undefined;
};

type ComposerTriggerPopoverBaseProps = Omit<
  ComponentPropsWithoutRef<typeof ComposerPrimitive.Unstable_TriggerPopover>,
  "children"
> & {
  /**
   * Maps icon keys to components. Items look up via `item.metadata?.icon`
   * (string); categories look up via their `id`.
   */
  iconMap?: Record<string, IconComponent>;
  /** Fallback icon when no entry in `iconMap` matches. */
  fallbackIcon?: IconComponent;
  /** Label shown on the back button. @default "Back" */
  backLabel?: string;
  /** Label shown when no categories are available. @default "No items available" */
  emptyCategoriesLabel?: string;
  /** Label shown when no items match. @default "No matching items" */
  emptyItemsLabel?: string;
  /** Label shown while an async adapter is resolving items. @default "Loading…" */
  loadingLabel?: string;
  title?: string;
  notice?: ReactNode;
  onQueryChange?: ((query: string) => void) | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
};

const optionClass = "group flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-start text-sm text-ink outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 data-[highlighted]:bg-surface-2";

/** Only scroll the results, never the conversation or the page behind them. */
export function revealPickerOption(list: HTMLElement, option: HTMLElement): void {
  const bounds = list.getBoundingClientRect();
  const row = option.getBoundingClientRect();
  if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
  else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
}

function MatchLabel({ label, query }: { label: string; query: string }) {
  let next = 0;
  const needle = query.toLocaleLowerCase();
  return <>{Array.from(label).map((char, index) => {
    const matched = next < needle.length && char.toLocaleLowerCase() === needle[next];
    if (matched) next += 1;
    return matched ? <span key={index} className="font-semibold text-live">{char}</span> : char;
  })}</>;
}

function SourceFileDetails({ item, onDetails }: { item: Unstable_TriggerItem; onDetails?: (() => void) | undefined }) {
  const path = String(item.metadata?.filePath ?? "");
  const desktop = (globalThis as typeof globalThis & { desktop?: { openSourceFile?: (path: string) => Promise<{ opened: boolean; reason?: string }> } }).desktop;
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const open = async () => {
    if (pending) return;
    setPending(true);
    try {
      if (desktop?.openSourceFile) {
        const result = await desktop.openSourceFile(path);
        setMessage(result.opened ? "Opened in your default text editor." : result.reason ?? "Couldn’t open the file. Check your default text editor.");
      } else {
        await navigator.clipboard.writeText(path);
        setMessage("Path copied. Open it in your editor on the project computer.");
      }
    } catch { setMessage("Couldn’t open or copy the path. Select the source path to copy it manually."); }
    finally { setPending(false); }
  };
  return <div data-slot="composer-picker-source" className="shrink-0 px-3 py-2 hairline-t">
    {item.description && onDetails && <button type="button" data-picker-details onClick={onDetails} className="mb-1 rounded-md text-xs text-ink underline underline-offset-2 focus-visible:outline focus-visible:outline-live pointer-coarse:min-h-11">Read full description</button>}
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs text-ink-3 select-text" title={path}>{path}</span>
      <button data-picker-open-source type="button" disabled={pending} onClick={() => void open()} title={desktop?.openSourceFile ? 'Uses your system’s default application for Markdown. Alt+O' : 'Copy this source path. Alt+O'} className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-ink hover:bg-surface-2 focus-visible:outline focus-visible:outline-live disabled:opacity-50 pointer-coarse:min-h-11">
        {desktop?.openSourceFile ? <ExternalLinkIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
        {pending ? 'Opening…' : desktop?.openSourceFile ? 'Open source file' : 'Copy source path'}
      </button>
    </div>
    {message && <p role="status" className="mt-1 text-xs text-ink-2">{message}</p>}
  </div>;
}

function PickerSurface({ title, notice, onQueryChange, onOpenChange, children }: {
  title: string; notice: ReactNode; onQueryChange: ((query: string) => void) | undefined; onOpenChange: ((open: boolean) => void) | undefined; children: ReactNode;
}) {
  const scope = unstable_useTriggerPopoverScopeContext();
  const listRef = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState(false);
  const detailsRef = useRef(details);
  detailsRef.current = details;
  useEffect(() => setDetails(false), [scope.open, scope.query, scope.highlightedItemId]);
  const latest = useRef(scope);
  useLayoutEffect(() => { latest.current = scope; });
  useEffect(() => { if (scope.open) onQueryChange?.(scope.query); }, [scope.open, scope.query, onQueryChange]);
  useEffect(() => { onOpenChange?.(scope.open); }, [scope.open, onOpenChange]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!scope.open || !list) return;
    if (details) { list.scrollTop = 0; return; }
    const option = scope.highlightedItemId ? document.getElementById(scope.highlightedItemId) : null;
    if (option) revealPickerOption(list, option);
  }, [details, scope.open, scope.highlightedItemId, scope.query, scope.items, scope.categories]);

  useEffect(() => {
    const list = listRef.current;
    const popup = list?.closest<HTMLElement>('[data-slot="composer-trigger-popover"]');
    const input = popup?.closest('form')?.querySelector('textarea');
    if (!scope.open || !popup || !input) return;
    const doc = popup.ownerDocument;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !popup.contains(event.target) && event.target !== input) latest.current.close();
    };
    const blur = () => latest.current.close();
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.target !== input || !latest.current.open) return;
      const state = latest.current;
      // IME owns its Enter/arrows, including WebKit's legacy composition code.
      if (event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
      if (detailsRef.current) {
        // Reading details must not execute the hidden selected result. Tab
        // follows normal focus traversal; paging scrolls the description.
        if (event.key === 'Tab') { event.stopPropagation(); return; }
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return; }
        if (event.key === 'PageDown' || event.key === 'PageUp') {
          list!.scrollTop += (event.key === 'PageDown' ? 1 : -1) * list!.clientHeight;
          event.preventDefault(); event.stopPropagation(); return;
        }
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'o') {
        const action = popup.querySelector<HTMLButtonElement>('[data-picker-open-source]');
        if (action) { event.preventDefault(); event.stopPropagation(); action.click(); }
        return;
      }
      if (event.key === 'Tab' && (event.shiftKey || state.items.length + state.categories.length === 0)) {
        state.close(); event.stopPropagation(); return; // normal focus traversal
      }
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        const rows = [...list!.querySelectorAll<HTMLElement>('[role="option"]')];
        const height = rows[state.highlightedIndex]?.getBoundingClientRect().height || list!.clientHeight;
        const step = Math.max(1, Math.floor(list!.clientHeight / height));
        state.highlightIndex(Math.max(0, Math.min(rows.length - 1, state.highlightedIndex + (event.key === 'PageDown' ? step : -step))));
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (state.handleKeyDown(event)) event.stopPropagation();
    };
    // The primitive handles Escape on document capture. The description is
    // a nested view, so take its Back key first, without closing the picker.
    const backFromDetails = (event: globalThis.KeyboardEvent) => {
      if (!detailsRef.current || event.key !== 'Escape' || event.isComposing) return;
      if (event.target !== input && !(event.target instanceof Node && popup.contains(event.target))) return;
      event.preventDefault(); event.stopPropagation(); setDetails(false); input.focus();
    };
    const resize = () => {
      const viewport = window.visualViewport;
      const margin = parseFloat(getComputedStyle(popup).marginBottom) || 0;
      let top = viewport?.offsetTop ?? 0;
      // Beam and sheets clip their children. Available space is inside that
      // surface, not all the way to the top of the browser window.
      for (let parent = popup.parentElement; parent; parent = parent.parentElement) {
        if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(parent).overflowY)) top = Math.max(top, parent.getBoundingClientRect().top);
      }
      const available = Math.max(0, popup.getBoundingClientRect().bottom - top - margin);
      popup.style.setProperty('--composer-picker-height', `${available}px`);
      popup.dataset.compact = String(available < margin * 40);
      const active = latest.current.highlightedItemId ? doc.getElementById(latest.current.highlightedItemId) : null;
      if (active && list) revealPickerOption(list, active);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(input);
    observer.observe(list!);
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('focusin', outside, true);
    input.addEventListener('keydown', key, true);
    window.addEventListener('keydown', backFromDetails, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    return () => {
      observer.disconnect();
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('focusin', outside, true);
      input.removeEventListener('keydown', key, true);
      window.removeEventListener('keydown', backFromDetails, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, [scope.open]);
  if (!scope.open) return null;
  const count = scope.isSearchMode || scope.activeCategoryId ? scope.items.length : scope.categories.length;
  const selected = scope.items[scope.highlightedIndex];
  return <>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2 hairline-b">
      {details ? <button type="button" aria-label="Back to results" onClick={() => setDetails(false)} className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 pointer-coarse:size-11"><ChevronLeftIcon className="size-4" /></button> : <SearchIcon aria-hidden className="size-4 shrink-0 text-ink-3" />}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{details ? selected?.label : title}</span>
      <span role="status" aria-live="polite" className="text-xs tabular-nums text-ink-3">{scope.isLoading ? 'Searching…' : `${count} ${count === 1 ? 'result' : 'results'}`}</span>
      <button type="button" tabIndex={-1} aria-label="Close suggestions" onClick={() => scope.close()} className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink pointer-coarse:size-11"><XIcon aria-hidden className="size-4" /></button>
    </div>
    <div ref={listRef} data-slot="composer-picker-results" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1 [overflow-anchor:none]" aria-busy={scope.isLoading}>
      {details ? <p data-slot="composer-picker-description" className="whitespace-pre-wrap break-words px-3 py-2 text-sm leading-sm text-ink-2">{selected?.description}</p> : children}
    </div>
    {selected && typeof selected.metadata?.filePath === 'string' && <SourceFileDetails key={selected.id} item={selected} onDetails={details ? undefined : () => setDetails(true)} />}
    {notice && <div className="shrink-0 px-3 py-2 text-xs text-ink-2 hairline-t">{notice}</div>}
    <div aria-hidden className="flex shrink-0 items-center gap-3 px-3 py-2 text-xs text-ink-3 hairline-t pointer-coarse:hidden group-data-[compact=true]/picker:hidden">{details ? <span>Esc back to results</span> : <><span>↑ ↓ navigate</span><span>Tab / ↵ select</span><span className="ms-auto">Esc close</span></>}</div>
  </>;
}

type ComposerTriggerPopoverProps = ComposerTriggerPopoverBaseProps &
  (
    | {
        /** Insert-directive behavior. */
        directive: DirectiveBehaviorProps;
        action?: never;
      }
    | {
        /** Action behavior. */
        action: ActionBehaviorProps;
        directive?: never;
      }
  );

function resolveIcon(
  iconKey: string | undefined,
  iconMap: Record<string, IconComponent> | undefined,
  fallback: IconComponent,
): IconComponent {
  if (iconKey && iconMap?.[iconKey]) return iconMap[iconKey]!;
  return fallback;
}

type CategoriesProps = {
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  emptyLabel: string;
};

const Categories: FC<CategoriesProps> = ({
  iconMap,
  fallbackIcon,
  emptyLabel,
}) => (
  <ComposerPrimitive.Unstable_TriggerPopoverCategories>
    {(categories) => (
      <div
        data-slot="composer-trigger-popover-categories"
        className="flex flex-col py-1"
      >
        {categories.map((cat) => {
          const Icon = resolveIcon(cat.id, iconMap, fallbackIcon);
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
              tabIndex={-1}
              className={optionClass}
            >
              <span className="flex items-center gap-2">
                <Icon className="size-4 text-ink-3" />
                {cat.label}
              </span>
              <ChevronRightIcon className="size-4 text-ink-3" />
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          );
        })}
        {categories.length === 0 && (
          <div className="px-3 py-2 text-sm text-ink-3">
            {emptyLabel}
          </div>
        )}
      </div>
    )}
  </ComposerPrimitive.Unstable_TriggerPopoverCategories>
);

type ItemsProps = {
  iconMap: Record<string, IconComponent> | undefined;
  fallbackIcon: IconComponent;
  backLabel: string;
  emptyLabel: string;
  loadingLabel: string;
};

const Items: FC<ItemsProps> = ({
  iconMap,
  fallbackIcon,
  backLabel,
  emptyLabel,
  loadingLabel,
}) => {
  const { isLoading, query } = unstable_useTriggerPopoverScopeContext();
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items) => (
        <div
          data-slot="composer-trigger-popover-items"
          className="flex flex-col"
        >
          <ComposerPrimitive.Unstable_TriggerPopoverBack className="eyebrow flex cursor-pointer items-center gap-1.5 px-3 py-2 transition-colors duration-(--motion-instant) hairline-b hover:bg-surface-2">
            <ChevronLeftIcon className="size-3.5" />
            {backLabel}
          </ComposerPrimitive.Unstable_TriggerPopoverBack>

          <div className="py-1">
            {items.map((item, index) => {
              const iconKey =
                typeof item.metadata?.icon === "string"
                  ? item.metadata.icon
                  : undefined;
              const Icon = resolveIcon(iconKey, iconMap, fallbackIcon);
              return (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  tabIndex={-1}
                  aria-label={item.label}
                  className={optionClass}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-ink-3 group-data-[highlighted]:text-ink" />
                  <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium" title={item.label}>
                    <MatchLabel label={item.type === 'file' ? item.label.slice(item.label.lastIndexOf('/') + 1) : item.label} query={item.type === 'file' ? query.slice(query.lastIndexOf('/') + 1) : query} />
                  </span>
                  {item.type === 'file' && <span className="mt-0.5 block truncate text-xs text-ink-3" title={item.label}><MatchLabel label={item.label} query={query} /></span>}
                  {item.description && (
                    // One preview line; the full description has its own
                    // scrollable view instead of competing with the results.
                    <span data-slot="composer-picker-preview" className="mt-0.5 line-clamp-1 break-words text-xs leading-xs text-ink-2" title={item.description}>
                      {item.description}
                    </span>
                  )}
                  </span>
                  {typeof item.metadata?.kind === 'string' && <span className="shrink-0 text-xs text-ink-3">{item.metadata.kind}</span>}
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              );
            })}
            {items.length === 0 && (
              <div className="px-3 py-5 text-sm text-ink-2">
                {isLoading ? loadingLabel : query ? 'No matches. Try a shorter name or path.' : emptyLabel}
              </div>
            )}
          </div>
        </div>
      )}
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  );
};

/**
 * Pre-built popover UI for a trigger-driven picker (mentions, slash commands, etc).
 * Pass exactly one of `directive` (inserts a chip) or `action` (fires a handler).
 */
const ComposerTriggerPopoverImpl: FC<ComposerTriggerPopoverProps> = ({
  iconMap,
  fallbackIcon = SparklesIcon,
  backLabel = "Back",
  emptyCategoriesLabel = "No items available",
  emptyItemsLabel = "No matching items",
  loadingLabel = "Loading…",
  title = "Suggestions",
  notice,
  onQueryChange,
  onOpenChange,
  className,
  directive,
  action,
  ...props
}) => {
  const warnedRef = useRef(false);
  if (
    process.env.NODE_ENV !== "production" &&
    !warnedRef.current &&
    Boolean(directive) === Boolean(action)
  ) {
    warnedRef.current = true;
    console.warn(
      "[assistant-ui] ComposerTriggerPopover requires exactly one of `directive` or `action` props.",
    );
  }

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      data-slot="composer-trigger-popover"
      className={cn(
        "group/picker absolute start-0 bottom-full z-50 mb-2 flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-float",
        className,
      )}
      aria-label={title}
      style={{ height: 'min(calc(var(--spacing) * 112), var(--composer-picker-height, 60dvh))' }}
      onMouseDown={(event) => event.preventDefault()}
      {...props}
    >
      {directive ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Directive
          formatter={directive.formatter ?? unstable_defaultDirectiveFormatter}
          onInserted={directive.onInserted}
        />
      ) : action ? (
        <ComposerPrimitive.Unstable_TriggerPopover.Action
          formatter={action.formatter ?? unstable_defaultDirectiveFormatter}
          onExecute={action.onExecute}
          removeOnExecute={action.removeOnExecute}
        />
      ) : null}
      <PickerSurface title={title} notice={notice} onQueryChange={onQueryChange} onOpenChange={onOpenChange}>
      <Categories
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        emptyLabel={emptyCategoriesLabel}
      />
      <Items
        iconMap={iconMap}
        fallbackIcon={fallbackIcon}
        backLabel={backLabel}
        emptyLabel={emptyItemsLabel}
        loadingLabel={loadingLabel}
      />
      </PickerSurface>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
ComposerTriggerPopoverImpl.displayName = "ComposerTriggerPopover";

export const ComposerTriggerPopover = memo(
  ComposerTriggerPopoverImpl,
) as FC<ComposerTriggerPopoverProps>;
