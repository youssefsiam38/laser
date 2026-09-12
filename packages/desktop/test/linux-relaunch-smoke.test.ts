/**
 * Opt-in because this regression needs a Linux parent with NoNewPrivs=0 and
 * a display. Run from an ordinary terminal (or an isolated user service), not
 * from an already-restricted agent. Opens only throwaway Electron profiles;
 * never the installed product's host, state, credentials or sessions.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.runIf(process.platform === "linux" && process.env["RUN_RELAUNCH_SMOKE"] === "1")(
  "real Electron restart keeps NoNewPrivs=0 into its command child (old helper demonstrably does not)",
  async () => {
    expect(readFileSync("/proc/self/status", "utf8")).toMatch(/^NoNewPrivs:\s*0$/m);
    const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-relaunch-smoke-`));
    const binary = fileURLToPath(new URL("../node_modules/electron/dist/electron", import.meta.url));
    const module = new URL("../dist/linux-relaunch.js", import.meta.url).href;
    try {
      for (const fixed of [false, true]) {
        const output = join(root, `${fixed}.jsonl`);
        const script = join(root, `${fixed}.cjs`);
        writeFileSync(script, `
          const {app, BrowserWindow} = require('electron');
          const fs = require('node:fs'), cp = require('node:child_process');
          app.disableHardwareAcceleration();
          app.setPath('userData', ${JSON.stringify(join(root, `profile-${fixed}`))});
          const lock = app.requestSingleInstanceLock();
          if (!lock) { console.error('replacement raced the old lock'); app.exit(2); }
          app.whenReady().then(async () => {
            const second = fs.existsSync(${JSON.stringify(output)});
            const w = new BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false}});
            await w.loadURL('data:text/html,<p>isolated restart probe</p>');
            const isolated = await w.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"');
            const nnp = fs.readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\\s*(\\d+)/m)[1];
            const shell = cp.execFileSync('/bin/sh', ['-c', 'grep NoNewPrivs /proc/self/status'], {encoding:'utf8'}).trim();
            fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({second,nnp,shell,isolated,lock,
              cwd:process.cwd(),args:process.argv.slice(1),marker:process.env.RESTART_SMOKE_MARKER})+'\\n');
            if(!second) {
              if(${fixed}) {
                const {prepareLinuxRelaunch,linuxRelaunchCommand} = await import(${JSON.stringify(module)});
                const restart = await prepareLinuxRelaunch({nodeBinary:${JSON.stringify(process.execPath)},
                  command:linuxRelaunchCommand({packaged:false,execPath:process.execPath,argv:process.argv,cwd:process.cwd(),env:process.env}),
                  logFile:${JSON.stringify(join(root, "helper.log"))}});
                await restart.commit();
              } else app.relaunch();
            }
            app.quit();
          }).catch(e=>{console.error(e);app.exit(3);});
        `);
        // Only this isolated downloaded Electron uses --no-sandbox, just like
        // bridge-smoke.test: CI cannot install its setuid helper. The production
        // launcher and webPreferences remain unchanged; this probes relaunch's
        // separate PR_SET_NO_NEW_PRIVS side effect, not Chromium's OS sandbox.
        const args = [script, "--no-sandbox", "--ozone-platform=x11", "--a-preserved-flag=with space"];
        const child = spawn(binary, args, {
          cwd: root, env: { ...process.env, RESTART_SMOKE_MARKER: "kept" }, stdio: ["ignore", "ignore", "pipe"],
        });
        let error = "";
        child.stderr.on("data", (chunk) => { error += String(chunk); });
        try {
          const deadline = Date.now() + 20_000;
          let rows: Array<Record<string, unknown>> = [];
          while (rows.length < 2) {
            if (Date.now() > deadline) throw new Error(`Restart probe did not finish: ${error}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
            try { rows = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
            catch { /* not written yet */ }
          }
          expect(rows.map((row) => row["nnp"])).toEqual(fixed ? ["0", "0"] : ["0", "1"]);
          expect(rows.map((row) => row["shell"])).toEqual(fixed ? ["NoNewPrivs:\t0", "NoNewPrivs:\t0"] : ["NoNewPrivs:\t0", "NoNewPrivs:\t1"]);
          for (const row of rows) expect(row).toMatchObject({ isolated: true, lock: true, cwd: root, args, marker: "kept" });
        } finally { child.kill(); }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 50_000,
);
