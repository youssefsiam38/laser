"use client";
/**
 * + Create — one dialog for every kind (D-355, "Structure").
 *
 * Pick a kind, type the one thing that kind is *about*, and it exists. Nothing
 * above it is required: a Plan needs no Spec, a Design needs no Research, a
 * Task needs no Plan (D-352). The next key is shown before creating, so the
 * thing a person is about to name already has a handle.
 *
 * The text is the whole input, exactly as `/spec <text>` is: it becomes the
 * brief, the question or the outcome of the first revision. Everything else in
 * the body starts empty because it *is* empty.
 */
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PROJECT_WORK_KEY_PREFIXES, PROJECT_WORK_KINDS, parseProjectWorkKey, type ProjectWorkKind } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useCapability, useLaserStable } from "@/runtime";
import { openWorkCreate, selectWork, setWorkspaceTab, useProjectWorkSnapshot, useWorkspaceUi, type ProjectWorkStore } from "@/project-work";
import { KIND_FIELD, KIND_ICON, KIND_LABEL, KIND_TEXT } from "@/project-work/vocabulary";

import { WorkRefusal } from "./states.js";

/**
 * The key this project will hand out next, from what this window has read.
 *
 * Keys are monotonic and never reused, so the highest one seen plus one is
 * what the store mints — unless this window is behind, which is why the label
 * beside it says the number is assigned when it is created.
 */
export function nextKeyFor(kind: ProjectWorkKind, keys: readonly string[]): string {
  let highest = 0;
  for (const key of keys) {
    const parsed = parseProjectWorkKey(key);
    if (parsed?.kind === kind && parsed.number > highest) highest = parsed.number;
  }
  return `${PROJECT_WORK_KEY_PREFIXES[kind]}-${highest + 1}`;
}

export function CreateDialog({ store }: { store: ProjectWorkStore | undefined }) {
  const ui = useWorkspaceUi();
  const work = useProjectWorkSnapshot(store);
  const { actions } = useLaserStable();
  const create = useCapability("project/work/create", { presentation: "explained" });
  const [kind, setKind] = useState<ProjectWorkKind>("spec");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const open = ui.creating !== undefined;
  useEffect(() => {
    if (!open) return;
    setKind(ui.creating ?? "spec");
    setTitle("");
    setText("");
    setError(undefined);
  }, [open, ui.creating]);

  const nextKey = useMemo(() => nextKeyFor(kind, work.items.map((item) => item.key)), [kind, work.items]);
  const field = KIND_FIELD[kind];

  const submit = async (): Promise<void> => {
    if (!store || title.trim() === "" || text.trim() === "") return;
    setBusy(true);
    const outcome = await store.create({ kind, title: title.trim(), text });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    const { entity } = outcome.value;
    actions.toast("info", `${entity.key} created`);
    openWorkCreate(undefined);
    setWorkspaceTab("work");
    selectWork({ entityId: entity.entityId, kind: entity.kind });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => openWorkCreate(next ? kind : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create project work</DialogTitle>
          <DialogDescription>
            It belongs to this project, not to a conversation, and nothing above it is required. Any kind can exist on its own.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Kind</legend>
          {PROJECT_WORK_KINDS.map((candidate) => {
            const Icon = KIND_ICON[candidate];
            const on = candidate === kind;
            return (
              <button
                key={candidate}
                type="button"
                aria-pressed={on}
                onClick={() => setKind(candidate)}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm leading-5 outline-none",
                  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                  on ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-3.5", KIND_TEXT[candidate])} />
                {KIND_LABEL[candidate]}
              </button>
            );
          })}
        </fieldset>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="eyebrow">Title</span>
              <span className="text-xs leading-xs text-ink-3">
                Next key <span className="typed text-ink-2">{nextKey}</span> · assigned when it is created
              </span>
            </span>
            <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`What this ${KIND_LABEL[kind].toLocaleLowerCase()} is called`} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">{field.label}</span>
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={field.placeholder}
              className="max-h-48 min-h-24 text-sm"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </label>

          {create.state === "explained" ? <p className="text-xs leading-xs text-ink-2">{create.explanation}</p> : null}
          {error ? <WorkRefusal message={error} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => openWorkCreate(undefined)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !store || create.state !== "available" || title.trim() === "" || text.trim() === ""}>
              <Plus />
              Create {KIND_LABEL[kind].toLocaleLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
