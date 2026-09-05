/**
 * Secrets in the OS keychain (M5-T3).
 *
 * Two of them, and only two:
 *
 *   root-identity  the Ed25519 seed that signs the device list. Losing it
 *                  invalidates every paired phone, so it must survive an app
 *                  reinstall — which is exactly what a keychain is for and
 *                  what an app-data file is not.
 *   host-token     the bearer this desktop uses to prove to its own host that
 *                  a connection is ours. A local file would be readable by
 *                  anything running as the user, which is the threat.
 *
 * `keytar` is archived, so this uses `@napi-rs/keyring`: N-API, so it is
 * ABI-stable across Electron and the bundled Node and never needs a rebuild.
 * Its `Entry` is a synchronous native call that *throws* on a locked or absent
 * keychain, which is why every call here is wrapped.
 *
 * The fallback matters as much as the happy path. A Linux box with no Secret
 * Service (a headless session, a minimal WM) has no keychain, and refusing to
 * start there would be wrong. So piorbit falls back to a 0600 file — and says
 * so, in the UI, every time. A degraded security story that nobody is told
 * about is the actual failure.
 */
import { PRODUCT_NAME } from "@piorbit/protocol";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import {
  KEYCHAIN_FORMER_SERVICES,
  KEYCHAIN_ROOT_ACCOUNT,
  KEYCHAIN_SERVICE,
  createKeyringRootIdentityStore,
  deviceIdFor,
  loadOrCreateRootIdentity,
  type RootIdentity,
  type RootIdentityStore,
} from "@piorbit/crypto";
import { FileRootIdentityStore } from "@piorbit/crypto/node";
import type { IdentitySummary } from "./api.js";
import type { DesktopLog } from "./log.js";

const HOST_TOKEN_ACCOUNT = "host-token";

export interface SecretsOptions {
  /** `<state-dir>`, where the fallback files live when there is no keychain. */
  stateDir: string;
  log: DesktopLog;
}

export interface DesktopSecrets {
  identity: RootIdentity;
  summary: IdentitySummary;
  /** base64url, 32 bytes. Regenerated only if the stored one is unreadable. */
  hostToken: string;
}

/** Is there a working keychain on this machine? One probe, reused for both secrets. */
function keychainAvailable(log: DesktopLog): string | undefined {
  try {
    // Reading a key that does not exist must return null rather than throw;
    // anything else means there is no usable keychain here.
    new Entry(KEYCHAIN_SERVICE, "probe").getPassword();
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.line(`no OS keychain available: ${detail}`);
    return detail;
  }
}

/**
 * A 0600 file, used only when there is no keychain. Written through a temp file
 * so a crash mid-write cannot leave a half-token that reads as valid.
 */
class FileSecret {
  constructor(private readonly path: string) {}

  read(): string | undefined {
    try {
      const value = readFileSync(this.path, "utf8").trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  write(value: string): void {
    const temporary = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

/**
 * Move a keychain entry from a former product name onto the current one.
 *
 * The keychain service is the product's name, so a rename would make the
 * device look brand new: a fresh root identity, and every paired phone
 * orphaned with nothing on screen to say why (MX-T7, D-36). This copies the
 * secret across before anything asks whether one exists, and removes the old
 * entry only once the new one is written, so an interrupted migration leaves
 * the secret exactly where it was.
 *
 * With no former names it does nothing. It never throws: a locked or absent
 * keychain is the caller's own fallback path, not this function's problem.
 */
function adoptFormerKeychainEntry(account: string, log: DesktopLog): void {
  if (KEYCHAIN_FORMER_SERVICES.length === 0) return;
  try {
    const current = new Entry(KEYCHAIN_SERVICE, account);
    if (current.getPassword()) return;
    for (const service of KEYCHAIN_FORMER_SERVICES) {
      const previous = new Entry(service, account);
      const secret = previous.getPassword();
      if (!secret) continue;
      current.setPassword(secret);
      previous.deletePassword();
      log.line(`moved the "${account}" keychain entry from "${service}" to "${KEYCHAIN_SERVICE}" — this product was renamed`);
      return;
    }
  } catch (error) {
    log.error(`could not check the keychain for an entry under an earlier product name`, error);
  }
}

function loadHostToken(stateDir: string, degraded: boolean, log: DesktopLog): string {
  const fresh = (): string => randomBytes(32).toString("base64url");
  if (!degraded) {
    adoptFormerKeychainEntry(HOST_TOKEN_ACCOUNT, log);
    const entry = new Entry(KEYCHAIN_SERVICE, HOST_TOKEN_ACCOUNT);
    try {
      const stored = entry.getPassword();
      if (stored && stored.length >= 32) return stored;
      const token = fresh();
      entry.setPassword(token);
      return token;
    } catch (error) {
      log.error("could not use the keychain for the host token; falling back to a file", error);
    }
  }
  const file = new FileSecret(join(stateDir, "host-token"));
  const stored = file.read();
  if (stored && stored.length >= 32) return stored;
  const token = fresh();
  try {
    file.write(token);
  } catch (error) {
    // An unwritable state directory is worth a line, not a crash: a token that
    // lives only for this run still works for this run.
    log.error("could not persist the host token", error);
  }
  return token;
}

/**
 * Load both secrets, creating them on first run. Never throws for a missing
 * keychain — only for a keychain that exists and holds something damaged,
 * which is a case a person has to be told about rather than silently
 * overwritten (overwriting it would orphan every paired device).
 */
export async function loadSecrets(options: SecretsOptions): Promise<DesktopSecrets> {
  const { log, stateDir } = options;
  const unavailable = keychainAvailable(log);

  let store: RootIdentityStore;
  if (unavailable) {
    store = new FileRootIdentityStore(join(stateDir, "identity.key"));
  } else {
    adoptFormerKeychainEntry(KEYCHAIN_ROOT_ACCOUNT, log);
    store = createKeyringRootIdentityStore(
      new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ROOT_ACCOUNT),
      process.platform === "darwin" ? "the macOS keychain" : process.platform === "win32" ? "Windows Credential Manager" : "the system keyring",
    );
  }

  const { identity, created } = await loadOrCreateRootIdentity(store);
  if (created) log.line(`generated a new root identity (${deviceIdFor(identity.publicKeyBytes)})`);

  const summary: IdentitySummary = {
    deviceId: deviceIdFor(identity.publicKeyBytes),
    storage: store.description,
    created,
    ...(unavailable
      ? {
          degraded:
            `This system has no keychain ${PRODUCT_NAME} can use (${unavailable}), so its identity key is in a ` +
            `0600 file at ${join(stateDir, "identity.key")}. Anything running as you can read it.`,
        }
      : {}),
  };

  return { identity, summary, hostToken: loadHostToken(stateDir, unavailable !== undefined, log) };
}
