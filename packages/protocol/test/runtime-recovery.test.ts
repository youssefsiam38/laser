import { describe, expect, it } from "vitest";
import {
  LAUNCH_ID_PATTERN,
  METHOD_POLICY,
  clientParamsSchemas,
  launchIdSchema,
  runtimeFailureSchema,
  runtimeRecoveryCopy,
  type RuntimeFailure,
} from "../src/index.js";

const launchId = "0123456789abcdef0123456789abcdef";

const samples: RuntimeFailure[] = [
  {
    owner: { kind: "host", launchId },
    stage: "announce",
    category: "launch_identity_mismatch",
    message: "The app could not verify the service it started.",
  },
  {
    owner: { kind: "worker", launchId, cwd: "/project" },
    stage: "initialize",
    category: "initialization_error",
    message: "This project's runtime did not start.",
  },
  {
    owner: { kind: "module", module: "web-access", sessionPath: "/sessions/one.jsonl" },
    stage: "activate",
    category: "activation_error",
    message: "Could not start this capability. Restart the project or update the app.",
  },
];

describe("runtime launch and failure contracts", () => {
  it("accepts only a lowercase 128-bit launch identity", () => {
    expect(LAUNCH_ID_PATTERN.test(launchId)).toBe(true);
    expect(launchIdSchema.parse(launchId)).toBe(launchId);
    for (const value of ["", "a".repeat(31), "A".repeat(32), "g".repeat(32), "a".repeat(34)]) {
      expect(launchIdSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it("round-trips each structured failure owner through its strict wire schema", () => {
    for (const sample of samples) expect(runtimeFailureSchema.parse(sample)).toEqual(sample);
    expect(runtimeFailureSchema.safeParse({ ...samples[0], stack: "private" }).success).toBe(false);
    expect(runtimeFailureSchema.safeParse({ ...samples[0], category: "look_at_stderr" }).success).toBe(false);
  });

  it("uses couldn't-start copy only for an exhausted launch failure", () => {
    const launchFailure = samples[1]!;
    expect(runtimeRecoveryCopy({
      status: "crashed",
      mode: "normal",
      failure: launchFailure,
      repair: { state: "available", automaticAttempts: 0 },
    })).toMatchObject({ kind: "launch-failed", title: "The project runtime didn't start" });
    expect(runtimeRecoveryCopy({
      status: "crashed",
      mode: "normal",
      failure: launchFailure,
      repair: { state: "exhausted", automaticAttempts: 2 },
    })).toMatchObject({ kind: "exhausted", title: "This project's agent couldn't start" });
    expect(runtimeRecoveryCopy({
      status: "crashed",
      mode: "normal",
      failure: { ...launchFailure, stage: "runtime", category: "process_exit" },
      repair: { state: "exhausted", automaticAttempts: 2 },
    })).toMatchObject({ kind: "exhausted", title: "This project's agent couldn't recover" });
  });

  it("keeps safe mode explicit on the existing native work-control method", () => {
    const params = { cwd: "/project", mode: "safe" as const };
    expect(clientParamsSchemas["pi/worker/restart"].parse(params)).toEqual(params);
    expect(clientParamsSchemas["pi/worker/restart"].safeParse({ ...params, mode: "legacy" }).success).toBe(false);
    expect(METHOD_POLICY["pi/worker/restart"]).toEqual(expect.objectContaining({ scope: "work_control", reach: "any" }));
  });
});
