import type { ModelRef } from "@piorbit/protocol";
import { Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { tokens } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable, useSessionMeta } from "@/runtime";

const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;

function matches(model: ModelRef, query: string): boolean {
  if (!query) return true;
  const hay = `${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

/**
 * Popover model picker with a search field and a provider-grouped list.
 * Each row: name, typed id, context window, reasoning/vision flags. Models
 * come from `pi/model/list` on open (cached for the popover's lifetime).
 */
export function ModelSelector() {
  const { actions } = usePiorbitStable();
  const { model, session } = useSessionMeta();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open, actions]);

  const filtered = useMemo(() => (models ?? []).filter((m) => matches(m, query)), [models, query]);
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelRef[]>();
    for (const m of filtered) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()];
  }, [filtered]);

  useEffect(() => setActive(0), [query, models]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const select = (m: ModelRef) => {
    setOpen(false);
    void actions.setModel(m);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = filtered[active];
      if (m) select(m);
    }
  };

  const label = model ? (model.name ?? model.id) : "No model";
  let flat = -1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!session}
          aria-label={`Model: ${label}`}
          className="typed max-w-56 gap-1.5 text-ink-2 hover:text-ink"
        >
          <Cpu aria-hidden="true" className="size-3.5 text-ink-3" />
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="size-3 text-ink-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-[22rem] gap-0 p-0">
        <div className="flex h-10 items-center gap-2 border-b border-line px-3">
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
          <input
            autoFocus
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          {models ? <span className="typed tnum text-ink-3">{filtered.length}</span> : null}
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Models" className="max-h-72 overflow-y-auto py-1">
          {error ? (
            <p className="px-3 py-3 text-sm text-danger">{error}</p>
          ) : models === null ? (
            <ModelListSkeleton />
          ) : filtered.length === 0 ? (
            <p className="px-3 py-3 text-sm text-ink-3">No models match “{query}”.</p>
          ) : (
            groups.map(([provider, list]) => (
              <div key={provider} role="group" aria-label={provider}>
                <p className="eyebrow px-3 pt-2 pb-1">{provider}</p>
                {list.map((m) => {
                  flat += 1;
                  const index = flat;
                  const selected = model !== null && modelKey(model) === modelKey(m);
                  return (
                    <div
                      key={modelKey(m)}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={selected}
                      data-index={index}
                      data-active={index === active || undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => select(m)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 px-3 py-1.5 transition-colors duration-75",
                        "data-active:bg-surface-2",
                      )}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {selected ? <Check aria-hidden="true" className="size-3.5 text-live" /> : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-ink">{m.name ?? m.id}</span>
                        {m.name ? <span className="typed truncate text-ink-3">{m.id}</span> : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {m.reasoning ? <Flag label="reasoning">R</Flag> : null}
                        {m.vision ? <Flag label="vision">V</Flag> : null}
                        {m.contextWindow ? (
                          <span className="typed tnum text-ink-3">{tokens(m.contextWindow)}</span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Flag({ label, children }: { label: string; children: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line px-1 font-mono text-2xs leading-none text-ink-2"
    >
      {children}
    </span>
  );
}

function ModelListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading models" className="flex flex-col gap-2 px-3 py-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="size-4" />
          <span className="h-3 rounded-sm bg-surface-2" style={{ width: `${52 - i * 8}%` }} />
        </div>
      ))}
    </div>
  );
}
