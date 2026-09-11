"use client";
/**
 * "Move “{title}” to a project" — a Chat session becomes a project's
 * (M13-T58). Mounted once in the shell; the Chat tab's row menu asks through
 * `requestMoveSession` (`move-session.ts`).
 *
 * Nothing is converted or copied: the session keeps its history, its name
 * and its id, and only where it lives changes. So the verb everywhere is
 * *move*, and the one sentence under the title says exactly what happens.
 * The list is the Code tab's projects — current first, then most recently
 * used — with "New project…" last, which runs the same folder choice as the
 * rail's Add project: the operating system's picker inside the desktop app,
 * a typed path in a browser (the host still checks it is a folder). A
 * refusal from the host stays in the dialog, with its reason, so the person
 * can act on it rather than start over.
 *
 * Choosing is one step and moving is another, on purpose: a moved session
 * cannot be moved back to Chat from here, so the row you pick lights up and
 * names the destination on the Move button before anything happens. Enter
 * on a row chooses it and hands focus to that button, so the keyboard path
 * is arrows, Enter, Enter.
 */
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { Check, Folder, FolderPlus, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { desktopFolderPicker } from "./AddProjectDialog.js";
import { clearMoveSessionRequest, orderProjectsForMove, useMoveSessionRequest } from "./move-session.js";
import { sessionsList } from "./session-groups.js";
import { errorText, useShellOptional } from "./shell-context.js";

export function MoveSessionDialog() {
  const request = useMoveSessionRequest();
  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => { if (!open) clearMoveSessionRequest(); }}>
      {/* Keyed on the session so a second question never inherits the first one's choice or error. */}
      {request && <MoveSessionBody key={request.path} path={request.path} title={request.title} />}
    </Dialog>
  );
}

function MoveSessionBody({ path, title }: { path: string; title: string }) {
  const { actions, projects, currentProject, projectInfo } = useLaserStable();
  const shell = useShellOptional();
  const desktop = desktopFolderPicker();
  /** A folder picked or typed for a new project; listed above the known ones once it exists. */
  const [added, setAdded] = useState<string | undefined>(undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  /** The browser has no folder picker: "New project…" opens a path field instead. */
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const moveRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  /** A choice was just made by keyboard or click: the Move button takes focus once it is enabled. */
  const focusMove = useRef(false);

  const ordered = useMemo(() => orderProjectsForMove(projects, currentProject, projectInfo ?? {}), [projects, currentProject, projectInfo]);
  const listed = useMemo(() => (added !== undefined && !ordered.includes(added) ? [added, ...ordered] : ordered), [added, ordered]);
  const destination = typing ? typed.trim() || undefined : chosen;
  const destinationName = destination !== undefined ? shortCwd(destination) : undefined;

  const choose = useCallback((cwd: string) => {
    setTyping(false);
    setChosen(cwd);
    setError(undefined);
    // Enter on a row chose it; the next Enter moves. The button is disabled
    // until the choice renders, so the focus lands after that commit.
    focusMove.current = true;
  }, []);

  useEffect(() => {
    if (!focusMove.current || chosen === undefined) return;
    focusMove.current = false;
    moveRef.current?.focus();
  }, [chosen]);

  const newProject = useCallback(async () => {
    setError(undefined);
    if (!desktop) {
      setTyping(true);
      setChosen(undefined);
      return;
    }
    setPicking(true);
    try {
      const cwd = await desktop.chooseDirectory();
      if (cwd) {
        setAdded(cwd);
        choose(cwd);
      }
    } catch (failure) {
      setError(`Could not open the folder picker. ${errorText(failure)}`);
    } finally {
      setPicking(false);
    }
  }, [choose, desktop]);

  useEffect(() => {
    if (typing) pathRef.current?.focus();
  }, [typing]);

  const confirm = useCallback(async () => {
    if (destination === undefined || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const moved = await actions.moveSession(path, destination);
      const name = shortCwd(destination);
      // The Code tab, with the project's group in view and the session
      // selected under it: the same transcript, in its new home.
      sessionsList.jumpTo(destination);
      clearMoveSessionRequest();
      actions.toast("info", `Moved “${title}” to ${name}. Find it under ${name} in Code.`);
      shell?.showChat();
      void actions.openSession(moved);
    } catch (failure) {
      setError(errorText(failure));
      setPending(false);
    }
  }, [actions, destination, path, pending, shell, title]);

  const busy = pending || picking;
  const hasProjects = listed.length > 0;

  return (
    <DialogContent
      className="sm:max-w-md"
      showCloseButton={false}
      data-slot="move-session-dialog"
      data-picker={desktop ? "native" : "typed"}
      data-chosen={destination}
      onEscapeKeyDown={(event) => {
        // The first Escape leaves the path field; the second closes.
        if (typing && document.activeElement === pathRef.current) {
          event.preventDefault();
          setTyping(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Move “{title}” to a project</DialogTitle>
        <DialogDescription>
          Its history and name come with it. It leaves Chat and appears under{" "}
          {destinationName !== undefined ? <span className="font-medium text-ink">{destinationName}</span> : "the project you choose"} in Code.
        </DialogDescription>
      </DialogHeader>

      {hasProjects ? (
        <Command loop className="rounded-lg border border-line" aria-label="Projects">
          <CommandInput placeholder="Find a project" aria-label="Find a project" disabled={busy} />
          <CommandList className="max-h-60">
            <CommandEmpty>No project matches.</CommandEmpty>
            <CommandGroup heading="Projects">
              {listed.map((cwd) => {
                const name = shortCwd(cwd);
                const isChosen = !typing && chosen === cwd;
                const isCurrent = cwd === currentProject;
                const isNew = cwd === added;
                return (
                  <CommandItem
                    key={cwd}
                    value={cwd}
                    keywords={[name]}
                    disabled={busy}
                    onSelect={() => choose(cwd)}
                    data-slot="move-session-project"
                    data-cwd={cwd}
                    data-chosen={isChosen || undefined}
                    aria-checked={isChosen}
                    className="pointer-coarse:min-h-11"
                  >
                    {isNew ? <FolderPlus className="text-live" /> : <Folder />}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-sm leading-5 text-ink">{name}</span>
                        {isNew ? <span className="eyebrow shrink-0 text-live">New</span> : isCurrent ? <span className="eyebrow shrink-0">Current</span> : null}
                      </span>
                      <span className="truncate typed text-ink-3" title={cwd}>{cwd}</span>
                    </span>
                    <Check aria-hidden="true" className={cn("shrink-0 text-live transition-opacity duration-(--motion-instant) motion-reduce:transition-none", isChosen ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup forceMount>
              <CommandItem
                forceMount
                value="new-project"
                disabled={busy}
                onSelect={() => void newProject()}
                data-slot="move-session-new"
                data-state={typing ? "open" : undefined}
                className="pointer-coarse:min-h-11"
              >
                {picking ? <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" /> : <FolderPlus />}
                <span className="text-sm leading-5 text-ink">New project…</span>
                <span className="ms-auto text-xs leading-4 text-ink-3">{desktop ? "Choose a folder" : "Type a path"}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <p className="text-sm leading-5 text-ink-2">There are no projects yet. Choose a folder on this computer and it becomes one.</p>
          <Button variant="outline" size="sm" className="self-start pointer-coarse:min-h-11" disabled={busy} onClick={() => void newProject()} data-slot="move-session-new">
            {picking ? <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" /> : <FolderPlus />}
            New project…
          </Button>
        </div>
      )}

      {typing && (
        <div className="flex flex-col gap-1.5" data-slot="move-session-path">
          <label htmlFor={`move-session-path-${title.length}`} className="eyebrow">
            Folder on the computer running {PRODUCT_DISPLAY_NAME}
          </label>
          <Input
            ref={pathRef}
            id={`move-session-path-${title.length}`}
            value={typed}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder="/home/you/code/project"
            onChange={(event) => {
              setTyped(event.target.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && typed.trim()) {
                event.preventDefault();
                void confirm();
              }
            }}
            className="typed"
          />
          <p className="text-xs leading-4 text-ink-3">An absolute path to a folder that already exists. It is added to your projects when the session moves.</p>
        </div>
      )}

      {error && (
        <p role="alert" className="border-s-2 border-danger ps-3 text-sm leading-sm text-ink">
          <span className="font-medium text-danger">Could not move “{title}”.</span> {error}
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={clearMoveSessionRequest} disabled={pending} className="pointer-coarse:min-h-11">
          Cancel
        </Button>
        <Button
          ref={moveRef}
          onClick={() => void confirm()}
          disabled={destination === undefined || busy}
          aria-busy={pending || undefined}
          data-slot="move-session-confirm"
          className="pointer-coarse:min-h-11"
        >
          {pending ? <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" /> : null}
          {pending ? "Moving…" : error ? "Try again" : destinationName !== undefined ? `Move to ${destinationName}` : "Move"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
