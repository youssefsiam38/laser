/**
 * `laser relay` — link a phone to this desktop (M9-T7, M6).
 *
 * Four verbs and one file. `login` records which relay to meet at, `pair`
 * runs the Noise_IK handshake with a phone that scanned the QR, `devices`
 * lists what is linked, and `revoke` re-signs the list without one. There is
 * no server-side account anywhere in this: the relay is a byte forwarder that
 * cannot read the traffic (AGENTS.md invariant 7), so "login" is a URL, not a
 * credential.
 *
 * The emoji comparison is a gate, not a receipt. `PairingResponder.grant()`
 * refuses without `sasConfirmed`, and the grant is what discloses this
 * desktop's static key, its root key and every linked device's name — so this
 * command asks a person, on a terminal, and will not run without one. There
 * is deliberately no `--yes` for it: a flag that says "I compared the emoji"
 * without a person comparing the emoji is the whole attack.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";

import {
  PairingResponder,
  addDevice,
  deviceIdFor,
  fromBase64Url,
  revokeDevice,
  signDeviceList,
  toBase64Url,
  type DeviceEntry,
  type DeviceListBody,
  type PairingGrant,
} from "@lasercode/crypto";
import WebSocket from "ws";

import { bool, num, str } from "../args.js";
import type { Command, CommandContext } from "../command.js";
import { CliError, ExitCode } from "../errors.js";
import { clip } from "../format.js";
import { sanitize, table, type Terminal } from "../output.js";
import { qrLines } from "../qr.js";
import {
  deviceListOf,
  loadIdentity,
  readIdentity,
  loadStaticKey,
  normalizePublicOrigin,
  normalizeRelayUrl,
  readRelayConfig,
  relayConfigPath,
  writeRelayConfig,
  type RelayConfig,
} from "../relay-config.js";
import { readHostFile } from "../hostfile.js";
import type { LaserPaths } from "../config.js";

/** Mirrors `CHANNEL_PROTOCOL_PREFIX` in `@lasercode/relay`, as the host does. */
const CHANNEL_PROTOCOL_PREFIX = "${WIRE_NAMESPACE}.channel.";

const VERBS = ["status", "login", "pair", "devices", "revoke"] as const;
type Verb = (typeof VERBS)[number];

function verbOf(positionals: readonly string[]): { verb: Verb; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first === undefined) return { verb: "status", rest: [] };
  if ((VERBS as readonly string[]).includes(first)) return { verb: first as Verb, rest };
  throw new CliError(`unknown relay verb ${JSON.stringify(first)}`, {
    exitCode: ExitCode.Usage,
    fix: `Use one of: ${VERBS.join(", ")}.`,
  });
}

export const relayCommand: Command = {
  name: "relay",
  group: "Relay",
  summary: "link a phone to this desktop through a relay",
  usage: `${PRODUCT_NAME} relay [status|login <url>|pair|devices|revoke <device>] [options]`,
  description: `
A phone reaches this desktop through a relay that forwards bytes it cannot
read. Pairing is a QR scan plus an emoji comparison; after that the two sides
have a channel only they can compute, and the relay sees an opaque id.

  ${PRODUCT_NAME} relay login wss://relay.example/ws --origin https://app.example
  ${PRODUCT_NAME} relay pair --name "Youssef's iPhone"
  ${PRODUCT_NAME} relay devices
  ${PRODUCT_NAME} relay revoke iphone

Nothing here contacts the relay except \`pair\`. \`login\` writes a URL, and
the host opens its outbound connections when it next starts — so after pairing
or revoking, restart it with \`${PRODUCT_NAME} restart\`.

The root identity that signs the device list is created on first use and never
rotated: every paired phone verifies the list against it, so replacing it
unlinks every device. It lives in the state directory, mode 0600.
`,
  positionals: [
    { name: "verb", description: `One of: ${VERBS.join(", ")}`, optional: true },
    { name: "argument", description: "The relay URL for `login`, the device for `revoke`", optional: true },
  ],
  flags: {
    origin: {
      type: "string",
      description: "The https origin the phone opens (where the app is served)",
      placeholder: "<url>",
    },
    "host-name": { type: "string", description: "Label for this desktop, shown on the phone", placeholder: "<name>" },
    name: { type: "string", description: "`pair`: label for the device being linked", placeholder: "<name>" },
    timeout: { type: "number", default: 180, description: "`pair`: seconds before the code expires", placeholder: "<s>" },
    invert: { type: "boolean", description: "`pair`: draw the QR for a light terminal" },
    yes: { type: "boolean", short: "y", description: "`revoke`: skip the confirmation" },
  },
  examples: [
    { note: "point this desktop at a relay", command: `${PRODUCT_NAME} relay login wss://relay.example/ws --origin https://app.example` },
    { note: "link a phone", command: `${PRODUCT_NAME} relay pair --name \"Youssef's iPhone\"` },
    { note: "unlink one", command: `${PRODUCT_NAME} relay revoke iphone` },
  ],

  async run(context) {
    const { verb, rest } = verbOf(context.args.positionals);
    switch (verb) {
      case "status":
        return status(context);
      case "login":
        return login(context, rest[0]);
      case "pair":
        return pair(context);
      case "devices":
        return devices(context);
      case "revoke":
        return revoke(context, rest[0]);
    }
  },
};

// ------------------------------------------------------------------ status --

async function status({ term, paths }: CommandContext): Promise<void> {
  // Reading status writes nothing, including no key: a machine that has never
  // paired anything must look the same after `laser relay` as before it.
  const config = readRelayConfig(paths);
  const identity = await readIdentity(paths);
  const list = identity ? deviceListOf(config, identity) : undefined;
  const running = readHostFile(paths.hostFile) !== undefined;

  if (term.json) {
    term.data({
      configured: config !== undefined,
      relayUrl: config?.relayUrl ?? null,
      publicOrigin: config?.publicOrigin ?? null,
      hostName: config?.hostName ?? null,
      rootPublicKey: identity?.publicKey ?? null,
      deviceListVersion: list?.version ?? null,
      devices: list?.devices.map(publicDevice) ?? [],
      hostRunning: running,
      configPath: relayConfigPath(paths),
    });
    return;
  }

  if (!config) {
    term.note("No relay configured. This desktop is local-only.");
    term.note();
    term.note("  A relay lets a phone reach this machine without opening a port on it.");
    term.note("  It forwards bytes it cannot read; nothing about your sessions passes through it in the clear.");
    term.note();
    term.note(`  ${term.err.bold(`${PRODUCT_NAME} relay login wss://relay.example/ws --origin https://app.example`)}`);
    return;
  }

  term.print(`relay      ${config.relayUrl}`);
  term.print(`app        ${config.publicOrigin ?? term.out.dim("not set — `laser relay login --origin <url>`")}`);
  term.print(`identity   ${term.out.dim(identity ? fingerprint(identity.publicKey) : "not created yet")}`);
  const linked = list?.devices ?? [];
  term.print(`devices    ${linked.length === 0 ? term.out.dim("none linked") : String(linked.length)}`);
  for (const device of linked) {
    term.print(`           ${term.out.dim(shortId(device.id))}  ${clip(sanitize(device.name), 40)}`);
  }
  if (linked.length === 0) {
    term.note();
    term.note(`  ${term.err.bold(`${PRODUCT_NAME} relay pair`)} shows a QR code for a phone to scan.`);
  } else if (!running) {
    term.note(term.err.dim("The host is not running, so no device is connected right now."));
  }
}

// ------------------------------------------------------------------- login --

async function login({ term, paths, args }: CommandContext, url: string | undefined): Promise<void> {
  const existing = readRelayConfig(paths);
  if (url === undefined && !existing) {
    throw new CliError("relay login needs the relay's WebSocket URL", {
      exitCode: ExitCode.Usage,
      fix: `For example: \`${PRODUCT_NAME} relay login wss://relay.example.com/ws\`.`,
    });
  }

  const relayUrl = url === undefined ? (existing as RelayConfig).relayUrl : normalizeRelayUrl(url);
  const originFlag = str(args, "origin");
  const publicOrigin =
    originFlag !== undefined ? normalizePublicOrigin(originFlag) : existing?.publicOrigin ?? defaultOrigin(relayUrl);
  const hostName = str(args, "host-name") ?? existing?.hostName ?? hostname();

  const { identity, created } = await loadIdentity(paths);
  await loadStaticKey(paths);

  const config: RelayConfig = {
    v: 1,
    relayUrl,
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    hostName,
    ...(existing?.deviceList ? { deviceList: existing.deviceList } : {}),
  };
  writeRelayConfig(paths, config);

  if (term.json) {
    term.data({
      relayUrl,
      publicOrigin: publicOrigin ?? null,
      hostName,
      rootPublicKey: identity.publicKey,
      rootIdentityCreated: created,
      configPath: relayConfigPath(paths),
    });
    return;
  }

  term.note(`${term.err.green("saved")} ${relayConfigPath(paths)}`);
  term.print(`relay      ${relayUrl}`);
  term.print(`app        ${publicOrigin ?? term.out.dim("not set")}`);
  term.print(`identity   ${term.out.dim(fingerprint(identity.publicKey))}`);
  if (created) {
    term.note();
    term.note(`  A root identity was created for this desktop. Every phone you link verifies`);
    term.note(`  the device list against it, so keep it: replacing it unlinks everything.`);
  }
  if (!publicOrigin) {
    term.note();
    term.note(`  ${term.err.bold("--origin")} is not set, so ${term.err.bold(`${PRODUCT_NAME} relay pair`)} has no address to put in the QR.`);
    term.note(`  Set it to wherever the app is served: \`${PRODUCT_NAME} relay login --origin https://app.example\`.`);
  }
  term.note();
  term.note(`  Next: ${term.err.bold(`${PRODUCT_NAME} relay pair`)}`);
}

/** A relay at `wss://relay.example/ws` usually serves the app at `https://relay.example`. */
function defaultOrigin(relayUrl: string): string | undefined {
  try {
    const url = new URL(relayUrl);
    if (url.protocol === "ws:") return undefined;
    return `https://${url.host}`;
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------- pair --

async function pair(context: CommandContext): Promise<void> {
  const { term, paths, args } = context;
  const config = readRelayConfig(paths);
  if (!config) {
    throw new CliError("no relay is configured", {
      exitCode: ExitCode.Usage,
      fix: `Run \`${PRODUCT_NAME} relay login wss://relay.example/ws --origin https://app.example\` first.`,
    });
  }
  if (!config.publicOrigin) {
    throw new CliError("the QR needs an address for the phone to open", {
      details: ["The relay URL is where the two sides meet; the origin is where the app itself is served."],
      fix: `Run \`${PRODUCT_NAME} relay login --origin https://app.example\`.`,
    });
  }
  if (term.json) {
    throw new CliError(`\`${PRODUCT_NAME} relay pair\` cannot run with --json`, {
      exitCode: ExitCode.Usage,
      details: ["Pairing needs a person to compare six emoji against the phone's screen; that is the security of it."],
      fix: `Run it without --json, then use \`${PRODUCT_NAME} relay devices --json\` for the result.`,
    });
  }
  if (!process.stdin.isTTY) {
    throw new CliError(`\`${PRODUCT_NAME} relay pair\` needs a terminal`, {
      details: ["It shows a QR code and asks you to confirm the emoji the phone shows."],
      fix: "Run it in an interactive shell.",
    });
  }

  const { identity } = await loadIdentity(paths);
  const { keyPair: staticKey } = await loadStaticKey(paths);
  const list = deviceListOf(config, identity);

  const ttlMs = Math.max(30, num(args, "timeout") ?? 180) * 1000;
  const responder = await PairingResponder.create({ relayUrl: config.relayUrl, ttlMs });
  const link = responder.link(`${config.publicOrigin}/link`);

  term.note(term.err.bold("Scan this with the phone's camera"));
  term.note();
  for (const line of qrLines(link, { ecc: "L", quietZone: 2, invert: bool(args, "invert") })) term.note(`  ${line}`);
  term.note();
  term.note(`  ${term.err.dim(link)}`);
  term.note();
  term.note(term.err.dim(`  The code is good for ${Math.round(ttlMs / 1000)} seconds and one phone. Ctrl-C to stop.`));

  const message1 = await waitForRequest(responder.channelId, config.relayUrl, ttlMs, term);
  const { request, devicePublicKey, sas } = await responder.readRequest(message1.frame);

  term.note();
  term.note(`  ${clip(sanitize(request.name), 48)} wants to link${request.platform ? ` (${clip(sanitize(request.platform), 24)})` : ""}.`);
  term.note();
  term.note(`  ${term.err.bold(sas.emoji.join("  "))}`);
  term.note(`  ${term.err.dim(sas.code)}`);
  term.note();
  term.note(`  The phone is showing six emoji too. They must be the same six, in the same order.`);

  const approved = await ask(term, "  Do they match? [y/N] ");
  if (!approved) {
    message1.close(1000, "not approved");
    throw new CliError("pairing refused", {
      details: ["Nothing was disclosed to the other side."],
      fix: "If the emoji did not match, someone may be between you. Try again on a network you trust.",
    });
  }

  const deviceName = str(args, "name") ?? request.name;
  const nextList = addDeviceOrFail(list, {
    name: deviceName,
    publicKey: toBase64Url(devicePublicKey),
    ...(request.platform !== undefined ? { platform: request.platform } : {}),
    ...(request.client !== undefined ? { client: request.client } : {}),
    addedAt: new Date().toISOString(),
  });
  const signed = signDeviceList(nextList, identity);

  const grant: PairingGrant = {
    relayUrl: config.relayUrl,
    staticPublicKey: toBase64Url(staticKey.publicKey),
    rootPublicKey: identity.publicKey,
    deviceList: signed,
    deviceId: deviceIdFor(devicePublicKey),
    ...(config.hostName !== undefined ? { hostName: config.hostName } : {}),
  };
  const message2 = await responder.grant(grant, { sasConfirmed: true });
  await message1.send(message2);
  message1.close(1000, "paired");

  writeRelayConfig(paths, { ...config, deviceList: signed });

  term.note();
  term.note(`${term.err.green("linked")} ${clip(sanitize(deviceName), 48)} ${term.err.dim(shortId(grant.deviceId))}`);
  term.note();
  term.note(`  Restart the host so it opens a channel for it: ${term.err.bold(`${PRODUCT_NAME} restart`)}`);
}

function addDeviceOrFail(list: DeviceListBody, entry: Omit<DeviceEntry, "id">): DeviceListBody {
  try {
    return addDevice(list, entry);
  } catch (error) {
    throw new CliError("that phone is already linked to this desktop", {
      cause: error,
      details: [`It is in the list as "${clip(sanitize(nameOfKey(list, entry.publicKey) ?? "?"), 40)}".`],
      fix: `Revoke it first (\`${PRODUCT_NAME} relay devices\`, then \`${PRODUCT_NAME} relay revoke <id>\`) and pair again.`,
    });
  }
}

function nameOfKey(list: DeviceListBody, publicKey: string): string | undefined {
  const id = deviceIdFor(fromBase64Url(publicKey));
  return list.devices.find((device) => device.id === id)?.name;
}

interface PairingSocket {
  frame: Uint8Array;
  send(payload: Uint8Array): Promise<void>;
  close(code: number, reason: string): void;
}

/**
 * Park on the pairing channel until the phone's first Noise message arrives.
 *
 * The channel id is a subprotocol rather than a query parameter for the same
 * reason the host does it: a request line is logged by every hop, and this id
 * is a bearer capability for one rendezvous slot.
 */
function waitForRequest(
  channelId: Uint8Array,
  relayUrl: string,
  ttlMs: number,
  term: Terminal,
): Promise<PairingSocket> {
  return new Promise<PairingSocket>((resolve, reject) => {
    const ws = new WebSocket(relayUrl, [`${CHANNEL_PROTOCOL_PREFIX}${toBase64Url(channelId)}`], {
      perMessageDeflate: false,
      maxPayload: 1 << 20,
    });
    let settled = false;
    const expiry = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close(1000, "expired");
      } catch {
        /* already closing */
      }
      reject(
        new CliError("the pairing code expired before a phone scanned it", {
          fix: `Run \`${PRODUCT_NAME} relay pair\` again, or raise --timeout.`,
        }),
      );
    }, ttlMs);
    expiry.unref?.();

    const fail = (error: CliError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      try {
        ws.close(1011, "failed");
      } catch {
        /* already closing */
      }
      reject(error);
    };

    ws.on("open", () => term.note(term.err.dim("  waiting for a phone…")));

    ws.on("unexpected-response", (request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        request.destroy();
        fail(refusedByRelay(relayUrl, response.statusCode ?? 0, Buffer.concat(chunks).toString()));
      });
    });

    ws.on("error", (error: Error) => {
      fail(
        new CliError(`could not reach the relay at ${relayUrl}`, {
          cause: error,
          details: [error.message],
          fix: `Check the URL with \`${PRODUCT_NAME} relay status\`, and that this machine has a route to it.`,
        }),
      );
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      fail(
        new CliError(`the relay closed the connection (${code})`, {
          ...(reason.length > 0 ? { details: [reason.toString()] } : {}),
          fix: `Run \`${PRODUCT_NAME} relay pair\` again.`,
        }),
      );
    });

    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        // Control frames: the relay's hello, peer arrivals, and its keepalive.
        try {
          const message = JSON.parse(toBuffer(data).toString("utf8")) as { t?: string; n?: number; message?: string };
          if (message.t === "ping") ws.send(JSON.stringify({ t: "pong", n: message.n }));
          if (message.t === "error") {
            fail(
              new CliError(`the relay refused this channel: ${message.message ?? "no reason given"}`, {
                fix: `Run \`${PRODUCT_NAME} relay pair\` again to get a fresh code.`,
              }),
            );
          }
        } catch {
          /* a proxy in front of the relay may send something else; ignore it */
        }
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(expiry);
      resolve({
        frame: new Uint8Array(toBuffer(data)),
        send: (payload) =>
          new Promise<void>((done, failed) => {
            ws.send(payload, (error) => (error ? failed(error) : done()));
          }),
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            /* already closing */
          }
        },
      });
    });
  });
}

function refusedByRelay(relayUrl: string, status: number, body: string): CliError {
  let parsed: { message?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    /* not the relay's own JSON */
  }
  const detail = parsed.message ?? body.slice(0, 200);
  if (status === 409) {
    return new CliError("that pairing channel already has two connections", {
      details: [detail].filter(Boolean),
      fix: `Someone else is on it, or an earlier attempt is still open. Run \`${PRODUCT_NAME} relay pair\` again for a fresh code.`,
    });
  }
  if (status === 429) {
    return new CliError("the relay is rate-limiting this address", {
      details: [detail].filter(Boolean),
      fix: "Wait a minute and try again.",
    });
  }
  return new CliError(`the relay at ${relayUrl} refused the connection (HTTP ${status})`, {
    details: [detail].filter(Boolean),
    fix: `Check the URL with \`${PRODUCT_NAME} relay status\`.`,
  });
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

async function ask(term: Terminal, question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(term.err.bold(question))).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// ----------------------------------------------------------------- devices --

async function devices({ term, paths }: CommandContext): Promise<void> {
  const config = readRelayConfig(paths);
  const identity = await readIdentity(paths);
  const list = identity ? deviceListOf(config, identity) : undefined;

  if (term.json) {
    term.data(
      list
        ? { version: list.version, updatedAt: list.updatedAt, devices: list.devices.map(publicDevice) }
        : { version: 0, updatedAt: null, devices: [] },
    );
    return;
  }

  if (!list || list.devices.length === 0) {
    term.note("No devices linked.");
    term.note();
    term.note(`  ${term.err.bold(`${PRODUCT_NAME} relay pair`)} shows a QR code to scan.`);
    return;
  }

  for (const line of table(
    list.devices,
    [
      { header: "id", get: (device) => shortId(device.id) },
      // Every one of these came off a phone. Sanitize before a terminal sees it.
      { header: "name", get: (device) => clip(sanitize(device.name), 32) },
      { header: "platform", get: (device) => clip(sanitize(device.platform ?? "—"), 20) },
      { header: "linked", get: (device) => device.addedAt.slice(0, 10) },
    ],
    term.out,
  )) {
    term.print(line);
  }
  term.note(term.err.dim(`device list version ${list.version}`));
}

/** What is safe to print or hand to a script: no private material exists here anyway. */
function publicDevice(device: DeviceEntry): Record<string, unknown> {
  return {
    id: device.id,
    name: sanitize(device.name),
    ...(device.platform !== undefined ? { platform: sanitize(device.platform) } : {}),
    ...(device.client !== undefined ? { client: sanitize(device.client) } : {}),
    addedAt: device.addedAt,
    publicKey: device.publicKey,
  };
}

// ------------------------------------------------------------------ revoke --

async function revoke({ term, paths, args }: CommandContext, ref: string | undefined): Promise<void> {
  if (ref === undefined) {
    throw new CliError("relay revoke needs a device", {
      exitCode: ExitCode.Usage,
      fix: `Run \`${PRODUCT_NAME} relay devices\` for the ids, then \`${PRODUCT_NAME} relay revoke <id>\`.`,
    });
  }
  const config = readRelayConfig(paths);
  const { identity } = await loadIdentity(paths);
  const list = deviceListOf(config, identity);
  const device = resolveDevice(list, ref);

  if (!bool(args, "yes") && !term.json) {
    throw new CliError(`this would unlink "${clip(sanitize(device.name), 40)}"`, {
      exitCode: ExitCode.Usage,
      details: ["It stops connecting on its next attempt; it cannot be undone without pairing again."],
      fix: `Nothing changed. Re-run with --yes: \`${PRODUCT_NAME} relay revoke ${shortId(device.id)} --yes\`.`,
    });
  }

  const signed = signDeviceList(revokeDevice(list, device.id), identity);
  writeRelayConfig(paths, { ...(config as RelayConfig), deviceList: signed });

  if (term.json) {
    term.data({ revoked: publicDevice(device), version: signed.body.version });
    return;
  }
  term.note(`${term.err.green("revoked")} ${clip(sanitize(device.name), 40)} ${term.err.dim(shortId(device.id))}`);
  term.note();
  term.note(`  It is refused on its next reconnect. To drop it now: ${term.err.bold(`${PRODUCT_NAME} restart`)}`);
}

/** Full id, short id, or an unambiguous piece of the name. */
function resolveDevice(list: DeviceListBody, ref: string): DeviceEntry {
  const needle = ref.toLowerCase();
  const exact = list.devices.filter((device) => device.id === ref || shortId(device.id) === ref);
  if (exact.length === 1) return exact[0] as DeviceEntry;

  const byName = list.devices.filter(
    (device) => device.name.toLowerCase().includes(needle) || device.id.toLowerCase().startsWith(needle),
  );
  if (byName.length === 1) return byName[0] as DeviceEntry;
  if (byName.length > 1) {
    throw new CliError(`${JSON.stringify(ref)} matches ${byName.length} devices`, {
      exitCode: ExitCode.Usage,
      details: byName.map((device) => `${shortId(device.id)}  ${clip(sanitize(device.name), 40)}`),
      fix: "Use the id from the first column.",
    });
  }
  throw new CliError(`no linked device matches ${JSON.stringify(ref)}`, {
    exitCode: ExitCode.Usage,
    details:
      list.devices.length === 0
        ? ["Nothing is linked."]
        : list.devices.map((device) => `${shortId(device.id)}  ${clip(sanitize(device.name), 40)}`),
    fix: `Run \`${PRODUCT_NAME} relay devices\`.`,
  });
}

// ------------------------------------------------------------------ shared --

/** Enough of a device id to type, and enough to be unique in practice. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A root key in groups, so two people can read it to each other. */
function fingerprint(publicKey: string): string {
  return (publicKey.match(/.{1,4}/g) ?? [publicKey]).slice(0, 8).join(" ");
}
