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
 *     carry the provider's mark, and a pick calls `pi/model/set`.
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
import type { ModelRef } from "@piorbit/protocol";
import { CheckIcon, ChevronDownIcon, Cpu } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { usePiorbitStable, usePiorbitState, useSessionMeta } from "@/runtime";

import { ErrorState } from "./error-state.js";
import { GenerationLoader } from "./loading-state.js";
import { ProviderLogo } from "./logos.js";

export type ModelOption = {
  id: string;
  name: string;
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
  const contextValue = useMemo(
    () => ({
      models,
      value,
      setValue,
      selectedModel,
      setOpen,
    }),
    [models, value, setValue, selectedModel, setOpen],
  );

  return (
    <ModelSelectorContext.Provider value={contextValue}>
      <Popover open={open ?? false} onOpenChange={setOpen}>
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
  ...props
}: ModelSelectorContentProps) {
  const { value } = useModelSelectorContext();
  const { side: renderedSide, popupRef } = useLazyFlipSide();
  const unfiltered =
    searchable === false || (!searchable && children === undefined);

  return (
    <PopoverContent
      ref={popupRef}
      data-slot="model-selector-content"
      align={align}
      side={renderedSide ?? side ?? "bottom"}
      sideOffset={sideOffset}
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
        {unfiltered && <ModelSelectorFocusAnchor />}
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
        "relative items-start gap-2.5 rounded-md py-1.5 ps-3 pe-9 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {model.icon && (
            <ModelIcon className="mt-0.75">{model.icon}</ModelIcon>
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium" title={model.name}>
              {model.name}
            </span>
            {model.description && (
              <span className="typed truncate text-ink-3" title={model.description}>
                {model.description}
              </span>
            )}
          </span>
        </>
      )}
      {isSelected && (
        <span className="absolute end-3 top-2 flex size-4 items-center justify-center">
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

/** A Pi model as a picker option: provider mark, name, typed id, context size in the search terms. */
export function modelOption(model: ModelRef): ModelOption {
  return {
    id: modelOptionId(model),
    name: model.name ?? model.id,
    description: model.name && model.name !== model.id ? model.id : model.provider,
    icon: <ProviderLogo provider={model.provider} className="size-3.5" />,
    keywords: [model.provider, model.id, ...(model.contextWindow ? [tokens(model.contextWindow)] : [])],
  };
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
  const { client } = usePiorbitStable();
  // The catalogue answers "no default" while the project's worker is still
  // starting, and that answer must not be the one this screen keeps. Re-asking
  // when the worker's status changes is what turns "No model" back into the
  // model, without a reload.
  const workerStatus = usePiorbitState((s) => (cwd ? s.workers[cwd]?.status : undefined));
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
 * `pi/model/list` the first time the popover opens (Pi's catalogue can run to
 * a thousand rows, so it is not fetched on every render), grouped by
 * provider; a pick calls `pi/model/set`.
 *
 * With no session open it shows the project's default instead, disabled and
 * labelled as what a new session will start with.
 */
export function SessionModelSelector({ className }: { className?: string | undefined }) {
  const { actions, currentProject } = usePiorbitStable();
  const { model: sessionModel, session } = useSessionMeta();
  const { model: projectDefault, loading: defaultLoading } = useProjectDefaultModel(session?.cwd ?? currentProject, !session);
  const model = sessionModel ?? (session ? null : projectDefault);
  /** No session, and we do not know its default yet: claim nothing. */
  const unknown = !session && !model && defaultLoading;
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || models !== null) return;
    let live = true;
    setError(null);
    actions
      .listModels()
      .then((list) => {
        if (live) setModels(list);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [open, models, actions]);

  // A model the session already has but the list has not delivered yet still
  // needs to be shown as the value, so it is an option of its own until then.
  const options = useMemo(() => {
    const list = models ?? (model ? [model] : []);
    if (model && !list.some((m) => modelOptionId(m) === modelOptionId(model))) list.unshift(model);
    return list.map(modelOption);
  }, [models, model]);
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelOption[]>();
    for (const option of options) {
      const provider = option.id.slice(0, option.id.indexOf("/"));
      const list = byProvider.get(provider) ?? [];
      list.push(option);
      byProvider.set(provider, list);
    }
    return [...byProvider.entries()];
  }, [options]);

  const value = model ? modelOptionId(model) : undefined;
  const pick = (id: string) => {
    const next = (models ?? []).find((m) => modelOptionId(m) === id);
    if (next) void actions.setModel(next);
  };

  return (
    <ModelSelectorRoot models={options} {...(value !== undefined ? { value } : {})} onValueChange={pick} open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        disabled={!session}
        aria-label={
          session
            ? `Model: ${model ? (model.name ?? model.id) : "none"}`
            : unknown
              ? "Checking which model a new session starts with"
              : model
                ? `New sessions start with ${model.name ?? model.id}`
                : "No model chosen"
        }
        title={session ? undefined : model ? "What a new session starts with. Change it in Settings → Models." : undefined}
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
      <ModelSelectorContent side="top" align="start" searchable>
        <ModelSelectorSearch placeholder="Search models" />
        <ModelSelectorList>
          {error ? (
            // Written for a person, with the way out: the raw RPC string is
            // the detail, never the headline, and Retry re-asks.
            <ErrorState
              className="m-2"
              title="Couldn’t load the model list"
              detail={error}
              onRetry={() => {
                setError(null);
                setModels(null);
              }}
            />
          ) : models === null ? (
            <div className="px-3 py-3">
              <GenerationLoader label="Loading models" layout="inline" />
            </div>
          ) : (
            <>
              <ModelSelectorEmpty>No model matches.</ModelSelectorEmpty>
              {groups.map(([provider, list]) => (
                <ModelSelectorGroup key={provider} heading={provider}>
                  {list.map((option) => (
                    <ModelSelectorItem key={option.id} model={option} />
                  ))}
                </ModelSelectorGroup>
              ))}
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
