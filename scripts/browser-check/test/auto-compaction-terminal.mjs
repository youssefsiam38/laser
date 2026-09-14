import assert from "node:assert/strict";

export default async function autoCompactionTerminal(check) {
  const { page, fixture } = check;
  await check.rpc("pi/settings/set", {
    cwd: fixture.project,
    scope: "global",
    changes: [
      { path: "compaction.enabled", op: "set", value: true },
      { path: "compaction.reserveTokens", op: "set", value: 7_000 },
      { path: "compaction.keepRecentTokens", op: "set", value: 500 },
    ],
  });

  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Trigger automatic compaction and then answer normally.");
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click();

  const compacting = page.getByText("compacting", { exact: true });
  await compacting.waitFor({ state: "visible", timeout: 20_000 });
  await compacting.waitFor({ state: "hidden", timeout: 20_000 });
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await compacting.count(), 0, "automatic compaction stays terminal after the answer settles");
}
