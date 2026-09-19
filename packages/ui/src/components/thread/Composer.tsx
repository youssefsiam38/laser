import { ComposerPrimitive, useAui, useAuiState, unstable_useMentionAdapter, unstable_useSlashCommandAdapter, type Unstable_TriggerItem } from "@assistant-ui/react";
import type { CommandInfo } from "@lasercode/protocol";
import { AtSign, Bot, ChevronLeft, ChevronRight, FileText, FolderOpen, GitFork, History, ListX, Pencil, Plus, Shrink, SlashSquare, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { SessionAgentSelector } from "@/components/assistant-ui/elements/agent-selector";
import {
  ComposerAttachButton,
  ComposerActions,
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
import { CapabilityNotice } from "@/components/capability-gate";
import { errorText, useShell } from "@/components/shell/shell-context";
import { useIsMobile, useIsTouch } from "@/hooks/use-mobile";
import { finishActiveDictation } from "@/pwa";
import { appendAttachedPrompt, splitAttachedFiles, wrapFileAttachment } from "@/runtime/attachments";
import { composerSendPlan, mainCodeProject, mainError, mainTab, provisionalSessionPath, useCapability, useLaserStable, useLaserState, useSessionMeta, visibleSessionPath } from "@/runtime";
import { mergeRunConfigCustom } from "@/runtime/first-turn";
import { completeLeadingSlash, matchLeadingSlash, rankSlashCommandMatches } from "./slash-completion.js";
import { StatusLine } from "./StatusLine.js";
import { LAST_PROMPT_MESSAGES, lastPromptEntry, lastPromptMessage } from "./last-prompt.js";
import { SessionPreparationProvider, useSessionPreparation } from "./session-preparation.js";
import { useDirectoryPage } from "./use-directory-page.js";
import { ComposerMentionField } from "./composer-mention-tags.js";
import { createFinishedMentions, type FinishedMentions } from "./finished-mentions.js";
import { explorerItems, explorerNavigation, explorerPageItem, mentionFormatter, mentionItemId } from "./project-explorer-model.js";
import { useTranscriptViewport } from "./transcript-viewport.js";

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
  return <SessionPreparationProvider><ComposerBody /></SessionPreparationProvider>;
}

function ComposerBody() {
  useHandedBackText();
  const mobile = useIsMobile();
  const dictating = useAuiState((s) => s.composer.dictation != null);
  const slash = useSlashCommands();
  const mention = useHandleMentions();
  const onInputKeyDown = useComposerKeys();
  const blocked = useNothingToSendTo();
  const { pending: preparingSession } = useSessionPreparation();
  const { destination } = useLaserStable();
  const allowProjectLanding = !destination || mainTab(destination) !== "chat";
  // Both hooks run unconditionally: `||` short-circuits, and a hook behind a
  // short circuit is a hook that sometimes does not run.
  const threadDisabled = useAuiState((s) => s.thread.isDisabled);
  const noDestination = useNoComposerDestination();
  // Only a composer with nowhere to write is inert. A fenced one still takes
  // the person's words; it simply cannot send them yet (RP-11).
  const inert = threadDisabled || noDestination !== undefined;
  const canSend = useAuiState((s) => s.composer.canSend);
  const transcript = useTranscriptViewport();
  const destinationBusy = destination?.phase === "resolving";
  const placeholder = usePlaceholder();
  const write = useCapability("session/prompt", { presentation: "explained" });
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root data-slot="composer" inert={inert} aria-busy={preparingSession || destinationBusy || undefined} className="relative flex flex-col gap-2" onSubmit={() => { if (canSend) transcript.latest(); }}>
        <ComposerDraftRestore />
        <ComposerQueue />
        <StatusLine />
        {write.state !== "available" ? (
          write.state === "explained" ? <CapabilityNotice title="This conversation is read-only here" explanation={write.explanation} /> : null
        ) : <>
        {mobile ? <StagedAttachments /> : null}
        {mobile ? (
          <MobileComposer
            above={
              blocked ? (
                <span className="flex-1" />
              ) : (
                <>
                  <DictateButton size="icon-lg" touchSized />
                  {!dictating && <>
                    <SessionAgentSelector allowProjectLanding={allowProjectLanding} />
                    <SessionModelSelector />
                    <span className="flex-1" />
                    <ThinkingEffort allowProjectLanding={allowProjectLanding} />
                    <ContextRingButton />
                  </>}
                </>
              )
            }
            leading={<ComposerAttachButton size="icon-lg" className={MobileComposerButtonClass()} />}
            trailing={<SendOrStop mobile />}
            onInputKeyDown={onInputKeyDown}
            disabled={inert}
            placeholder={placeholder}
            renderInput={(field) => <ComposerMentionField mentions={mention.mentions} {...field} />}
          />
        ) : (
          <ComposerPrimitive.AttachmentDropzone asChild>
            <ComposerBar>
              <StagedAttachments />
              {/* Quoted transcript text rides above the input until it is sent (the `quote` element). */}
              <ComposerQuotePreview />
              <ComposerInput mentions={mention.mentions} />
              <ComposerToolbar>
                <ComposerAttachButton />
                {/* Keep this one mounted control in the same flex item while it
                    grows into the recording row; remounting ends its owned capture. */}
                <DictateButton />
                <ComposerActions>
                  {/* Agent and thinking choices can prepare an empty session;
                      the model choice retains its separate project-default path. */}
                  {!blocked && <SessionAgentSelector allowProjectLanding={allowProjectLanding} />}
                  {!blocked && <SessionModelSelector />}
                  {!blocked && <ThinkingEffort allowProjectLanding={allowProjectLanding} />}
                  {!blocked && <ContextRingButton />}
                  <SendOrStop />
                </ComposerActions>
              </ComposerToolbar>
            </ComposerBar>
          </ComposerPrimitive.AttachmentDropzone>
        )}
        {/* `/` runs a laser command; `@` addresses a running subagent by handle. */}
        <ComposerTriggerPopover char="/" title="Commands & skills" matcher={matchLeadingSlash} adapter={slash.adapter} action={slash.action} onComplete={completeSlashDraft} {...(slash.iconMap ? { iconMap: slash.iconMap } : {})} fallbackIcon={SlashSquare} />
        <ComposerTriggerPopover char="@" title="Files & agents" matcher={mention.mentions.matcher} adapter={mention.adapter} directive={mention.directive} navigation={mention.navigation} iconMap={MENTION_ICONS} fallbackIcon={AtSign} emptyItemsLabel="This folder is empty." unavailableLabel={mention.issue ? mention.issue.kind === 'refusal' ? 'Update the path to continue.' : 'Retry to load this folder.' : undefined} loadingLabel="Reading this folder…" isLoading={mention.loading} onQueryChange={mention.setQuery} onOpenChange={mention.setOpen} notice={mention.issue ? <>{mention.issue.message}{mention.retry && <button type="button" className="min-h-11 rounded-md px-2 underline underline-offset-2 focus-visible:outline focus-visible:outline-live" onClick={mention.retry}>Try again</button>}</> : <span className="block truncate" dir="ltr">{mention.directory ?? 'Choose a conversation to browse files.'}</span>} />
        </>}
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

// ---------------------------------------------------------------------------
// Input and keys
// ---------------------------------------------------------------------------

/**
 * Nothing this composer could ever write to, or `undefined`.
 *
 * With no session open and no project chosen there is nothing to start a
 * session *in*: `threadList.initialize` throws "Pick a project before starting
 * a session", and that throw never reached the screen — the person typed,
 * pressed Enter, and the text simply sat there.
 *
 * This is also the **only** state in which typing itself is refused (RP-11).
 * A host that has not answered yet, a dropped socket or a conversation still
 * resolving all block *sending*; the words stay where the person put them.
 */
function useNothingToSendTo(): string | undefined {
  const { destination, currentProject } = useLaserStable();
  const workerCrashed = useLaserState((s) => {
    const path = visibleSessionPath(s);
    const cwd = path ? s.open[path]?.state.cwd ?? s.sessions.find((summary) => summary.path === path)?.cwd : undefined;
    return cwd ? s.workers[cwd]?.status === "crashed" : false;
  });
  // Whether a session is open here, not what is in it: the composer must not
  // re-render for a streamed token (M16-T32).
  const view = useLaserState(s => Boolean(s.current && s.open[s.current]));
  if (workerCrashed) return "The agent is unavailable";
  if (destination?.phase === "resolving") {
    return mainTab(destination) === "chat" ? undefined : "Opening this conversation…";
  }
  if (destination?.phase === "unavailable") {
    return mainError(destination) ?? "This conversation is unavailable. Retry it or start a new one.";
  }
  if (destination?.phase === "ready-chat" && destination.chat.kind === "landing") return undefined;
  if (view || (!destination ? currentProject !== undefined : mainTab(destination) === "code" && mainCodeProject(destination) !== undefined)) return undefined;
  return "Open a project first — the agent works inside a folder on this computer.";
}

/** The composer has nowhere at all to write to: the one case that takes typing away. */
function useNoComposerDestination(): string | undefined {
  const { destination } = useLaserStable();
  const blocked = useNothingToSendTo();
  if (destination?.phase === "resolving" || destination?.phase === "unavailable") return undefined;
  return blocked;
}

/**
 * The reason this composer cannot send yet, or `undefined`.
 *
 * Send admission only. Everything here leaves the draft editable: a
 * conversation still resolving (including one painted from this device's cache,
 * which the host has not confirmed), a conversation that failed to open, a
 * socket that is not up, and a session being created. The imperative
 * `assertCanAct`/`requireCurrent` guards in the runtime remain the guarantee;
 * this is what the person is told.
 */
function useSendBlockedReason(): string | undefined {
  const blocked = useNothingToSendTo();
  const connection = useLaserState(s => s.connection);
  const provisional = useLaserState(s => provisionalSessionPath(s) !== undefined);
  const destination = useLaserState(s => s.destination);
  const { pending: preparingSession } = useSessionPreparation();
  if (provisional && mainTab(destination) !== "chat") return "Checking with the host before sending…";
  if (blocked) return blocked;
  if (connection !== "open") return connection === "connecting" ? "Reconnecting to the host…" : "Disconnected from the host…";
  return preparingSession ? "Preparing this conversation…" : undefined;
}

function StagedAttachments() {
  return <ComposerAttachments><ComposerPrimitive.Attachments>{() => <ComposerAttachmentTile />}</ComposerPrimitive.Attachments></ComposerAttachments>;
}

function usePlaceholder(): string {
  const running = useAuiState((s) => s.thread.isRunning);
  const sendBlocked = useSendBlockedReason();
  if (sendBlocked) return sendBlocked;
  // While the agent works, what Enter does is join the queue — say so, rather
  // than promise an interrupt the person has to ask for separately.
  return running ? "Queue a message…" : "Message the agent…";
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
  const handedBack = useLaserState(s => (s.current ? s.open[s.current]?.editorText : undefined));
  const handedBackPath = useLaserState(s => (s.current ? s.open[s.current]?.path : undefined));
  const composerPath = useAuiState(s => s.threadListItem.externalId ?? s.threadListItem.remoteId);
  useEffect(() => {
    // The destination store commits before assistant-ui's controlled thread
    // selection settles. Never consume the new session's text in the old
    // thread's composer: that draft stays behind when the runtime switches.
    if (handedBack === undefined || handedBackPath === undefined || composerPath !== handedBackPath) return;
    const draft = aui.composer.getState();
    if (handedBack !== "" && draft.text.trim() === "" && draft.attachments.length === 0 && !draft.quote) {
      const parsed = splitAttachedFiles(handedBack);
      aui.composer.setText(parsed.text);
      for (const file of parsed.files) void aui.composer.addAttachment({ id: crypto.randomUUID(), type: "document", name: file.name, contentType: file.mediaType, content: [{ type: "text", text: wrapFileAttachment(file) }] });
    }
    actions.takeEditorText(handedBackPath);
  }, [handedBack, handedBackPath, composerPath, aui, actions]);
}

function setComposerStreamingBehavior(aui: ReturnType<typeof useAui>, streamingBehavior: "prompt" | "pending" | "steer" | "followUp"): void {
  const current = aui.composer.getState().runConfig;
  aui.composer.setRunConfig(mergeRunConfigCustom(current, { streamingBehavior }));
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
      setComposerStreamingBehavior(aui, plan.runConfig.custom.streamingBehavior);
      aui.composer.send(plan.sendOptions);
    };
    if (dictating) void finishActiveDictation().then((finished) => { if (finished) send(); });
    else send();
  };
}

/**
 * Pi's prompt is plain text, so a quote set from the message menu or keyboard
 * action is folded into the message as a markdown blockquote at send time; the
 * sent message renders it back as a quote (`quote-reply`).
 */
function foldQuote(aui: ReturnType<typeof useAui>): void {
  const composer = aui.composer;
  const { quote, text } = composer.getState();
  if (!quote) return;
  const block = quoteAsMarkdown(quote.text);
  composer.setText(text.trim() ? `${block}\n\n${text}` : block);
  composer.setQuote(undefined);
}

function ComposerInput({ mentions }: { mentions: FinishedMentions }) {
  const onKeyDown = useComposerKeys();
  // Both hooks run unconditionally: `||` short-circuits, and a hook behind a
  // short circuit is a hook that sometimes does not run.
  const threadDisabled = useAuiState((s) => s.thread.isDisabled);
  const noDestination = useNoComposerDestination();
  // Typing is never taken away for a fence the host owns (RP-11).
  const disabled = threadDisabled || noDestination !== undefined;
  const placeholder = usePlaceholder();
  return (
    <ComposerMentionField
      mentions={mentions}
      dir="auto"
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
  const transcript = useTranscriptViewport();
  const running = useAuiState((s) => s.thread.isRunning);
  const empty = useAuiState((s) => s.composer.isEmpty);
  const dictating = useAuiState((s) => s.composer.dictation != null);
  const threadDisabled = useAuiState((s) => s.thread.isDisabled);
  const sendBlocked = useSendBlockedReason();
  const disabled = threadDisabled || sendBlocked !== undefined;
  const stop = running && empty && !disabled;
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
        disabled={disabled}
        className={className}
        onClick={(event) => {
          const prepare = () => {
            transcript.latest();
            foldQuote(aui);
            setComposerStreamingBehavior(aui, running ? "pending" : "prompt");
          };
          if (!dictating) {
            prepare();
            return;
          }
          event.preventDefault();
          void finishActiveDictation().then((finished) => {
            if (!finished) return;
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
//
// Two gestures, and they are not the same one (M15-T5). **Tab completes**:
// `completeSlashDraft` writes the command's word and stops — nothing runs and
// nothing is sent, whatever the row does. **Enter, or a click, chooses**: an
// agent's command is written out for its arguments, and one of laser's own
// runs, because choosing it is what asking for it looks like.
// ---------------------------------------------------------------------------

/** The `@` picker's rows: what each kind of result looks like in the list. */
const MENTION_ICONS = { agent: Bot, file: FileText, directory: FolderOpen, next: ChevronRight, previous: ChevronLeft } as const;

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
  const path = useLaserState(s => (s.current ? s.open[s.current]?.path : undefined));
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
  const { actions, client } = useLaserStable();
  // `/fork` needs the tree and the branch it sits on, and it reads both from
  // the host when the command runs (as `TopBar` and `CommandPalette` do): the
  // view this hook rendered with deliberately ignores entries so a streamed
  // token does not re-render the composer, so forking from it would fork one
  // batch behind — or claim there is no prompt at all (M16-T48). Only the
  // session path is read here, and it changes only when the session does.
  const sessionPath = useLaserState(s => s.current);
  const shell = useShell();
  const { running, compacting } = useSessionMeta();
  const addProject = useCapability("pi/project/add");
  const busy = running || compacting;
  const agent = useAgentCommands();
  const commands = useMemo(
    () => [
      { id: "compact", label: "/compact", description: busy ? "Waits for the turn to finish" : "Summarise the conversation so far and keep going", icon: "compact", execute: () => void actions.compact() },
      { id: "fork", label: "/fork", description: "Start a new session from the last prompt", icon: "fork", execute: () => void forkFromLastPrompt() },
      { id: "new", label: "/new", description: "A new session in this project", icon: "new", execute: () => void shell.newSession() },
      { id: "queue", label: "/clear-queue", description: "Drop every waiting message back into the composer", icon: "queue", execute: () => void clearQueue() },
      { id: "history", label: "/history", description: "Open the session tree", icon: "history", execute: () => shell.openHistory() },
      ...(addProject.state === "available" ? [{ id: "project", label: "/project", description: "Add a project directory", icon: "project", execute: () => shell.setAddProjectOpen(true) }] : []),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `aui` is stable; every other value the callbacks read is a dependency
    [busy, actions, client, sessionPath, shell, agent, addProject.state],
  );

  /** The host's tree, at the moment of the command — never the rendered view's. */
  async function forkFromLastPrompt() {
    if (!sessionPath) return;
    try {
      const found = await lastPromptEntry(params => client.request("pi/session/entries", params), sessionPath);
      if (found.entryId) {
        await actions.fork(found.entryId);
        return;
      }
      actions.toast("warning", lastPromptMessage(found) ?? LAST_PROMPT_MESSAGES["no-prompt"]);
    } catch (error) {
      actions.toast("error", errorText(error));
    }
  }

  async function clearQueue() {
    await appendAttachedPrompt(aui.composer, await actions.clearQueue());
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
// `@` — child handles first, then one host-sorted directory page. Enter or
// click inserts files/folders; `/` alone descends into the highlighted folder.
// ---------------------------------------------------------------------------

function useHandleMentions() {
  // One record per composer: Beam's bubble and the session's own composer each
  // hold their own draft, so neither can finish the other's mention.
  const mentionsRef = useRef<FinishedMentions>(undefined);
  mentionsRef.current ??= createFinishedMentions();
  const mentions = mentionsRef.current;
  const path = useLaserState(s => (s.current ? s.open[s.current]?.path : undefined));
  const sessionCwd = useLaserState(s => (s.current ? s.open[s.current]?.state.cwd : undefined));
  const { currentProject } = useLaserStable();
  const childRuns = useRunsForRoot(path);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const cwd = sessionCwd ?? currentProject;
  const page = useDirectoryPage(cwd, query, open);
  const items = useMemo(
    () => [
      // @name completes to a child agent of this session, by the name the
      // person gave it when they (or their agent) started it.
      ...childRuns.flatMap((run) =>
        run.subagentName ? [{ id: mentionItemId("agent", JSON.stringify([run.runId, run.subagentName])), type: "agent", label: run.subagentName, description: run.task, icon: "agent" }] : [],
      ),
    ],
    [childRuns],
  );
  const mention = unstable_useMentionAdapter({ items, includeModelContextTools: false, iconMap: MENTION_ICONS });
  const adapter = useMemo(() => ({
    ...mention.adapter,
    search: (nextQuery: string) => {
      const all = (mention.adapter.search?.("") ?? []).map(item => ({ ...item, metadata: { ...item.metadata, identity: item.label } }));
      const handles = /[/\\\\~]/u.test(nextQuery) ? [] : rankSlashCommandMatches(all, nextQuery);
      if (nextQuery !== query) return handles;
      return [...handles,
        ...(page.navigation.previous ? [explorerPageItem("previous")] : []),
        ...explorerItems(page.entries, cwd ?? ""),
        ...(page.navigation.next ? [explorerPageItem("next")] : []),
      ];
    },
  }), [mention.adapter, query, page.entries, cwd, page.navigation.next, page.navigation.previous]);
  const navigation = explorerNavigation(page.navigation);
  // The insertion is the moment the choice is made, and the only place that
  // knows the exact range it wrote; everything after it is ordinary typing.
  const directive = useMemo(
    () => ({ ...mention.directive, formatter: mentionFormatter, onInserted: (item: Unstable_TriggerItem) => mentions.noteInsertion(item) }),
    [mention.directive, mentions],
  );
  return { adapter, directive, mentions, navigation, loading: page.loading,
    issue: page.issue, retry: page.retry, directory: page.directory, setQuery, setOpen };
}

/**
 * What Tab writes (M15-T5). Completion is not selection: it puts the command's
 * own word in the draft and stops there, so a command that *does* something —
 * laser's own `/compact`, `/fork`, `/new` — runs only when the person chooses
 * the row (Enter, or a click) or sends the message they can now read.
 *
 * The word is completed without a trailing space, the way a shell completes
 * one: the caret lands at the end of it, which is still inside the command
 * token, so the picker stays open on the exact match and the next Enter is a
 * deliberate choice rather than a surprise. Typing a space moves past the
 * command and the picker leaves, as it does for anything else typed there.
 * Arguments already in the draft are kept exactly where they were.
 */
function completeSlashDraft(item: { id: string; label?: string | undefined }, text: string): { text: string; caret: number } | null {
  const name = (item.label ?? item.id).replace(/^\//u, "");
  if (name === "" || !text.startsWith("/")) return null;
  const whitespace = text.search(/\s/u);
  const completed = whitespace === -1 ? `/${name}` : completeLeadingSlash(name, text.slice(whitespace));
  return { text: completed, caret: name.length + 1 };
}

/** One line under a command row: what it does, and where it came from. */
function describeCommand(command: CommandInfo): string {
  const kind =
    command.source === "prompt" ? "Prompt" : command.source === "skill" ? "Skill" : "Command";
  const where = command.origin ? ` · ${command.origin}` : "";
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return command.description ? `${command.description}${where}` : `${kind}${hint}${where}`;
}
