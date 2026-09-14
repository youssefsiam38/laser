import { isTerminalRunStatus, type AgentRun, type BackgroundTask } from "@lasercode/protocol";

export interface LiveWorkSummary {
  agents: number;
  commands: number;
  total: number;
  sentence?: string;
}

export function shouldCheckLiveWork(
  host: { state: string; startedByUs?: boolean } | undefined,
  operation: { install?: boolean; relaunch?: boolean },
): boolean {
  return host?.state === "ready" && (operation.install === true || operation.relaunch === true || host.startedByUs === true);
}

/** Count only work that cannot survive the host being stopped. */
export function summarizeLiveWork(runs: readonly AgentRun[], tasks: readonly BackgroundTask[]): LiveWorkSummary {
  const agents = runs.filter(run => !isTerminalRunStatus(run.status)).length;
  const commands = tasks.filter(task => task.status === "running").length;
  const total = agents + commands;
  if (total === 0) return { agents, commands, total };

  const parts = [
    agents > 0 ? `${agents} ${agents === 1 ? "agent is" : "agents are"} still working` : undefined,
    commands > 0 ? `${commands} background ${commands === 1 ? "command is" : "commands are"} still running` : undefined,
  ].filter((part): part is string => part !== undefined);
  return { agents, commands, total, sentence: `${parts.join(" and ")}.` };
}
