/**
 * M22-T6: what points at a profile, and the small edits the tab makes to one.
 *
 * Pure functions, so these are the rules themselves: a profile nothing points
 * at deletes freely, one something points at needs a replacement, and a
 * duplicate never lands on a name `validateModelProfiles` would refuse.
 */
import { expect, it } from "vitest";
import {
  EMPTY_PROFILE_ASSIGNMENTS,
  validateModelProfiles,
  type AgentDefinition,
  type ModelProfile,
  type ProfileAssignments,
} from "@lasercode/protocol";

import {
  duplicateName,
  moveModel,
  profileUsage,
  replacementCandidates,
  usageSentence,
} from "../../src/components/settings/models/profile-usage.js";

const profile = (id: string, name: string, models: Array<[string, string]> = [["anthropic", "sonnet"]]): ModelProfile => ({
  id,
  name,
  models: models.map(([provider, modelId]) => ({ provider, id: modelId })),
  origin: "person",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const agent = (name: string, profileId: string | null): AgentDefinition => ({
  name,
  kind: "custom",
  scope: "global",
  description: "",
  instructions: "",
  engineInstructions: false,
  excludeCoreInstructions: false,
  profileId,
  thinkingLevel: null,
  supportsSubagents: false,
  allowedAgents: [],
  scopedSkills: false,
  skills: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const assignments = (patch: Partial<ProfileAssignments>): ProfileAssignments => ({ ...EMPTY_PROFILE_ASSIGNMENTS, ...patch });

it("names every surface and agent that points at a profile", () => {
  const usage = profileUsage(
    "mp_a",
    assignments({ defaultProfileId: "mp_a", oracleProfileId: "mp_a", namingProfileId: "mp_b" }),
    [agent("reviewer", "mp_a"), agent("scout", "mp_b"), agent("writer", "mp_a")],
  );
  expect(usage.labels).toEqual(["New conversations", "Consultation", "2 agents"]);
  expect(usage.referenced).toBe(true);
  expect(usageSentence(usage)).toBe("Used by New conversations, Consultation and 2 agents.");
});

it("says plainly when nothing points at a profile, and that one deletes without a replacement", () => {
  const usage = profileUsage("mp_z", assignments({ defaultProfileId: "mp_a" }), [agent("reviewer", "mp_a")]);
  expect(usage.referenced).toBe(false);
  expect(usageSentence(usage)).toBe("Nothing uses this profile yet.");
});

it("counts one agent as one agent", () => {
  const usage = profileUsage("mp_a", EMPTY_PROFILE_ASSIGNMENTS, [agent("reviewer", "mp_a")]);
  expect(usageSentence(usage)).toBe("Used by 1 agent.");
});

it("duplicates onto a name the validator accepts, however many copies exist", () => {
  const profiles = [profile("mp_aaaaaaaaaaaa", "Balanced")];
  const first = duplicateName(profiles, "Balanced");
  expect(first).toBe("Balanced copy");

  const withCopy = [...profiles, profile("mp_bbbbbbbbbbbb", first)];
  const second = duplicateName(withCopy, "Balanced");
  expect(second).toBe("Balanced copy 2");

  // The names the tab would write are names the worker would accept.
  const next = [...withCopy, { ...profile("mp_cccccccccccc", second) }];
  expect(validateModelProfiles(next)).toEqual([]);
});

it("keeps a duplicate's name inside the length the validator allows", () => {
  const long = "x".repeat(40);
  const name = duplicateName([profile("mp_aaaaaaaaaaaa", long)], long);
  expect(name.length).toBeLessThanOrEqual(40);
});

it("moves a model inside the list and refuses to move one off either end", () => {
  const models = [
    { provider: "a", id: "1" },
    { provider: "b", id: "2" },
    { provider: "c", id: "3" },
  ];
  expect(moveModel(models, 2, 1).map((m) => m.id)).toEqual(["1", "3", "2"]);
  expect(moveModel(models, 0, -1).map((m) => m.id)).toEqual(["1", "2", "3"]);
  expect(moveModel(models, 2, 3).map((m) => m.id)).toEqual(["1", "2", "3"]);
});

it("never offers the profile being deleted as its own replacement", () => {
  const profiles = [profile("mp_a", "Smart"), profile("mp_b", "Balanced")];
  expect(replacementCandidates(profiles, "mp_a").map((p) => p.id)).toEqual(["mp_b"]);
});
