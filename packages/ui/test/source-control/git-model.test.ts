import { expect, it } from "vitest";
import type { GitActionConfirmation, GitHostStatus } from "@lasercode/protocol";
import {
  confirmLabel,
  formatCopyableArgv,
  hostFor,
  hostStatusSentence,
  isPreviewCall,
  mergeMethodsFor,
  offersAutomaticRetry,
  offersMutation,
  offersPreviewAgain,
  parsePullRequestNumber,
  repoLeafName,
  targetRepo,
  withConfirm,
} from "../../src/source-control/git-model.js";

const usable: GitHostStatus = {
  repo: "/p/app",
  host: "github",
  usable: true,
  remote: "origin",
  branch: "main",
  defaultBranch: "main",
};

const signedOut: GitHostStatus = {
  repo: "/p/other",
  host: "github",
  usable: false,
  signedIn: false,
  cliPresent: true,
  cli: "gh",
  fix: "Run gh auth login.",
  reason: "signed_out",
};

it("picks the filtered repo, then the active one, then the first", () => {
  const repos = [{ repo: "app" }, { repo: "other" }];
  expect(targetRepo({ repos, repoFilter: "other" })).toBe("other");
  expect(targetRepo({ repos, repoFilter: null, activeRepo: "other" })).toBe("other");
  expect(targetRepo({ repos, repoFilter: null })).toBe("app");
});

it("names a host's fix sentence without sniffing neighbours", () => {
  expect(hostStatusSentence(usable)).toBeUndefined();
  expect(hostStatusSentence(signedOut)).toBe("Run gh auth login.");
  expect(hostFor([usable, signedOut], "/p/other")).toEqual(signedOut);
  expect(repoLeafName("/p/app")).toBe("app");
});

it("quotes copyable argv for display only", () => {
  expect(formatCopyableArgv(["gh", "pr", "create", "--title", "Fix the overlay"])).toBe(
    'gh pr create --title "Fix the overlay"',
  );
});

it("round-trips expect only on confirm: true", () => {
  const preview = { expect: { branch: "main", files: ["a.ts"], head: "abc" } };
  expect(isPreviewCall({})).toBe(true);
  expect(isPreviewCall({ confirm: true })).toBe(false);
  expect(withConfirm(preview, { paths: ["a.ts"], message: "Fix it" })).toEqual({
    paths: ["a.ts"],
    message: "Fix it",
    confirm: true,
    expect: preview.expect,
  });
});

it("never retries an uncertain or needs_copy outcome", () => {
  expect(offersAutomaticRetry("uncertain")).toBe(false);
  expect(offersAutomaticRetry("needs_copy")).toBe(false);
  expect(offersAutomaticRetry("refused")).toBe(false);
  expect(offersMutation("preview")).toBe(true);
  expect(offersPreviewAgain("refused")).toBe(true);
  expect(offersPreviewAgain("uncertain")).toBe(false);
});

it("hides rebase on Bitbucket and parses a pull-request number", () => {
  expect(mergeMethodsFor({ ...usable, host: "bitbucket" })).toEqual(["merge", "squash"]);
  expect(mergeMethodsFor(usable)).toContain("rebase");
  expect(parsePullRequestNumber("12")).toBe(12);
  expect(parsePullRequestNumber("0")).toBeUndefined();
  expect(parsePullRequestNumber("12a")).toBeUndefined();
});

it("names the confirming verb after the branch and remote", () => {
  const confirmation: GitActionConfirmation = {
    repo: "app",
    branch: "main",
    remote: "origin",
    files: ["a.ts"],
    summary: "Commit 1 file on main.",
  };
  expect(confirmLabel("commit", confirmation)).toBe("Commit to main");
  expect(confirmLabel("push", confirmation)).toBe("Push main to origin");
});
