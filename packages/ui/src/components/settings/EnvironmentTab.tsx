"use client";
/**
 * Settings → Environment (M16-T17).
 *
 * A project can name one program that decides the environment its commands run
 * with. Laser does not know or care where the values come from; it runs the
 * program and applies what it returns.
 *
 * Nothing on this screen ever shows a value. Testing a command reports the
 * variable **names** it would set and the ones it would remove, because that is
 * what a person needs in order to tell whether it is the right command — and
 * because a screenshot of this screen should be safe to send to someone.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleSlash, PlayCircle, RefreshCw, ShieldQuestion } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { PRODUCT_DISPLAY_NAME, type ProjectEnvState, type ProjectEnvStatus } from "@lasercode/protocol";

import { Empty } from "./SettingsScreen.js";

const TONE: Record<ProjectEnvState, string> = {
  ready: "text-ok",
  failed: "text-danger",
  "needs-approval": "text-attention",
  untrusted: "text-attention",
  off: "text-ink-3",
  "not-configured": "text-ink-3",
};

const ICON: Record<ProjectEnvState, typeof CircleCheck> = {
  ready: CircleCheck,
  failed: CircleAlert,
  "needs-approval": ShieldQuestion,
  untrusted: ShieldQuestion,
  off: CircleSlash,
  "not-configured": CircleSlash,
};

function headline(status: ProjectEnvStatus): string {
  switch (status.state) {
    case "ready":
      return `Ready · ${status.names?.length ?? 0} variables for this project's commands`;
    case "failed":
      return status.error ?? "The environment command did not finish.";
    case "needs-approval":
      return "The command changed since you approved it. Review it and save again.";
    case "untrusted":
      return "This project is not trusted yet, so its environment command has not run.";
    case "off":
      return "Configured, but switched off.";
    default:
      return "No environment command for this project.";
  }
}

export function EnvironmentTab({ cwd }: { cwd: string | undefined }) {
  const { client } = useLaserStable();
  const [status, setStatus] = useState<ProjectEnvStatus>();
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "refresh">();
  const [note, setNote] = useState<string>();

  const load = useCallback(async () => {
    if (!cwd) return;
    const answer = await client.request("pi/project/env/status", { cwd }).catch(() => undefined);
    if (!answer) return;
    setStatus(answer.status);
    const config = answer.status.config;
    setCommand(config?.command ?? "");
    setArgsText((config?.args ?? []).join(" "));
    setEnabled(config?.enabled ?? false);
    setRequired(config?.required ?? true);
  }, [client, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!cwd) return;
    setBusy("save");
    setNote(undefined);
    try {
      const answer = await client.request("pi/project/env/set", {
        cwd,
        config: command.trim()
          ? {
              enabled,
              command: command.trim(),
              // Arguments are split on whitespace and passed as an array, never
              // through a shell: nothing here is interpreted as a command.
              args: argsText.split(/\s+/).filter(Boolean),
              required,
            }
          : null,
      });
      setStatus(answer.status);
      setNote(
        command.trim()
          ? "Saved and approved. Projects already open keep their current environment until you refresh."
          : "Removed.",
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : "That could not be saved.");
    } finally {
      setBusy(undefined);
    }
  }, [argsText, client, command, cwd, enabled, required]);

  const run = useCallback(
    async (method: "pi/project/env/test" | "pi/project/env/refresh") => {
      if (!cwd) return;
      setBusy(method.endsWith("test") ? "test" : "refresh");
      setNote(undefined);
      try {
        const answer = await client.request(method, { cwd });
        setStatus(answer.status);
        if (answer.status.state === "ready") {
          setNote(
            method.endsWith("test")
              ? `It answered with ${answer.status.names?.length ?? 0} variables.`
              : "Refreshed. New commands use it; anything already running keeps what it started with.",
          );
        }
      } catch (error) {
        setNote(error instanceof Error ? error.message : "That could not be run.");
      } finally {
        setBusy(undefined);
      }
    },
    [client, cwd],
  );

  if (!cwd) {
    return (
      <Empty
        title="Choose a project"
        body="An environment command belongs to one project directory. Open a project and it will appear here."
      />
    );
  }

  const Icon = status ? ICON[status.state] : CircleSlash;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-6 py-6">
        <div className="flex flex-col gap-1">
          <p className="text-xs leading-5 text-ink-3">
            {PRODUCT_DISPLAY_NAME} can ask a program of your choosing what environment this project&rsquo;s commands
            should run with, and apply the answer to every command, background task, child agent and worktree in it. It
            never learns where the values come from, and never shows them: only the variable names appear here.
          </p>
          <p className="typed text-ink-3" title={cwd}>
            {shortCwd(cwd)}
          </p>
        </div>

        {status && (
          <div className="flex items-start gap-3 rounded-lg border border-line px-3 py-3">
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE[status.state])} />
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", TONE[status.state])}>{headline(status)}</p>
              {status.resolvedAt && (
                <p className="mt-0.5 text-xs text-ink-3">
                  Last run {new Date(status.resolvedAt).toLocaleString()}
                </p>
              )}
              {status.state === "failed" && (
                <p className="mt-1 text-xs leading-5 text-ink-2">
                  {status.config?.required
                    ? "Commands in this project are refused until this succeeds."
                    : "Commands in this project run without it."}{" "}
                  Run the program yourself in a terminal to see why — what it prints is never shown here, because it can
                  contain the secrets it was fetching.
                </p>
              )}
              {status.names && status.names.length > 0 && (
                <p className="mt-1 text-xs leading-5 text-ink-3">
                  Sets: <span className="typed text-ink-2">{status.names.join(" · ")}</span>
                </p>
              )}
              {status.unsetNames && status.unsetNames.length > 0 && (
                <p className="mt-1 text-xs leading-5 text-ink-3">
                  Removes: <span className="typed text-ink-2">{status.unsetNames.join(" · ")}</span>
                </p>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border border-line px-3 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-2">Program</span>
            <Input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="/home/you/.local/bin/your-environment-helper"
              spellCheck={false}
              className="[font-variant-ligatures:none]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-ink-2">Arguments</span>
            <Input
              value={argsText}
              onChange={(event) => setArgsText(event.target.value)}
              placeholder="--profile work"
              spellCheck={false}
              // Without this the font draws `--` as a single dash, and a person
              // copying the placeholder types an em dash that never matches.
              className="[font-variant-ligatures:none]"
            />
            <span className="text-xs text-ink-3">
              Passed as separate arguments, never through a shell.
            </span>
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="text-sm text-ink">Use it for this project</span>
            <SettingsSwitch checked={enabled} onCheckedChange={setEnabled} aria-label="Use this project’s environment command" />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-sm text-ink">Refuse commands if it fails</span>
              <span className="text-xs text-ink-3">
                Safer: a command never runs with an environment you did not intend.
              </span>
            </span>
            <SettingsSwitch checked={required} onCheckedChange={setRequired} aria-label="Refuse commands if the environment command fails" />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void save()} disabled={busy !== undefined}>
              {busy === "save" ? "Saving…" : "Save and approve"}
            </Button>
            <Button variant="outline" onClick={() => void run("pi/project/env/test")} disabled={busy !== undefined || !status?.config}>
              <PlayCircle /> {busy === "test" ? "Testing…" : "Test"}
            </Button>
            <Button variant="outline" onClick={() => void run("pi/project/env/refresh")} disabled={busy !== undefined || !status?.config}>
              <RefreshCw /> {busy === "refresh" ? "Refreshing…" : "Refresh"}
            </Button>
            {status?.approved === false && status.state !== "not-configured" && (
              <Badge variant="attention">needs approval</Badge>
            )}
          </div>

          {note && <p className="text-xs leading-5 text-ink-2">{note}</p>}
        </div>

        <p className="text-xs leading-5 text-ink-3">
          This keeps projects from mixing credentials by accident. It is not a sandbox: an agent working in this
          project can read what this program returns, the same way it can read any file you can.
        </p>
      </div>
    </ScrollArea>
  );
}
