import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookPath = fileURLToPath(
  new URL("../build/linux/after-install.sh", import.meta.url),
);

describe("native Linux sandbox install hook", () => {
  it("enables the setuid helper when Ubuntu restricts user namespaces through AppArmor", async () => {
    const source = await readFile(hookPath, "utf8");

    expect(source).toContain(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    );
    expect(source).toMatch(
      /apparmor_restrict_unprivileged_userns[\s\S]*= "1"[\s\S]*return 0/,
    );
    expect(source).toMatch(/chown root:root "\$APP_DIR\/chrome-sandbox"/);
    expect(source).toMatch(/chmod 4755 "\$APP_DIR\/chrome-sandbox"/);
  });
});
