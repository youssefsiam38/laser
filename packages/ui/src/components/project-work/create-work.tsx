"use client";
/**
 * `/spec`, `/research`, `/design` and `/plan`, from any session (D-352).
 *
 * Each works by itself, and **the text beside the command is the whole
 * input**: `/plan ship the relay` records "ship the relay" as the Plan's own
 * brief and produces the Plan — no Spec, no gate, nothing above it. With no
 * text the same command opens Create with that kind chosen, because an empty
 * artifact with an empty brief is not worth creating.
 *
 * Ownership is the one hard rule: every artifact belongs to a project. In a
 * project session the command uses that project. In a projectless Chat it
 * asks which project first — the same list as "Move to a project", current
 * first, then most recently used, "New project…" last — creates the artifact
 * there, and leaves the chat projectless.
 */
import { Folder, FolderPlus } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import type { ProjectWorkKind } from "@lasercode/protocol";

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { orderProjectsForMove } from "@/components/shell/move-session";
import { useShellOptional } from "@/components/shell/shell-context";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { openWorkCreate, openWorkspace, resolveProjectWork, selectWork, setWorkspaceTab } from "@/project-work";
import { KIND_ICON, KIND_LABEL } from "@/project-work/vocabulary";

/**
 * The title of something whose whole input was one piece of text.
 *
 * The first line, cut on a word boundary. The full text stays as the brief,
 * the question or the outcome — nothing typed is lost to the title.
 */
export function titleFromText(text: string, max = 80): string {
  const first = text.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface WorkCreationRequest {
  kind: ProjectWorkKind;
  text: string;
  sessionId?: string | undefined;
}

let pending: WorkCreationRequest | undefined;
const listeners = new Set<() => void>();
const publish = (): void => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = (): WorkCreationRequest | undefined => pending;
const none = (): WorkCreationRequest | undefined => undefined;

export function useWorkCreationRequest(): WorkCreationRequest | undefined {
  return useSyncExternalStore(subscribe, read, none);
}

export function clearWorkCreationRequest(): void {
  if (!pending) return;
  pending = undefined;
  publish();
}

export interface StartWorkOptions extends WorkCreationRequest {
  /** The project this session is in, when it is in one. */
  cwd?: string | undefined;
  toast?: ((level: "info" | "warning" | "error", text: string) => void) | undefined;
}

/**
 * Run one of the four commands. Resolves the project, creates the artifact
 * from the text, and opens the workspace on exactly what was created.
 */
export async function startProjectWork(options: StartWorkOptions): Promise<void> {
  const { kind, text, cwd, toast } = options;
  if (!cwd) {
    // A projectless chat: ask which project, and keep the text until it has
    // somewhere to go.
    pending = { kind, text, ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
    publish();
    return;
  }
  const store = await resolveProjectWork(cwd);
  if (!store) {
    toast?.("error", "This project's work could not be opened. Check the connection and try again.");
    return;
  }
  const projectId = store.getSnapshot().projectId;
  if (projectId) openWorkspace({ projectId });

  const brief = text.trim();
  if (brief === "") {
    // Nothing to write yet: the dialog is the honest next step, with the kind
    // already chosen and the next key already on screen.
    openWorkCreate(kind);
    return;
  }

  const outcome = await store.create({
    kind,
    title: titleFromText(brief),
    text: brief,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  });
  if (!outcome.ok) {
    toast?.("error", outcome.failure.message);
    return;
  }
  const { entity } = outcome.value;
  setWorkspaceTab("work");
  selectWork({ entityId: entity.entityId, kind: entity.kind });
  toast?.("info", `${entity.key} created`);
}

/**
 * The project picker a projectless Chat sees first. Mounted once by the shell.
 * The chat stays projectless: only the artifact lands in the chosen project.
 */
export function WorkProjectPicker() {
  const request = useWorkCreationRequest();
  const { actions, projects, currentProject, projectInfo } = useLaserStable();
  const shell = useShellOptional();
  const [query, setQuery] = useState("");
  const ordered = useMemo(() => orderProjectsForMove(projects, currentProject, projectInfo ?? {}), [currentProject, projectInfo, projects]);

  if (!request) return null;
  const Icon = KIND_ICON[request.kind];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : clearWorkCreationRequest())}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon aria-hidden="true" className="size-4" />
            Which project does this {KIND_LABEL[request.kind].toLocaleLowerCase()} belong to?
          </DialogTitle>
          <DialogDescription>
            Project work always belongs to a project. This chat stays as it is — only the {KIND_LABEL[request.kind].toLocaleLowerCase()} lands there.
          </DialogDescription>
        </DialogHeader>
        <Command className="max-h-72">
          <CommandInput placeholder="Find a project" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No project by that name.</CommandEmpty>
            <CommandGroup>
              {ordered.map((cwd) => (
                <CommandItem
                  key={cwd}
                  value={cwd}
                  onSelect={() => {
                    const chosen = { ...request, cwd };
                    clearWorkCreationRequest();
                    void startProjectWork({ ...chosen, toast: actions.toast });
                  }}
                  className={cn("gap-2", cwd === currentProject && "font-medium")}
                >
                  <Folder className="size-4 text-ink-3" />
                  <span className="min-w-0 truncate">{shortCwd(cwd)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="new-project"
                onSelect={() => {
                  // The one folder choice the app has; the picker stays open
                  // behind it so the text is not lost.
                  shell?.setAddProjectOpen(true);
                }}
                className="gap-2"
              >
                <FolderPlus className="size-4 text-ink-3" />
                New project…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
