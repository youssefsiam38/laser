import type { CollectionItem, CollectionPanel } from "@lasercode/protocol";
import { Ellipsis, FileText } from "lucide-react";
import { useMemo } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import type { PanelEntry } from "../../store.js";
import { ActionButtons } from "../ActionButtons.js";

export interface CollectionBodyProps {
  entry: PanelEntry;
  panel: CollectionPanel;
  onAct(actionId: string, value?: string): Promise<unknown>;
  onOpenRef(ref: string, label: string): void;
}

/**
 * A set of found things, as generic rows (R12a): `primary`, `secondary`,
 * `meta` chips — or a table when the producer says so. A row with a ref opens
 * as a document; per-item actions live in the row's menu.
 */
export function CollectionBody({ panel, onAct, onOpenRef }: CollectionBodyProps) {
  const total = panel.total ?? panel.items.length;
  const act = (item: CollectionItem, actionId: string) => onAct(actionId, item.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div data-island-scroll className="min-h-0 flex-1 overflow-auto">
        {panel.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-3">Nothing found.</p>
        ) : panel.layout === "table" ? (
          <Table items={panel.items} onOpenRef={onOpenRef} onAct={act} />
        ) : (
          <ul role="list" className="flex flex-col">
            {panel.items.map((item) => (
              <Row key={item.id} item={item} onOpenRef={onOpenRef} onAct={act} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="typed text-ink-3 tnum">
          {total > panel.items.length ? `${panel.items.length} of ${total}` : `${panel.items.length} ${panel.items.length === 1 ? "item" : "items"}`}
          {panel.cursor ? " · more available" : ""}
        </span>
        <ActionButtons actions={panel.actions} onAct={(id) => onAct(id)} className="ms-auto" />
      </div>
    </div>
  );
}

interface RowProps {
  item: CollectionItem;
  onOpenRef(ref: string, label: string): void;
  onAct(item: CollectionItem, actionId: string): Promise<unknown>;
}

function Row({ item, onOpenRef, onAct }: RowProps) {
  const opens = item.ref !== undefined;
  const Primary = opens ? "button" : "div";
  return (
    <li className="group/row flex items-start gap-2 border-b border-line py-2 last:border-b-0">
      <Primary
        {...(opens ? { type: "button", onClick: () => onOpenRef(item.ref!, item.primary) } : {})}
        className={cn(
          "min-w-0 flex-1 text-start outline-none",
          opens && "rounded-md focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live hover:[&>p:first-child]:text-live",
        )}
      >
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          {opens && <FileText className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />}
          <span className="min-w-0 truncate">{item.primary}</span>
        </p>
        {item.secondary && <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-ink-2">{item.secondary}</p>}
        {item.meta && item.meta.length > 0 && (
          <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {item.meta.map((m) => (
              <div key={m.label} className="flex items-baseline gap-1">
                <dt className="eyebrow">{m.label}</dt>
                <dd className="typed max-w-48 truncate text-ink-2" title={m.value}>
                  {m.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Primary>
      {item.actions && item.actions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton tooltip="Actions" size="icon-xs" className="text-ink-3">
              <Ellipsis />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {item.actions.map((action) => (
              <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onSelect={() => void onAct(item, action.id)}>
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

function Table({ items, onOpenRef, onAct }: { items: readonly CollectionItem[] } & Omit<RowProps, "item">) {
  const columns = useMemo(() => {
    const seen: string[] = [];
    for (const item of items) for (const m of item.meta ?? []) if (!seen.includes(m.label)) seen.push(m.label);
    return seen;
  }, [items]);
  const hasActions = items.some((i) => i.actions && i.actions.length > 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="eyebrow border-b border-line px-2 py-1.5 text-start">Item</th>
            {columns.map((c) => (
              <th key={c} className="eyebrow border-b border-line px-2 py-1.5 text-start">
                {c}
              </th>
            ))}
            {hasActions && <th className="border-b border-line" />}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="group/row">
              <td className="border-b border-line px-2 py-1.5 align-top">
                {item.ref ? (
                  <button
                    type="button"
                    onClick={() => onOpenRef(item.ref!, item.primary)}
                    className="rounded text-start font-medium text-ink outline-none hover:text-live focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
                  >
                    {item.primary}
                  </button>
                ) : (
                  <span className="font-medium text-ink">{item.primary}</span>
                )}
                {item.secondary && <p className="mt-0.5 text-xs leading-4 text-ink-2">{item.secondary}</p>}
              </td>
              {columns.map((c) => {
                const value = item.meta?.find((m) => m.label === c)?.value;
                return (
                  <td key={c} className="typed border-b border-line px-2 py-1.5 align-top text-ink-2" title={value}>
                    {value ?? <span className="text-ink-3">—</span>}
                  </td>
                );
              })}
              {hasActions && (
                <td className="border-b border-line px-1 py-1 align-top">
                  {item.actions && item.actions.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <TooltipIconButton tooltip="Actions" size="icon-xs" className="text-ink-3">
                          <Ellipsis />
                        </TooltipIconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {item.actions.map((action) => (
                          <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onSelect={() => void onAct(item, action.id)}>
                            {action.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
