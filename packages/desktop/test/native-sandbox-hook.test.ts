import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookPath = fileURLToPath(
  new URL("../build/linux/after-install.sh", import.meta.url),
);
const productPath = fileURLToPath(new URL("../../../product.json", import.meta.url));

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

  it("registers the case-sensitive GitHub Pages repository path", async () => {
    const [source, product] = await Promise.all([
      readFile(hookPath, "utf8"),
      readFile(productPath, "utf8").then((text) => JSON.parse(text) as { repository: string }),
    ]);
    const [owner, repository] = product.repository.split("/");

    expect(source).toContain(`REPO_OWNER='${owner}'`);
    expect(source).toContain(`REPO_NAME='${repository}'`);
    expect(source).not.toContain("REPO_NAME='${sanitizedProductName}'");
  });

  it("gracefully refreshes only this native install's daemon on upgrade", async () => {
    const source = await readFile(hookPath, "utf8");

    expect(source).toMatch(/\[ -n "\$\{2:-\}" \] \|\| \[ "\$\{1:-\}" = "2" \]/);
    expect(source).toContain('NODE="$APP_DIR/resources/runtime/node"');
    expect(source).toContain('CLI="$APP_DIR/resources/app.asar.unpacked/node_modules/@lasercode/cli/dist/main.js"');
    expect(source).toContain('"$NODE $CLI __daemon "*');
    expect(source).toContain('kill -HUP "$pid"');
  });
});
