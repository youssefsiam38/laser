/**
 * Startup waits once, not twice (M16-T30).
 *
 * The keychain and the login shell are both waiting, and the host needs both.
 * These pin that they wait together, that the keychain is still asked first
 * (its unlock prompt is the first thing a person sees), and that either one
 * failing leaves the app starting rather than stopped.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveStartupInputs } from "../src/startup.js";
import type { DesktopLog } from "../src/log.js";
import type { DesktopSecrets } from "../src/keychain.js";

function testLog(): DesktopLog & { lines: string[] } {
  const lines: string[] = [];
  const log = {
    lines,
    line: (message: string) => lines.push(message),
    error: (message: string, cause?: unknown) => lines.push(`${message}: ${String(cause)}`),
    milestone: (name: string) => lines.push(`startup: ${name}`),
  };
  return log as unknown as DesktopLog & { lines: string[] };
}

const secrets = (): DesktopSecrets =>
  ({
    identity: {} as DesktopSecrets["identity"],
    summary: { deviceId: "device-1", storage: "the system keyring", created: false },
    hostToken: "token",
  }) as DesktopSecrets;

describe("the two startup inputs", () => {
  it("runs the keychain and the shell at the same time, keychain first", async () => {
    const order: string[] = [];
    let releaseSecrets: () => void = () => {};
    const secretsStarted = new Promise<void>((resolve) => {
      releaseSecrets = resolve;
    });
    let shellStarted = false;

    const result = resolveStartupInputs({
      secrets: async () => {
        order.push("secrets");
        await secretsStarted;
        return secrets();
      },
      shellEnvironment: async () => {
        order.push("shell");
        shellStarted = true;
        return { PATH: "/usr/bin" };
      },
      log: testLog(),
    });

    // The shell resolver has already run while the keychain is still pending:
    // that is the whole point of the change.
    await Promise.resolve();
    expect(shellStarted).toBe(true);
    expect(order).toEqual(["secrets", "shell"]);
    releaseSecrets();

    expect(await result).toEqual({
      identity: { deviceId: "device-1", storage: "the system keyring", created: false },
      shellEnvironment: { PATH: "/usr/bin" },
    });
  });

  it("keeps a keychain failure non-fatal and still applies the shell environment", async () => {
    const log = testLog();
    const result = await resolveStartupInputs({
      secrets: () => Promise.reject(new Error("no keyring here")),
      shellEnvironment: () => Promise.resolve({ PATH: "/opt/bin" }),
      log,
    });
    expect(result.identity).toBeUndefined();
    expect(result.shellEnvironment).toEqual({ PATH: "/opt/bin" });
    expect(log.lines.join("\n")).toContain("no keyring here");
  });

  it("keeps the identity when the shell cannot be asked", async () => {
    const log = testLog();
    const result = await resolveStartupInputs({
      secrets: () => Promise.resolve(secrets()),
      shellEnvironment: () => Promise.reject(new Error("SECRET_TOKEN=hunter2")),
      log,
    });
    expect(result.identity?.deviceId).toBe("device-1");
    expect(result.shellEnvironment).toEqual({});
    // The cause can quote the environment it was reading; it must not be logged.
    expect(log.lines.join("\n")).not.toContain("hunter2");
    expect(log.lines.join("\n")).toContain("Shell environment unavailable");
  });
});
