"use client";
/**
 * Settings → Providers and models → Fallback chains (M15-T3,
 * `docs/model-fallback-chains.md` §5.1).
 *
 * A chain is an ordered list of models: the first one *starts* the chain, the
 * rest take over when it cannot answer. Two things surprise people about that,
 * so both are written on the screen rather than left to be discovered — only
 * the first model starts a chain, and a fallback that fails sends the models
 * above it one attempt each before the next one.
 *
 * Every edit is one `fallbackChains` write at global scope, validated with the
 * very function the worker validates with, so the sentence a person reads here
 * is the sentence that would have refused the write.
 */
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  FALLBACK_CHAINS_SETTING,
  modelKey,
  readFallbackChainsValue,
  validateFallbackChains,
  type FallbackChain,
  type FallbackChainIssue,
  type FallbackModelRef,
  type ModelCatalogEntry,
  type ModelRef,
  type SettingChange,
  type SettingsScope,
  type SettingsSnapshot,
} from "@lasercode/protocol";

import { useConnectedModels } from "@/components/assistant-ui/elements/connected-models";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { ProviderModelPicker, modelOptionId } from "@/components/assistant-ui/elements/model-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

export interface FallbackChainsTabProps {
  cwd: string;
  snapshot: SettingsSnapshot | undefined;
  onApply: (scope: SettingsScope, changes: SettingChange[]) => Promise<boolean>;
}

/** A draft chain is local until it has a model to fall back to; a chain of one cannot be saved. */
type Draft = { models: FallbackModelRef[] } | null;

const nameOf = (model: FallbackModelRef, catalogue: readonly ModelCatalogEntry[]): string =>
  catalogue.find((entry) => modelKey(entry) === modelKey(model))?.name ?? model.id;

const sameChains = (a: readonly FallbackChain[], b: readonly FallbackChain[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function FallbackChainsTab({ cwd, snapshot, onApply }: FallbackChainsTabProps) {
  const saved = useMemo(
    () => readFallbackChainsValue(snapshot?.global.values[FALLBACK_CHAINS_SETTING]),
    [snapshot],
  );
  const { models: catalogue, loading, error, none } = useConnectedModels(cwd);
  const [chains, setChains] = useState<FallbackChain[]>(saved);
  const [draft, setDraft] = useState<Draft>(null);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string>();

  // The file is the truth: adopt what a save (or another screen) wrote.
  useEffect(() => {
    setChains((current) => (sameChains(current, saved) ? current : saved));
  }, [saved]);

  const issues = useMemo(() => validateFallbackChains(chains), [chains]);
  const issuesFor = useCallback(
    (index: number): FallbackChainIssue[] => issues.filter((issue) => issue.chain === index),
    [issues],
  );

  const commit = useCallback(
    async (next: FallbackChain[]) => {
      const problems = validateFallbackChains(next);
      if (problems.length > 0) {
        setRefused(problems[0]!.message);
        return false;
      }
      setRefused(undefined);
      setChains(next);
      setSaving(true);
      try {
        const ok = await onApply("global", [{ path: FALLBACK_CHAINS_SETTING, op: "set", value: next }]);
        if (!ok) setChains(saved);
        return ok;
      } finally {
        setSaving(false);
      }
    },
    [onApply, saved],
  );

  /** Models this chain can still take: connected, and not already in it. */
  const addable = useCallback(
    (models: readonly FallbackModelRef[]): ModelRef[] => {
      const present = new Set(models.map(modelKey));
      return catalogue.filter((entry) => !present.has(modelKey(entry)));
    },
    [catalogue],
  );

  /** Models that could start a new chain: connected, and not already starting one. */
  const startable = useMemo(() => {
    const starters = new Set(chains.map((chain) => (chain.models[0] ? modelKey(chain.models[0]) : "")));
    return catalogue.filter((entry) => !starters.has(modelKey(entry)));
  }, [catalogue, chains]);

  const editChain = (index: number, models: FallbackModelRef[]) =>
    void commit(chains.map((chain, at) => (at === index ? { models } : chain)));

  const addToDraft = (model: FallbackModelRef) => {
    const models = [...(draft?.models ?? []), model];
    if (models.length < 2) {
      setDraft({ models });
      return;
    }
    void commit([...chains, { models }]).then((ok) => {
      if (ok) setDraft(null);
    });
  };

  const empty = chains.length === 0 && draft === null;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-240 flex-col gap-5 px-4 py-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Fallback chains</h2>
            {(loading || saving) && <GenerationLoader label={saving ? "Saving" : "Loading models"} layout="inline" />}
          </div>
          <p className="text-xs leading-5 text-ink-2">
            When a model cannot answer — the provider is down, the credit is gone, the subscription window is spent — the
            conversation continues on the next model you name here, with its history and tool results intact.
          </p>
          <p className="text-xs leading-5 text-ink-2">
            <span className="font-medium text-ink">Only the first model in a list starts it.</span> A conversation on Sonnet
            uses Sonnet’s list, and keeps it while the app falls back along it. Choosing another model yourself, mid-conversation,
            starts that model’s own list instead — never Sonnet’s again.
          </p>
          <p className="text-xs leading-5 text-ink-3">
            Chains are yours, not a project’s, and a saved edit applies to conversations started afterwards. A conversation
            already running keeps the list it started with.
          </p>
          {error && (
            <p role="status" className="text-xs leading-5 text-attention">
              The model catalogue could not be read: {error}
            </p>
          )}
          {none && !loading && (
            <p role="status" className="text-xs leading-5 text-attention">
              Connect a provider under Models and dictation first — a chain can only name models you can actually use.
            </p>
          )}
          {refused && (
            <p role="status" data-slot="chain-refusal" className="text-xs leading-5 text-attention">
              {refused}
            </p>
          )}
        </section>

        {empty ? (
          <section
            data-slot="fallback-empty"
            className="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface px-4 py-5"
          >
            <p className="text-sm font-medium text-ink">No fallback chains yet</p>
            <p className="max-w-140 text-xs leading-5 text-ink-2">
              Nothing changes until you make one. Name a model you work with, then the models that should take over for it,
              in the order you would reach for them.
            </p>
            <Button size="sm" data-slot="add-chain" onClick={() => setDraft({ models: [] })} disabled={loading || none}>
              <Plus aria-hidden="true" /> Add fallback chain
            </Button>
          </section>
        ) : (
          <div className="flex flex-col gap-3">
            {chains.map((chain, index) => (
              <ChainCard
                key={`${chain.models[0] ? modelKey(chain.models[0]) : "chain"}-${index}`}
                index={index}
                models={chain.models}
                catalogue={catalogue}
                addable={addable(chain.models)}
                issues={issuesFor(index)}
                busy={saving}
                onChange={(models) => editChain(index, models)}
                onDelete={() => void commit(chains.filter((_, at) => at !== index))}
              />
            ))}
            {draft && (
              <ChainCard
                index={chains.length}
                draft
                models={draft.models}
                catalogue={catalogue}
                addable={draft.models.length === 0 ? startable : addable(draft.models)}
                issues={
                  draft.models.length < 2
                    ? [{ chain: chains.length, message: draft.models.length === 0 ? "Choose the model this chain starts on." : "Add a model to fall back to." }]
                    : []
                }
                busy={saving}
                onChange={(models) => setDraft({ models })}
                onAdd={addToDraft}
                onDelete={() => setDraft(null)}
              />
            )}
            <div>
              <Button
                size="sm"
                variant="secondary"
                data-slot="add-chain"
                onClick={() => setDraft({ models: [] })}
                disabled={loading || none || draft !== null}
              >
                <Plus aria-hidden="true" /> Add fallback chain
              </Button>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

interface ChainCardProps {
  index: number;
  models: FallbackModelRef[];
  catalogue: readonly ModelCatalogEntry[];
  addable: readonly ModelRef[];
  issues: FallbackChainIssue[];
  busy: boolean;
  draft?: boolean;
  onChange(models: FallbackModelRef[]): void;
  onAdd?(model: FallbackModelRef): void;
  onDelete(): void;
}

function ChainCard({ index, models, catalogue, addable, issues, busy, draft, onChange, onAdd, onDelete }: ChainCardProps) {
  const starter = models[0];
  const title = starter ? nameOf(starter, catalogue) : "New chain";
  const add = (id: string) => {
    const chosen = addable.find((model) => modelOptionId(model) === id);
    if (!chosen) return;
    const model = { provider: chosen.provider, id: chosen.id };
    if (onAdd) onAdd(model);
    else onChange([...models, model]);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= models.length) return;
    const next = [...models];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
  };

  return (
    <article
      data-slot="fallback-chain"
      data-chain={index}
      data-draft={draft ? "true" : undefined}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium text-ink" data-slot="chain-title">
          {title}
        </h3>
        {!draft && models.length > 1 && (
          <span className="text-xs text-ink-3 tabular-nums">
            {models.length - 1} {models.length === 2 ? "fallback" : "fallbacks"}
          </span>
        )}
        <TooltipIconButton
          tooltip={draft ? "Discard this chain" : `Delete ${title}’s chain`}
          side="left"
          variant="ghost"
          size="icon-sm"
                className="ms-auto text-ink-3 hover:text-attention pointer-coarse:size-11"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
        </TooltipIconButton>
      </div>

      <ol className="flex flex-col gap-1.5">
        {models.map((model, position) => {
          const label = nameOf(model, catalogue);
          const problem = issues.find((issue) => issue.model === position);
          return (
            <li
              key={modelKey(model)}
              data-slot="chain-model"
              data-model={modelKey(model)}
              data-position={position}
              className={cn(
                "flex items-center gap-2 rounded-lg border border-line/60 bg-surface-2 px-2.5 py-1.5",
                problem && "border-attention",
              )}
            >
              <span className="w-4 shrink-0 text-center text-xs text-ink-3 tabular-nums" aria-hidden="true">
                {position + 1}
              </span>
              <ProviderLogo provider={model.provider} className="size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink" title={`${model.provider}/${model.id}`}>
                {label}
              </span>
              {position === 0 ? (
                <Badge variant="outline" className="shrink-0 text-ink-2">
                  Starts the chain
                </Badge>
              ) : null}
              <TooltipIconButton
                tooltip={`Move ${label} up`}
                side="top"
                variant="ghost"
                size="icon-sm"
                className="text-ink-3 pointer-coarse:size-11"
                disabled={busy || position === 0}
                onClick={() => move(position, position - 1)}
              >
                <ArrowUp aria-hidden="true" />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip={`Move ${label} down`}
                side="top"
                variant="ghost"
                size="icon-sm"
                className="text-ink-3 pointer-coarse:size-11"
                disabled={busy || position === models.length - 1}
                onClick={() => move(position, position + 1)}
              >
                <ArrowDown aria-hidden="true" />
              </TooltipIconButton>
              <TooltipIconButton
                // A chain of one is not a chain, so removing from a pair is
                // not an edit — it is deleting the chain, and the row says so
                // rather than refusing afterwards with a sentence about
                // adding a model.
                tooltip={models.length > 2 ? `Remove ${label} from this chain` : "A chain needs two models — delete the chain instead"}
                side="top"
                variant="ghost"
                size="icon-sm"
                className="text-ink-3 hover:text-attention pointer-coarse:size-11"
                disabled={busy || models.length <= 2}
                onClick={() => onChange(models.filter((_, at) => at !== position))}
              >
                <X aria-hidden="true" />
              </TooltipIconButton>
            </li>
          );
        })}
      </ol>

      {issues.length > 0 && (
        <ul data-slot="chain-issues" className="flex flex-col gap-0.5">
          {issues.map((issue) => (
            <li key={`${issue.model ?? "chain"}-${issue.message}`} className="text-xs leading-5 text-attention">
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ProviderModelPicker
          models={addable}
          value=""
          onValueChange={add}
          disabled={busy || addable.length === 0}
          placeholder={models.length === 0 ? "Choose the first model" : "Add a fallback model"}
          className="max-w-72"
          side="bottom"
          align="start"
        />
        {busy && <Loader2 aria-hidden="true" className="size-3.5 text-ink-3 motion-safe:animate-busy" />}
      </div>

      {models.length > 1 && (
        <p className="text-xs leading-5 text-ink-3">
          If a fallback also stops answering, the models above it are tried once each before the next one, unless they failed
          too recently.
        </p>
      )}
    </article>
  );
}
