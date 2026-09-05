/**
 * Every failure the CLI prints goes through `CliError`, so every failure has
 * three things: what went wrong, how to fix it, and an exit code a script can
 * branch on. Throwing a bare `Error` anywhere is a bug — it prints without a
 * fix line.
 */

export const ExitCode = {
  Ok: 0,
  /** Something the user asked for did not work. */
  Failure: 1,
  /** The command line itself was wrong (unknown flag, missing argument). */
  Usage: 2,
  /** No piorbit host is running (or it is not reachable). */
  NoHost: 3,
  /** The host answered, but with an error. */
  HostError: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface CliErrorOptions {
  /** One imperative sentence, or a command to run. Printed after the message. */
  fix?: string;
  exitCode?: ExitCodeValue;
  /** Extra lines printed between the message and the fix (context, not advice). */
  details?: string[];
  cause?: unknown;
}

export class CliError extends Error {
  override readonly name = "CliError";
  readonly fix: string | undefined;
  readonly details: string[];
  readonly exitCode: ExitCodeValue;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.fix = options.fix;
    this.details = options.details ?? [];
    this.exitCode = options.exitCode ?? ExitCode.Failure;
  }
}

export function usageError(message: string, fix?: string): CliError {
  return new CliError(message, { exitCode: ExitCode.Usage, ...(fix ? { fix } : {}) });
}

/** Message of an unknown thrown value, without leaking `[object Object]`. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
