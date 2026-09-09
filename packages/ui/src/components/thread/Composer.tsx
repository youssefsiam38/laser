import { ComposerPrimitive, useAui, useAuiState, unstable_useMentionAdapter, unstable_useSlashCommandAdapter } from "@assistant-ui/react";
import type { CommandInfo } from "@lasercode/protocol";
import { AtSign, Bot, FileText, FolderOpen, GitFork, History, ListX, Pencil, Plus, Shrink, SlashSquare, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import {
  ComposerAttachButton,
  ComposerAttachmentTile,
  ComposerAttachments,
  ComposerBar,
  ComposerSend,
  ComposerToolbar,
} from "@/components/assistant-ui/elements/composer";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
import { ComposerDraftRestore } from "@/components/assistant-ui/elements/draft-restore";
import { ComposerQueue } from "@/components/assistant-ui/elements/message-queue";
import { ComposerQuotePreview, quoteAsMarkdown } from "@/components/assistant-ui/elements/quote.aui";
import { MobileComposer, MobileComposerButtonClass } from "@/components/assistant-ui/elements/mobile-composer";
import { SessionModelSelector } from "@/components/assistant-ui/elements/model-selector";
import { ThinkingEffort } from "@/components/assistant-ui/elements/reasoning-effort";
import { useRunsForRoot } from "@/agents";
import { DictateButton } from "@/components/mobile";
import { useShell } from "@/components/shell/shell-context";
import { useIsMobile, useIsTouch } from "@/hooks/use-mobile";
import { finishActiveDictation } from "@/pwa";
import { composerSendPlan, useLaserStable, useLaserView, useSessionMeta } from "@/runtime";
import { completeLeadingSlash, matchLeadingSlash, rankSlashCommandMatches } from "./slash-completion.js";
import { StatusLine } from "./StatusLine.js";
import { useProjectFileSearch } from "./use-project-file-search.js";

/**
 * The composer (DESIGN.md "Composer"), composed from the catalog: the
 * `composer` element's card and controls, `message-queue` above it, the
 * `draft-restore` offer, `model-selector`, `reasoning-effort`,
 * `context-display`, and `composer-trigger-popover` for `/` and `@`
 * (docs/ux-elements.md "Composer"). Enter = prompt when idle / a waiting row in
 * the queue while running, Shift+Enter = newline, Cmd/Ctrl+Enter = steer while
 * running — decided by `composerSendPlan` from the runtime module. Interrupting
 * is the deliberate act: this chord, or the Steer button on the row itself
 * (M13-T28). Neither draws a stop notice, because neither stops anything.
 *
 * On a phone the same primitives take the `mobile-composer` layout: a pill
 * between two 44px controls, the microphone inside the pill.
 *
 * Above the card: the draft offer, the queue chips, then the status line
 * (D-20 §5). Nothing reserves space below it; controls explain themselves
 * through tooltips and Settings → Help and shortcuts owns the reference.
 */
export function Composer() {
  useHandedBackText();
  const mobile = useIsMobile();
  const slash = useSlashCommands();
  const mention = useHandleMentions();
  const onInputKeyDown = useComposerKeys();
  const blocked = useNothingToSendTo();
  const disabled = useAuiState((s) => s.thread.isDisabled) || blocked !== undefined;
  const placeholder = usePlaceholder();
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root data-slot="composer" className="relative flex flex-col gap-2">
        <ComposerDraftRestore />
        <ComposerQueue />
        <StatusLine />
        {mobile ? (
          <MobileComposer
            above={
              blocked ? (
                <span className="flex-1" />
              ) : (
                <>
                  <SessionModelSelector />
                  <span className="flex-1" />
                  <ThinkingEffort />
                  <ContextRingButton />
                </>
              )
            }
            leading={<ComposerAttachButton size="icon-lg" className={MobileComposerButtonClass()} />}
            inline={<DictateButton size="icon-lg" />}
            trailing={<SendOrStop mobile />}
            onInputKeyDown={onInputKeyDown}
            disabled={disabled}
            placeholder={placeholder}
          />
        ) : (
          <ComposerPrimitive.AttachmentDropzone asChild>
            <ComposerBar>
              <ComposerAttachments>
                <ComposerPrimitive.Attachments>{() => <ComposerAttachmentTile />}</ComposerPrimitive.Attachments>
              </ComposerAttachments>
              {/* Quoted transcript text rides above the input until it is sent (the `quote` element). */}
              <ComposerQuotePreview />
              <ComposerInput />
              <ComposerToolbar>
                <ComposerAttachButton />
                <DictateButton />
                {/* A model chip reading "No model" and a live thinking dial are
                    both claims about a session that does not exist yet. */}
                {!blocked && <SessionModelSelector />}
                <span className="flex-1" />
                {!blocked && (
                  <>
                    <ThinkingEffort />
                    <ContextRingButton />
                  </>
                )}
                <SendOrStop />
              </ComposerToolbar>
            </ComposerBar>
          </ComposerPrimitive.AttachmentDropzone>
        )}
        {/* `/` runs a laser command; `@` addresses a running subagent by handle. */}
        <ComposerTriggerPopover char="/" title="Commands & skills" matcher={matchLeadingSlash} adapter={slash.adapter} action={slash.action} {...(slash.iconMap ? { iconMap: slash.iconMap } : {})} fallbackIcon={SlashSquare} />
        <ComposerTriggerPopover char="@" title="Files & agents" adapter={mention.adapter} directive={mention.directive} iconMap={MENTION_ICONS} fallbackIcon={AtSign} emptyItemsLabel="No project files or agents to mention yet." isLoading={mention.loading} onQueryChange={mention.setQuery} onOpenChange={mention.setOpen} notice={mention.failed ? <>Couldn’t search project files. <button type="button" className="underline underline-offset-2" onClick={mention.retry}>Try again</button></> : mention.truncated ? 'Showing the best 80 files. Keep typing to narrow the search.' : undefined} />
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

// ---------------------------------------------------------------------------
// Input and keys
// ---------------------------------------------------------------------------

/**
 * The reason nothing can be sent, or `undefined` when something can.
 *
 * With no session open and no project chosen there is nothing to start a
 * session *in*: `threadList.initialize` throws "Pick a project before starting
 * a session", and that throw never reached the screen — the person typed,
 * pressed Enter, and the text simply sat there. A composer that cannot send is
 * disabled and says why, rather than accepting input it will drop.
 */
function useNothingToSendTo(): string | undefined {
  const { currentProject } = useLaserStable();
  const view = useLaserView();
  if (view || currentProject) return undefined;
  return "Open a project first — the agent works inside a folder on this computer.";
}

function usePlaceholder(): string {
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const blocked = useNothingToSendTo();
  if (blocked) return blocked;
  // While the agent works, what Enter does is join the queue — say so, rather
  // than promise an interrupt the person has to ask for separately.
  return disabled ? "Reconnecting to the host…" : running ? "Queue a message…" : "Message the agent…";
}

/**
 * A jump or a fork onto a prompt hands that prompt's text back
 * (`setEditorText`, from the engine's own answer to "what was in that
 * message"). The store parks it on the view; this is where it becomes the
 * composer's text. Taken once, then cleared, so a reload or a re-render never
 * applies it twice — and never over something the person has since typed.
 */
export function useHandedBackText(): void {
  const aui = useAui();
  const { actions } = useLaserStable();
  const view = useLaserView();
  const handedBack = view?.editorText;
  const handedBackPath = view?.path;
  useEffect(() => {
    if (handedBack === undefined || handedBackPath === undefined) return;
    if (handedBack !== "" && aui.composer.getState().text.trim() === "") aui.composer.setText(handedBack);
    actions.takeEditorText(handedBackPath);
  }, [handedBack, handedBackPath, aui, actions]);
}

function useComposerKeys(): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const dictating = useAuiState((s) => s.composer.dictation != null);
  const touch = useIsTouch();
  return (e) => {
    if (e.nativeEvent.isComposing) return;
    const plan = composerSendPlan(e, running);
    // `suppress` still has to call `preventDefault`: the primitive's handler
    // runs after ours and only stands down on a prevented event.
    if (plan.action === "suppress") {
      e.preventDefault();
      return;
    }
    if (plan.action !== "send") return;
    // Touch keyboards: plain Enter is a newline; the Send button submits.
    if (touch && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    if (disabled || !aui.composer.getState().canSend) return;
    const send = () => {
      foldQuote(aui);
      aui.composer.setRunConfig(plan.runConfig);
      aui.composer.send(plan.sendOptions);
    };
    if (dictating) void finishActiveDictation().then(send);
    else send();
  };
}

/**
 * Pi's prompt is plain text, so a quote set from the selection toolbar is
 * folded into the message as a markdown blockquote at send time; the sent
 * message renders it back as a quote (`quote-reply`).
 */
function foldQuote(aui: ReturnType<typeof useAui>): void {
  const composer = aui.composer;
  const { quote, text } = composer.getState();
  if (!quote) return;
  const block = quoteAsMarkdown(quote.text);
  composer.setText(text.trim() ? `${block}\n\n${text}` : block);
  composer.setQuote(undefined);
}

function ComposerInput() {
  const onKeyDown = useComposerKeys();
  // Both hooks run unconditionally: `||` short-circuits, and a hook behind a
  // short circuit is a hook that sometimes does not run.
  const threadDisabled = useAuiState((s) => s.thread.isDisabled);
  const blocked = useNothingToSendTo();
  const disabled = threadDisabled || blocked !== undefined;
  const placeholder = usePlaceholder();
  return (
    <ComposerPrimitive.Input
      rows={1}
      maxRows={8}
      autoFocus
      aria-label="Message"
      placeholder={placeholder}
      submitMode="enter"
      cancelOnEscape={false}
      unstable_insertNewlineOnTouchEnter
      disabled={disabled}
      onKeyDown={onKeyDown}
      className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-base text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
    />
  );
}

function SendOrStop({ mobile = false }: { mobile?: boolean }) {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const empty = useAuiState((s) => s.composer.isEmpty);
  const dictating = useAuiState((s) => s.composer.dictation != null);
  const stop = running && empty;
  const size = mobile ? "icon-lg" : "icon-sm";
  const className = mobile ? MobileComposerButtonClass(true) : undefined;
  if (stop) {
    return (
      <ComposerPrimitive.Cancel asChild>
        <ComposerSend streaming size={size} className={className} />
      </ComposerPrimitive.Cancel>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <ComposerSend
        streaming={false}
        tooltip={running ? "Queue for when this turn ends" : "Send"}
        shortcut="⏎"
        size={size}
        className={className}
        onClick={(event) => {
          const prepare = () => {
            foldQuote(aui);
            aui.composer.setRunConfig({ custom: { streamingBehavior: running ? "pending" : "prompt" } });
          };
          if (!dictating) {
            prepare();
            return;
          }
          event.preventDefault();
          void finishActiveDictation().then(() => {
            prepare();
            aui.composer.send();
          });
        }}
      />
    </ComposerPrimitive.Send>
  );
}

// ---------------------------------------------------------------------------
// `/` — laser's own commands, then everything the agent itself can run in
// this session: the packages' registered commands, the prompt library and the
// skills, from `pi/commands/list`.
//
// Pi's builtin terminal commands (`/model`, `/settings`, `/tree`, `/thinking`)
// are deliberately absent: they open its terminal pickers, and laser has its
// own control for every one of them. A row that opened nothing would be worse
// than no row (R2).
// ---------------------------------------------------------------------------

const SLASH_ICONS = {
  compact: Shrink,
  fork: GitFork,
  rename: Pencil,
  history: History,
  "new": Plus,
  queue: ListX,
  project: FolderOpen,
  feature: Sparkles,
  prompt: FileText,
  skill: Sparkles,
} as const;

/** What the agent can run here. Empty until a session is open, and on any failure. */
function useAgentCommands(): CommandInfo[] {
  const { client, currentProject } = useLaserStable();
  const path = useLaserView()?.path;
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  useEffect(() => {
    const target = path ? { path } : currentProject ? { cwd: currentProject } : undefined;
    if (!target) {
      setCommands([]);
      return;
    }
    let cancelled = false;
    client
      .request("pi/commands/list", target)
      .then((result) => {
        if (!cancelled) setCommands(result.commands);
      })
      // A popover that opens with laser's own commands is a working popover;
      // it must never be a toast about a list nobody asked for.
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, currentProject, path]);
  return commands;
}

function useSlashCommands() {
  const aui = useAui();
  const { actions } = useLaserStable();
  const view = useLaserView();
  const shell = useShell();
  const { running, compacting } = useSessionMeta();
  const busy = running || compacting;
  const agent = useAgentCommands();
  const commands = useMemo(
    () => [
      { id: "compact", label: "/compact", description: busy ? "Waits for the turn to finish" : "Summarise the conversation so far and keep going", icon: "compact", execute: () => void actions.compact() },
      { id: "fork", label: "/fork", description: "Start a new session from the last prompt", icon: "fork", execute: () => void forkFromLastPrompt() },
      { id: "new", label: "/new", description: "A new session in this project", icon: "new", execute: () => void shell.newSession() },
      { id: "queue", label: "/clear-queue", description: "Drop every waiting message back into the composer", icon: "queue", execute: () => void clearQueue() },
      { id: "history", label: "/history", description: "Open the session tree", icon: "history", execute: () => shell.openHistory() },
      { id: "project", label: "/project", description: "Add a project directory", icon: "project", execute: () => shell.setAddProjectOpen(true) },
      ...agent.map((command) => ({
        id: `agent:${command.source}:${command.name}`,
        label: `/${command.name}`,
        description: describeCommand(command),
        icon: command.source,
        // These are the agent's own commands: they run when the message is
        // sent, not when the row is clicked. So the row writes the command into
        // the composer and leaves the cursor after it, ready for arguments.
        // The primitive removes only the leading `/query`. Restore the chosen
        // command in place and keep every argument or line after it intact.
        execute: () => {
          setTimeout(() => {
            const remainder = aui.composer.getState().text;
            aui.composer.setText(completeLeadingSlash(command.name, remainder));
          }, 0);
        },
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callbacks below read the latest values themselves
    [busy, actions, shell, agent],
  );

  async function forkFromLastPrompt() {
    if (!view) return;
    const entries = view.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; id?: string; message?: { role?: string } };
      if (e.type === "message" && e.message?.role === "user" && e.id) return actions.fork(e.id);
    }
    await actions.refreshEntries();
    actions.toast("warning", "Nothing to fork yet: this session has no prompt.");
  }

  async function clearQueue() {
    const text = await actions.clearQueue();
    if (!text) return;
    const current = aui.composer.getState().text;
    aui.composer.setText(current ? `${current}\n${text}` : text);
  }

  const slash = unstable_useSlashCommandAdapter({ commands, removeOnExecute: true, iconMap: SLASH_ICONS });
  const adapter = useMemo(
    () => ({
      ...slash.adapter,
      search: (query: string) => rankSlashCommandMatches(slash.adapter.search?.("") ?? [], query).map((item) => {
        const source = agent.find((command) => item.id === `agent:${command.source}:${command.name}`);
        return { ...item, metadata: { ...item.metadata, kind: source?.source === 'skill' ? 'Skill' : source?.source === 'prompt' ? 'Prompt' : 'Command', ...(source?.filePath ? { filePath: source.filePath } : {}) } };
      }),
    }),
    [slash.adapter, agent],
  );
  return useMemo(() => ({ ...slash, adapter }), [slash, adapter]);
}

// ---------------------------------------------------------------------------
// `@` — a running subagent's handle where the package provides one, then the
// project's files from `pi/project/files`.
//
// One flat list rather than two categories: `@` is nearly always reaching for
// a file, and a drill-down would put a keystroke in front of the common case.
// Handles come first because there are a handful of them and thousands of
// files, so they never get buried.
// ---------------------------------------------------------------------------

const MENTION_ICONS = { agent: Bot, file: FileText } as const;

function useHandleMentions() {
  const view = useLaserView();
  const { currentProject } = useLaserStable();
  const childRuns = useRunsForRoot(view?.path);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const search = useProjectFileSearch(view?.state.cwd ?? currentProject, query, open);
  const files = search.files;
  const items = useMemo(
    () => [
      // @name completes to a child agent of this session, by the name the
      // person gave it when they (or their agent) started it.
      ...childRuns.flatMap((run) =>
        run.subagentName ? [{ id: run.subagentName, type: "agent", label: run.subagentName, description: run.task, icon: "agent" }] : [],
      ),
      ...files.map((file) => ({
        id: file.path,
        type: "file",
        label: file.path,
        // The directory is already in the label, so the second line carries the
        // one thing the path does not say: whether git knows about it yet.
        description: file.tracked ? undefined : "Not tracked by git yet",
        icon: "file",
      })),
    ],
    [childRuns, files],
  );
  const mention = unstable_useMentionAdapter({ items, includeModelContextTools: false, iconMap: MENTION_ICONS });
  const adapter = useMemo(() => ({
    ...mention.adapter,
    search: (nextQuery: string) => {
      const all = mention.adapter.search?.("") ?? [];
      const handles = rankSlashCommandMatches(all.filter((item) => item.type === "agent"), nextQuery);
      // The service already ranks fuzzy path matches across the entire index.
      // Applying the registry's substring filter again would discard them.
      return [...handles, ...(nextQuery === query ? all.filter((item) => item.type === "file") : [])];
    },
  }), [mention.adapter, query]);
  return { ...mention, ...search, adapter, setQuery, setOpen };
}

/** One line under a command row: what it does, and where it came from. */
function describeCommand(command: CommandInfo): string {
  const kind =
    command.source === "prompt" ? "Prompt" : command.source === "skill" ? "Skill" : "Command";
  const where = command.origin ? ` · ${command.origin}` : "";
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return command.description ? `${command.description}${where}` : `${kind}${hint}${where}`;
}
