"use client";
/**
 * Model picker — the composer's model control (docs/ux-elements.md
 * "Composer" → Models; "Beyond the published catalog" → `model-picker`).
 * Installed from `elements-model-selector`, the props-driven core behind the
 * runtime-bound `model-selector.aui`, and restyled to DESIGN.md tokens.
 *
 * Why this one and not `model-selector.aui`: the `.aui` file's only addition
 * is registering the pick with assistant-ui's ModelContext, which our
 * runtime never reads — the model is set on the Pi session through
 * `pi/model/set`. The props-driven core fits a host-supplied list exactly,
 * so it stays and the `.aui` wrapper was not installed.
 *
 * Divergences from the registry copy:
 *   - `ModelSelectorEffort` is gone. Pi's thinking level is a session
 *     setting, not a per-model one, and the composer has its own control for
 *     it (`reasoning-effort`). Two places to set one value is a bug.
 *   - Every colour, radius and size reads a token.
 *   - `SessionModelSelector` binds the picker to the open session: models
 *     load from `pi/model/list` when the popover opens, group by provider,
 *     carry the configured provider's mark, and a pick calls `pi/model/set`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { ModelRef, SettingChange } from "@lasercode/protocol";
import { CheckIcon, ChevronDownIcon, ChevronsUpDown, Cpu } from "lucide-react";
import { narrowToConnected } from "./connected-models.js";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { tokens } from "@/format";
import { useLaserStable, useLaserState, useSessionMeta } from "@/runtime";
import { useSessionPreparation } from "@/components/thread/session-preparation";

import { ErrorState } from "./error-state.js";
import { GenerationLoader } from "./loading-state.js";
import { ProviderLogo, providerDisplayName } from "./logos.js";
import { invalidateThinkingCatalog } from "./reasoning-effort.js";

export type ModelOption = {
  id: string;
  name: string;
  provider?: string;
  /** Routing provider shown at the end of a model row. */
  providerTag?: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Extra terms matched by ModelSelector.Search, in addition to id and name. */
  keywords?: readonly string[];
};

function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop: T | undefined;
  defaultProp: T | undefined;
  onChange: ((next: T) => void) | undefined;
}) {
  const [internal, setInternal] = useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : internal;
  // Read onChange through a ref so inline callbacks don't recreate the setter
  // (and with it the memoized context value) every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChangeRef.current?.(next);
    },
    [isControlled],
  );
  return [value, setValue] as const;
}

type ModelSelectorContextValue = {
  models: readonly ModelOption[];
  value: string | undefined;
  setValue: (value: string) => void;
  /** The model matching `value`, derived once for all sub-components. */
  selectedModel: ModelOption | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const ModelSelectorContext = createContext<ModelSelectorContextValue | null>(
  null,
);

export function useModelSelectorContext() {
  const ctx = useContext(ModelSelectorContext);
  if (!ctx) {
    throw new Error(
      "ModelSelector sub-components must be used within ModelSelector.Root",
    );
  }
  return ctx;
}

export type ModelSelectorRootProps = {
  models: readonly ModelOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

function ModelSelectorRoot({
  models,
  value: valueProp,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen,
  onOpenChange,
  children,
}: ModelSelectorRootProps) {
  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? models[0]?.id,
    onChange: onValueChange,
  });
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });

  const selectedModel = models.find((m) => m.id === value);
  const isOpen = open ?? false;
  const contextValue = useMemo(
    () => ({
      models,
      value,
      setValue,
      selectedModel,
      open: isOpen,
      setOpen,
    }),
    [models, value, setValue, selectedModel, isOpen, setOpen],
  );

  return (
    <ModelSelectorContext.Provider value={contextValue}>
      <Popover open={isOpen} onOpenChange={setOpen}>
        {children}
      </Popover>
    </ModelSelectorContext.Provider>
  );
}

export const modelSelectorTriggerVariants = cva(
  "flex w-fit items-center justify-between gap-2 overflow-hidden rounded-md text-sm whitespace-nowrap outline-none transition-[background-color,color] duration-(--motion-instant) focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        outline:
          "border border-line bg-surface text-ink hover:bg-surface-2",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink data-[state=open]:bg-surface-2 data-[state=open]:text-ink",
        muted: "bg-surface-2 text-ink hover:bg-[color-mix(in_oklab,var(--surface-2)_82%,var(--ink))]",
      },
      size: {
        default: "h-8 px-3 py-2",
        sm: "h-7 rounded-md px-2 text-xs",
        lg: "h-9 px-4 py-2.5",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

export type ModelSelectorTriggerProps = ComponentPropsWithoutRef<
  typeof PopoverTrigger
> &
  VariantProps<typeof modelSelectorTriggerVariants>;

function ModelSelectorTrigger({
  className,
  variant,
  size,
  children,
  onKeyDown,
  ...props
}: ModelSelectorTriggerProps) {
  const { setOpen } = useModelSelectorContext();

  return (
    <PopoverTrigger
      data-slot="model-selector-trigger"
      data-variant={variant ?? "outline"}
      data-size={size ?? "default"}
      role="combobox"
      aria-haspopup="listbox"
      className={cn(modelSelectorTriggerVariants({ variant, size }), className)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        // ARIA combobox: arrows open the listbox from a focused trigger.
        // Popover leaves this to the consumer.
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setOpen(true);
        }
      }}
      {...props}
    >
      {children ?? <ModelSelectorValue />}
      <ChevronDownIcon aria-hidden="true" className="size-3 text-ink-3" />
    </PopoverTrigger>
  );
}

export type ModelSelectorValueProps = {
  placeholder?: ReactNode;
  className?: string;
};

function ModelIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ModelSelectorValue({ placeholder = "Select model", className }: ModelSelectorValueProps) {
  const { selectedModel } = useModelSelectorContext();

  if (!selectedModel) {
    return (
      <span
        data-slot="model-selector-value"
        className={cn("text-ink-3", className)}
      >
        {placeholder}
      </span>
    );
  }

  return (
    <span
      data-slot="model-selector-value"
      className={cn("flex min-w-0 items-center gap-2", className)}
    >
      {selectedModel.icon && <ModelIcon>{selectedModel.icon}</ModelIcon>}
      <span className="truncate font-medium" title={selectedModel.name}>
        {selectedModel.name}
      </span>
    </span>
  );
}

export type ModelSelectorContentProps = Omit<
  ComponentPropsWithoutRef<typeof PopoverContent>,
  "side"
> & {
  /**
   * Preferred side for the initial placement. Once the popover is open, the
   * rendered side takes over until it closes, so the popup does not jump
   * between sides while filtering resizes the list.
   */
  side?: ComponentPropsWithoutRef<typeof PopoverContent>["side"];
  searchable?: boolean;
};

// The popover re-evaluates collision flipping whenever the popup resizes, so
// filtering the list down flips the popup back to the preferred side
// mid-interaction. Feed the rendered side back as the preferred side, making
// the popup keep its side until it no longer fits.
function useLazyFlipSide(): {
  side: ModelSelectorContentProps["side"];
  popupRef: (node: HTMLDivElement | null) => void;
} {
  const [side, setSide] = useState<ModelSelectorContentProps["side"]>();
  const observerRef = useRef<MutationObserver | null>(null);
  const popupRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      setSide(undefined);
      return;
    }
    const sync = () => {
      const rendered = node.getAttribute("data-side");
      if (rendered) setSide(rendered as ModelSelectorContentProps["side"]);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(node, {
      attributes: true,
      attributeFilter: ["data-side"],
    });
    observerRef.current = observer;
  }, []);
  return { side, popupRef };
}

/**
 * Hidden input that anchors cmdk's keyboard navigation, keeping the list
 * keyboard-operable without a visible search box. ModelSelectorContent renders
 * one automatically when unfiltered.
 */
function ModelSelectorFocusAnchor() {
  return (
    <div className="sr-only">
      <CommandInput readOnly aria-label="Model" />
    </div>
  );
}

function ModelSelectorContent({
  className,
  align = "start",
  side,
  sideOffset = 6,
  searchable,
  children,
  onOpenAutoFocus,
  ...props
}: ModelSelectorContentProps) {
  const { value } = useModelSelectorContext();
  const { side: renderedSide, popupRef } = useLazyFlipSide();
  // `popupRef` is a callback ref (it watches `data-side`); the node is kept
  // here as well so the open handler below can reach into the panel.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setContent = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      popupRef(node);
    },
    [popupRef],
  );
  const unfiltered =
    searchable === false || (!searchable && children === undefined);
  // Custom unfiltered menus can supply their own visible CommandInput. Adding
  // the hidden keyboard anchor as well gives cmdk two inputs; after the first
  // character it moves focus to the hidden one. The anchor is only needed by
  // the stock, input-less list.
  const needsFocusAnchor = unfiltered && children === undefined;

  /**
   * Opening a model picker puts the caret in its search box, wherever the
   * picker is: the person opened it to find a model, and every one of these
   * menus is a list long enough to type through. Radix would otherwise focus
   * the panel, leaving the first keystroke to go nowhere.
   *
   * The provider filter inside the provider/model menu is its own nested
   * popover with its own input, so this only ever finds the model search.
   * A menu with no search box keeps Radix's own behaviour (the stock list
   * has a hidden keyboard anchor for exactly that).
   */
  const focusSearch = (event: Event) => {
    onOpenAutoFocus?.(event as Parameters<NonNullable<ModelSelectorContentProps["onOpenAutoFocus"]>>[0]);
    if (event.defaultPrevented) return;
    const search = contentRef.current?.querySelector<HTMLInputElement>('[data-slot="model-selector-search"]');
    if (!search) return;
    event.preventDefault();
    search.focus();
  };

  return (
    <PopoverContent
      ref={setContent}
      data-slot="model-selector-content"
      align={align}
      side={renderedSide ?? side ?? "bottom"}
      sideOffset={sideOffset}
      onOpenAutoFocus={focusSearch}
      className={cn(
        "w-80 min-w-(--radix-popover-trigger-width) gap-0 overflow-hidden rounded-xl p-0",
        className,
      )}
      {...props}
    >
      <Command
        className="bg-transparent"
        shouldFilter={!unfiltered}
        {...(value !== undefined ? { defaultValue: value } : {})}
      >
        {needsFocusAnchor && <ModelSelectorFocusAnchor />}
        {children ?? (
          <>
            {searchable && <ModelSelectorSearch />}
            <ModelSelectorList />
          </>
        )}
      </Command>
    </PopoverContent>
  );
}

export type ModelSelectorSearchProps = ComponentPropsWithoutRef<
  typeof CommandInput
>;

function ModelSelectorSearch({
  placeholder = "Search models...",
  ...props
}: ModelSelectorSearchProps) {
  return (
    <CommandInput
      data-slot="model-selector-search"
      placeholder={placeholder}
      {...props}
    />
  );
}

export type ModelSelectorListProps = ComponentPropsWithoutRef<
  typeof CommandList
>;

function ModelSelectorList({
  className,
  children,
  ...props
}: ModelSelectorListProps) {
  const { models } = useModelSelectorContext();

  return (
    <CommandList
      data-slot="model-selector-list"
      className={cn(
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <ModelSelectorEmpty />
          <CommandGroup>
            {models.map((model) => (
              <ModelSelectorItem key={model.id} model={model} />
            ))}
          </CommandGroup>
        </>
      )}
    </CommandList>
  );
}

export type ModelSelectorEmptyProps = ComponentPropsWithoutRef<
  typeof CommandEmpty
>;

function ModelSelectorEmpty({ children, ...props }: ModelSelectorEmptyProps) {
  return (
    <CommandEmpty data-slot="model-selector-empty" {...props}>
      {children ?? "No models found."}
    </CommandEmpty>
  );
}

export type ModelSelectorGroupProps = ComponentPropsWithoutRef<
  typeof CommandGroup
>;

function ModelSelectorGroup(props: ModelSelectorGroupProps) {
  return <CommandGroup data-slot="model-selector-group" {...props} />;
}

export type ModelSelectorSeparatorProps = ComponentPropsWithoutRef<
  typeof CommandSeparator
>;

function ModelSelectorSeparator(props: ModelSelectorSeparatorProps) {
  return <CommandSeparator data-slot="model-selector-separator" {...props} />;
}

export type ModelSelectorItemProps = Omit<
  ComponentPropsWithoutRef<typeof CommandItem>,
  "value"
> & {
  model: ModelOption;
};

function ModelSelectorItem({
  model,
  className,
  children,
  onSelect,
  ...props
}: ModelSelectorItemProps) {
  const { value, setValue, setOpen } = useModelSelectorContext();
  const isSelected = value === model.id;

  return (
    <CommandItem
      data-slot="model-selector-item"
      value={model.id}
      keywords={[model.name, ...(model.keywords ?? [])]}
      {...(model.disabled ? { disabled: true } : undefined)}
      onSelect={(selectedValue) => {
        setValue(model.id);
        setOpen(false);
        onSelect?.(selectedValue);
      }}
      className={cn(
        "relative items-start gap-2.5 rounded-md py-1.5 px-3 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {model.icon && (
            <ModelIcon className="mt-0.75">{model.icon}</ModelIcon>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium" title={model.name}>
              {model.name}
            </span>
            {model.description && (
              <span className="typed truncate text-ink-3" title={model.description}>
                {model.description}
              </span>
            )}
          </span>
          {model.providerTag && (
            <span className="mt-0.25 max-w-36 shrink-0 truncate rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs leading-4 text-ink-3" title={`Provider: ${model.providerTag}`}>
              {model.providerTag}
            </span>
          )}
        </>
      )}
      {isSelected && (
        <span className="mt-0.25 flex size-4 shrink-0 items-center justify-center">
          <CheckIcon className="size-3.5 text-live" />
        </span>
      )}
    </CommandItem>
  );
}

export type ModelSelectorProps = Omit<ModelSelectorRootProps, "children"> &
  VariantProps<typeof modelSelectorTriggerVariants> & {
    /** Render a search input above the model list. */
    searchable?: boolean;
    /** Alignment of the dropdown relative to the trigger. Use `"end"` when the
     * trigger sits at the right edge of its container. */
    align?: ModelSelectorContentProps["align"];
    className?: string;
    contentClassName?: string;
  };

export {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
  ModelSelectorContent,
  ModelSelectorSearch,
  ModelSelectorFocusAnchor,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorSeparator,
  ModelSelectorItem,
};


// ---------------------------------------------------------------------------
// The open session's model, from the host's list
// ---------------------------------------------------------------------------

export const modelOptionId = (model: Pick<ModelRef, "provider" | "id">): string => `${model.provider}/${model.id}`;

/** Split proxy catalogues into the provider used and the upstream model name. */
export function modelProvenance(model: Pick<ModelRef, "provider" | "id">): {
  provider: string;
  sourceProvider?: string;
  modelId: string;
} {
  const modelId = model.id.replace(/^~/, "");
  const slash = modelId.indexOf("/");
  if (model.provider === "openrouter" && slash > 0) {
    return { provider: model.provider, sourceProvider: modelId.slice(0, slash), modelId };
  }
  return { provider: model.provider, modelId };
}

/** A model as a picker option: model-family mark, name, provenance and search terms. */
export function modelOption(model: ModelRef): ModelOption {
  const provenance = modelProvenance(model);
  return {
    id: modelOptionId(model),
    name: model.name ?? model.id,
    provider: model.provider,
    providerTag: providerDisplayName(model.provider),
    description: provenance.sourceProvider
      ? `${provenance.modelId} via ${provenance.provider}`
      : model.id,
    icon: <ProviderLogo provider={model.provider} className="size-3.5" />,
    keywords: [model.provider, model.id, provenance.modelId, provenance.sourceProvider ?? "", ...(model.contextWindow ? [tokens(model.contextWindow)] : [])],
  };
}

export interface ProviderModelMenuProps {
  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRetry?: () => void;
  side?: ModelSelectorContentProps["side"];
  align?: ModelSelectorContentProps["align"];
  beforeFilters?: ReactNode;
}

export function providerFilterForModel(model: Pick<ModelOption, "provider"> | undefined): string {
  return model?.provider ?? "all";
}

/** Shared provider/model menu with one explicit field for each filter. */
export function ProviderModelMenu({ loading = false, error, onRetry, side = "bottom", align = "start", beforeFilters }: ProviderModelMenuProps) {
  const { models, selectedModel, open } = useModelSelectorContext();
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const providerFilter = providerOverride ?? providerFilterForModel(selectedModel);

  useEffect(() => {
    if (open) return;
    setProviderOverride(null);
    setModelFilter("");
  }, [open]);

  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelOption[]>();
    for (const option of models) {
      const provider = option.provider ?? option.id.slice(0, option.id.indexOf("/"));
      const list = byProvider.get(provider) ?? [];
      list.push(option);
      byProvider.set(provider, list);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models]);
  const providers = useMemo(() => groups.map(([provider]) => provider), [groups]);
  const visibleGroups = useMemo(() => {
    const needle = modelFilter.trim().toLowerCase();
    const providerGroups = providerFilter === "all" ? groups : groups.filter(([provider]) => provider === providerFilter);
    if (!needle) return providerGroups;
    return providerGroups
      .map(([provider, list]) => [
        provider,
        list.filter((option) =>
          [option.name, option.id.slice(option.id.indexOf("/") + 1), ...(option.keywords ?? []).filter((term) => term !== option.provider)]
            .filter(Boolean)
            .some((term) => term!.toLowerCase().includes(needle)),
        ),
      ] as const)
      .filter(([, list]) => list.length > 0);
  }, [groups, modelFilter, providerFilter]);
  const visibleCount = visibleGroups.reduce((count, [, list]) => count + list.length, 0);

  return (
    <ModelSelectorContent side={side} align={align} searchable={false} className="w-88">
      {beforeFilters}
      <div className="grid gap-2 border-b border-line p-2">
        <LabeledFilter label="Provider">
          <ProviderFilterField providers={providers} value={providerFilter} onValueChange={setProviderOverride} />
        </LabeledFilter>
        <LabeledFilter label="Model">
          <ModelSelectorSearch
            aria-label="Filter by model"
            placeholder={providerFilter === "all" ? "Search model names or IDs" : `Search ${providerFilter} models`}
            value={modelFilter}
            onValueChange={setModelFilter}
          />
        </LabeledFilter>
      </div>
      <ModelSelectorList>
        {error ? (
          <ErrorState className="m-2" title="Couldn’t load the model list" detail={error} {...(onRetry ? { onRetry } : {})} />
        ) : loading ? (
          <div className="px-3 py-3"><GenerationLoader label="Loading models" layout="inline" /></div>
        ) : visibleCount === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-ink-3">No model matches.</p>
        ) : (
          visibleGroups.map(([provider, list]) => (
            <ModelSelectorGroup key={provider} heading={provider}>
              {list.map((option) => <ModelSelectorItem key={option.id} model={option} />)}
            </ModelSelectorGroup>
          ))
        )}
      </ModelSelectorList>
    </ModelSelectorContent>
  );
}

function LabeledFilter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2">
      <span className="eyebrow text-ink-3">{label}</span>
      <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
        {children}
      </div>
    </div>
  );
}

export interface ProviderFilterFieldProps {
  providers: readonly string[];
  value: string;
  onValueChange(value: string): void;
  className?: string;
}

/** Searchable single-field provider filter shared by menus and catalogue tables. */
export function ProviderFilterField({ providers, value, onValueChange, className }: ProviderFilterFieldProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          aria-label="Filter by provider"
          aria-expanded={open}
          className={cn("h-9 w-full justify-between rounded-none px-2.5 font-normal", className)}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {value === "all" ? null : <ProviderLogo provider={value} className="size-3.5 shrink-0" />}
            <span className="truncate">{value === "all" ? "All providers" : value}</span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden p-0">
        <Command className="bg-transparent">
          <CommandInput aria-label="Search providers" placeholder="Search providers" />
          <CommandList>
            <CommandEmpty>No provider matches.</CommandEmpty>
            <CommandGroup heading="Providers">
              <CommandItem
                value="all-providers"
                onSelect={() => {
                  onValueChange("all");
                  setOpen(false);
                }}
              >
                <span className="flex-1">All providers</span>
                {value === "all" ? <CheckIcon className="size-3.5 text-live" /> : null}
              </CommandItem>
              {providers.map((provider) => (
                <CommandItem
                  key={provider}
                  value={provider}
                  onSelect={() => {
                    onValueChange(provider);
                    setOpen(false);
                  }}
                >
                  <ProviderLogo provider={provider} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{provider}</span>
                  {value === provider ? <CheckIcon className="size-3.5 text-live" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface ProviderModelPickerProps {
  models: readonly ModelRef[];
  value?: string;
  onValueChange(value: string): void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  placeholder?: string;
  className?: string;
  side?: ProviderModelMenuProps["side"];
  align?: ProviderModelMenuProps["align"];
}

export interface ProviderPickerProps {
  models: readonly ModelRef[];
  value?: string;
  onValueChange(value: string): void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  placeholder?: string;
  className?: string;
}

/** Searchable provider-only companion to the provider/model picker. */
export function ProviderPicker({ models, value, onValueChange, disabled, loading = false, error, placeholder = "Choose a provider", className }: ProviderPickerProps) {
  const options = useMemo<ModelOption[]>(
    () => [...new Set(models.map((model) => model.provider))].sort().map((provider) => ({ id: provider, name: provider, provider, icon: <ProviderLogo provider={provider} className="size-3.5" /> })),
    [models],
  );
  return (
    <ModelSelectorRoot models={options} {...(value ? { value } : {})} onValueChange={onValueChange}>
      <ModelSelectorTrigger disabled={disabled} className={cn("w-full max-w-96", className)}>
        <ModelSelectorValue placeholder={placeholder} />
      </ModelSelectorTrigger>
      <ModelSelectorContent searchable>
        <ModelSelectorSearch placeholder="Search providers" />
        <ModelSelectorList>
          {error ? (
            <ErrorState className="m-2" title="Couldn’t load providers" detail={error} />
          ) : loading ? (
            <div className="px-3 py-3"><GenerationLoader label="Loading providers" layout="inline" /></div>
          ) : (
            <>
              <ModelSelectorEmpty>No provider matches.</ModelSelectorEmpty>
              <ModelSelectorGroup heading="Providers">
                {options.map((option) => <ModelSelectorItem key={option.id} model={option} />)}
              </ModelSelectorGroup>
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}

/** A complete single-value model control for settings and onboarding. */
export function ProviderModelPicker({ models, value, onValueChange, disabled, loading, error, placeholder, className, side, align }: ProviderModelPickerProps) {
  const options = useMemo(() => models.map(modelOption), [models]);
  return (
    <ModelSelectorRoot models={options} {...(value ? { value } : {})} onValueChange={onValueChange}>
      <ModelSelectorTrigger disabled={disabled} className={cn("w-full max-w-96", className)}>
        <ModelSelectorValue placeholder={placeholder ?? "Choose a model"} className="min-w-0" />
      </ModelSelectorTrigger>
      <ProviderModelMenu loading={loading} error={error} {...(side ? { side } : {})} {...(align ? { align } : {})} />
    </ModelSelectorRoot>
  );
}

export interface ProviderModelMultiPickerProps {
  models: readonly ModelRef[];
  values: readonly string[];
  onValuesChange(values: string[]): void;
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  label?: string;
  className?: string;
}

/** A searchable, provider-filtered multi-select for model allowlists. */
export function ProviderModelMultiPicker({ models, values, onValuesChange, disabled, loading = false, error, label = "models", className }: ProviderModelMultiPickerProps) {
  const [open, setOpen] = useState(false);
  const [providerFilter, setProviderFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("");
  const options = useMemo(() => models.map(modelOption), [models]);
  const groups = useMemo(() => {
    const grouped = new Map<string, ModelOption[]>();
    for (const option of options) {
      const provider = option.provider ?? "other";
      const list = grouped.get(provider) ?? [];
      list.push(option);
      grouped.set(provider, list);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [options]);
  const chosen = useMemo(() => new Set(values), [values]);
  const providers = useMemo(() => groups.map(([provider]) => provider), [groups]);
  const visibleGroups = useMemo(() => {
    const needle = modelFilter.trim().toLowerCase();
    const providerGroups = providerFilter === "all" ? groups : groups.filter(([provider]) => provider === providerFilter);
    if (!needle) return providerGroups;
    return providerGroups
      .map(([provider, list]) => [provider, list.filter((option) =>
        [option.name, option.id.slice(option.id.indexOf("/") + 1)]
          .filter(Boolean)
          .some((term) => term!.toLowerCase().includes(needle)),
      )] as const)
      .filter(([, list]) => list.length > 0);
  }, [groups, modelFilter, providerFilter]);
  const toggle = (id: string) => onValuesChange(chosen.has(id) ? values.filter((value) => value !== id) : [...values, id]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          className={cn("h-8 w-full max-w-120 justify-between px-2.5 font-normal", className)}
        >
          <span className="truncate">{values.length === 0 ? `All ${label}` : `${values.length} ${label} selected`}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3.5 text-ink-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-88 max-w-[calc(100vw-2rem)] overflow-hidden p-0">
        <Command className="bg-transparent" shouldFilter={false}>
          <div className="grid gap-2 border-b border-line p-2">
            <LabeledFilter label="Provider">
              <ProviderFilterField providers={providers} value={providerFilter} onValueChange={setProviderFilter} />
            </LabeledFilter>
            <LabeledFilter label="Model">
              <CommandInput
                aria-label="Filter by model"
                placeholder={providerFilter === "all" ? "Search model names or IDs" : `Search ${providerFilter} models`}
                value={modelFilter}
                onValueChange={setModelFilter}
              />
            </LabeledFilter>
          </div>
          <CommandList>
            {error ? (
              <ErrorState className="m-2" title="Couldn’t load models" detail={error} />
            ) : loading ? (
              <div className="px-3 py-3"><GenerationLoader label="Loading models" layout="inline" /></div>
            ) : visibleGroups.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-ink-3">No model matches.</p>
            ) : (
              <>
                {visibleGroups.map(([provider, list]) => (
              <CommandGroup key={provider} heading={provider}>
                {list.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    keywords={[option.name, ...(option.keywords ?? [])]}
                    onSelect={() => toggle(option.id)}
                    className="relative items-start gap-2.5 rounded-md px-3 py-1.5"
                  >
                    {option.icon && <ModelIcon className="mt-0.75">{option.icon}</ModelIcon>}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{option.name}</span>
                      {option.description && <span className="typed truncate text-ink-3">{option.description}</span>}
                    </span>
                    {option.providerTag && (
                      <span className="mt-0.25 max-w-36 shrink-0 truncate rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-xs leading-4 text-ink-3" title={`Provider: ${option.providerTag}`}>
                        {option.providerTag}
                      </span>
                    )}
                    {chosen.has(option.id) && <CheckIcon className="mt-0.25 size-3.5 shrink-0 text-live" />}
                  </CommandItem>
                ))}
              </CommandGroup>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The model a project's next session will start with, when no session is open.
 *
 * Without this the chip read "No model" on the screen a person lands on the
 * moment they finish setup — directly after a step whose whole purpose was
 * choosing one. It was not wrong about the *session* (there is none yet) and it
 * was badly wrong about the person's situation.
 *
 * Cached per project, because the catalogue is over a thousand rows and this
 * runs on an idle screen.
 */
const defaultModelCache = new Map<string, Promise<ModelRef | null>>();

function useProjectDefaultModel(cwd: string | undefined, enabled: boolean): { model: ModelRef | null; loading: boolean } {
  const { client } = useLaserStable();
  // The catalogue answers "no default" while the project's worker is still
  // starting, and that answer must not be the one this screen keeps. Re-asking
  // when the worker's status changes is what turns "No model" back into the
  // model, without a reload.
  const workerStatus = useLaserState((s) => (cwd ? s.workers[cwd]?.status : undefined));
  const [fallback, setFallback] = useState<ModelRef | null>(null);
  // The catalogue is a thousand rows and the project's worker may still be
  // starting, so the first answer can take seconds. Saying "No model" during
  // those seconds is the same false claim this hook exists to remove, one state
  // earlier — so the wait is its own state and says nothing at all.
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !cwd) {
      setFallback(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    let pending = defaultModelCache.get(cwd);
    if (!pending) {
      pending = client.request("pi/models/catalog", { cwd }).then((catalog) => {
        const { defaultProvider, defaultModel } = catalog;
        if (!defaultProvider || !defaultModel) return null;
        const entry = catalog.models.find((m) => m.provider === defaultProvider && m.id === defaultModel);
        // Named even when the catalogue does not carry it: a default that
        // resolves to nothing on this machine is still what settings say, and
        // saying "No model" would hide that rather than explain it.
        return { provider: defaultProvider, id: defaultModel, ...(entry?.name ? { name: entry.name } : {}) } as ModelRef;
      });
      // Neither a failed fetch nor an empty answer may poison the cache. A
      // `null` is "the worker has not said yet" as often as it is "there is no
      // default", and caching it for the life of the page is how the composer
      // ends up reading "No model" for minutes on the landing screen.
      void pending.then(
        (ref) => {
          if (ref === null) defaultModelCache.delete(cwd);
        },
        () => defaultModelCache.delete(cwd),
      );
      defaultModelCache.set(cwd, pending);
    }
    void pending.then(
      (ref) => {
        if (!live) return;
        setFallback(ref);
        setLoading(false);
      },
      () => {
        if (!live) return;
        setFallback(null);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client, cwd, enabled, workerStatus]);

  return { model: fallback, loading };
}

/**
 * Model picker bound to the open session. The list arrives from
 * `pi/model/list` each time the popover opens (Pi's catalogue can run to a
 * thousand rows, so it is not fetched on every render, and it is forgotten on
 * close so a switch flipped in Settings → Providers and models shows on the
 * next open without a reload, M13-T49), grouped by provider; a pick calls
 * `pi/model/set`.
 *
 * With no session open it edits the default that the new session will inherit.
 * That is the point at which choosing a model is most useful; disabling the
 * control until after the first prompt falsely looks like a provider failure.
 */
export function SessionModelSelector({ className }: { className?: string | undefined }) {
  const { actions, client, currentProject } = useLaserStable();
  const { pending: preparingSession } = useSessionPreparation();
  const { model: sessionModel, session } = useSessionMeta();
  const sessionPath = session?.path;
  const cwd = session?.cwd ?? currentProject;
  const { model: projectDefault, loading: defaultLoading } = useProjectDefaultModel(cwd, !sessionPath);
  const [newSessionModel, setNewSessionModel] = useState<ModelRef | null>(null);
  const model = sessionModel ?? (sessionPath ? null : (newSessionModel ?? projectDefault));
  /** No session, and we do not know its default yet: claim nothing. */
  const unknown = !sessionPath && !model && defaultLoading;
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setModels(null);
    setError(null);
    setNewSessionModel(null);
  }, [cwd, sessionPath]);

  // Forget the list on close: the worker answers from memory, and what is
  // offered can change between two opens (a switch in Settings, a sign-in).
  useEffect(() => {
    if (!open) setModels(null);
  }, [open]);

  useEffect(() => {
    if (!open || models !== null || !cwd) return;
    let live = true;
    setError(null);
    // With a session the worker already answers with the models it can switch
    // to; without one the catalogue is narrowed here to the same rule (D-145).
    const request: Promise<ModelRef[]> = sessionPath
      ? actions.listModels()
      : Promise.all([
          client.request("pi/models/catalog", { cwd }),
          client.request("pi/providers/list", { cwd }).then(({ providers }) => providers, () => undefined),
        ]).then(([catalog, providers]) => narrowToConnected(catalog.models, providers).models);
    request
      .then((list) => {
        if (live) setModels(list);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [open, models, actions, client, cwd, sessionPath]);

  // A model the session already has but the list has not delivered yet still
  // needs to be shown as the value, so it is an option of its own until then.
  const options = useMemo(() => {
    const list = models ?? (model ? [model] : []);
    if (model && !list.some((m) => modelOptionId(m) === modelOptionId(model))) list.unshift(model);
    return list.map(modelOption);
  }, [models, model]);

  const value = model ? modelOptionId(model) : undefined;
  const pick = (id: string) => {
    const next = (models ?? []).find((m) => modelOptionId(m) === id);
    if (!next) return;
    if (sessionPath) {
      void actions.setModel(next);
      return;
    }
    if (!cwd) return;
    setSaving(true);
    void client.request("pi/settings/set", {
      cwd,
      scope: "project",
      changes: defaultModelChanges(next),
    }).then(
      () => {
        defaultModelCache.set(cwd, Promise.resolve(next));
        invalidateThinkingCatalog(cwd);
        setNewSessionModel(next);
      },
      (saveError: unknown) => actions.toast("error", saveError instanceof Error ? saveError.message : String(saveError)),
    ).finally(() => setSaving(false));
  };

  return (
    <ModelSelectorRoot models={options} {...(value !== undefined ? { value } : {})} onValueChange={pick} open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        disabled={!cwd || saving || preparingSession}
        aria-label={
          sessionPath
            ? `Model: ${model ? (model.name ?? model.id) : "none"}`
            : unknown
              ? "Checking which model a new session starts with"
              : model
                ? `New sessions start with ${model.name ?? model.id}`
                : "No model chosen"
        }
        title={sessionPath ? undefined : "Choose what new sessions in this project start with"}
        className={cn("min-w-0 max-w-56 shrink gap-1.5 text-ink-2", className)}
      >
        {model ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <ProviderLogo provider={model.provider} className="size-3.5 shrink-0 text-ink-3" />
            <span className="truncate typed" title={model.name ?? model.id}>
              {model.name ?? model.id}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-ink-3">
            <Cpu aria-hidden="true" className="size-3.5" />
            {unknown ? null : <span className="typed">No model</span>}
          </span>
        )}
      </ModelSelectorTrigger>
      <ProviderModelMenu
        side="top"
        align="start"
        loading={models === null}
        error={error}
        onRetry={() => {
          setError(null);
          setModels(null);
        }}
      />
    </ModelSelectorRoot>
  );
}

/** The atomic settings write behind a model choice made before a session exists. */
export function defaultModelChanges(model: Pick<ModelRef, "provider" | "id">): SettingChange[] {
  return [
    { path: "defaultProvider", op: "set", value: model.provider },
    { path: "defaultModel", op: "set", value: model.id },
  ];
}
