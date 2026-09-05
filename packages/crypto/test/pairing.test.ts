/**
 * M6-T2's "done when": a photographed QR is useless after the pairing it
 * belongs to has been used.
 */
import { PRODUCT_NAME } from "@piorbit/protocol/identity";
import { describe, expect, it } from "vitest";
import {
  PairingError,
  PairingInitiator,
  PairingResponder,
  addDevice,
  channelIdFor,
  deviceIdFor,
  emptyDeviceList,
  generateRootSeed,
  nobleBackend,
  parsePairingLink,
  rootIdentityFromSeed,
  signDeviceList,
  toBase64Url,
  toHex,
  utf8,
  fromUtf8,
  verifyDeviceList,
  type PairingGrant,
} from "../src/index.js";

const RELAY = "wss://relay.example.test/ws";
const APP = "https://app.example.test/link";

async function fullPairing() {
  const backend = nobleBackend;
  const root = rootIdentityFromSeed(generateRootSeed());
  const desktopStatic = await backend.generateKeyPair();
  const phoneStatic = await backend.generateKeyPair();

  const responder = await PairingResponder.create({ relayUrl: RELAY, backend });
  const link = responder.link(APP);

  const initiator = await PairingInitiator.create({ link, staticKeyPair: phoneStatic, backend });
  const { message1, sas: phoneSas } = await initiator.start({ name: "Youssef's iPhone", platform: "ios" });

  const { request, devicePublicKey, sas: desktopSas } = await responder.readRequest(message1);
  expect(request.name).toBe("Youssef's iPhone");
  expect(toHex(devicePublicKey)).toBe(toHex(phoneStatic.publicKey));
  // The comparison a person makes happens here, before the desktop has sent
  // its keys or its device list — it is a gate, not an audit.
  expect(desktopSas.emoji).toEqual(phoneSas.emoji);

  const list = signDeviceList(
    addDevice(emptyDeviceList(root), {
      name: request.name,
      publicKey: toBase64Url(devicePublicKey),
      platform: "ios",
      addedAt: new Date(0).toISOString(),
    }),
    root,
  );
  const grant: PairingGrant = {
    relayUrl: RELAY,
    staticPublicKey: toBase64Url(desktopStatic.publicKey),
    rootPublicKey: root.publicKey,
    deviceList: list,
    deviceId: deviceIdFor(devicePublicKey),
    hostName: "youssef-desktop",
  };
  const message2 = await responder.grant(grant, { sasConfirmed: true });
  const completed = await initiator.complete(message2);
  return { backend, root, desktopStatic, phoneStatic, responder, initiator, link, completed, grant, list };
}

describe("pairing", () => {
  it("hands the phone real key material and a matching SAS", async () => {
    const { responder, completed, root, desktopStatic } = await fullPairing();
    expect(completed.grant.rootPublicKey).toBe(root.publicKey);
    expect(completed.grant.staticPublicKey).toBe(toBase64Url(desktopStatic.publicKey));
    expect(completed.sas.emoji).toEqual(responder.sas.emoji);
    expect(completed.sas.emoji).toHaveLength(6);
    verifyDeviceList(completed.grant.deviceList, completed.grant.rootPublicKey);
  });

  it("carries only an ephemeral key in the link fragment", async () => {
    const { link, desktopStatic, root } = await fullPairing();
    expect(link.startsWith(`${APP}#v1.`)).toBe(true);
    const parsed = parsePairingLink(link);
    expect(parsed.relayUrl).toBe(RELAY);
    // Nothing durable is reachable from the QR.
    expect(toHex(parsed.ephemeralPublicKey)).not.toBe(toHex(desktopStatic.publicKey));
    expect(link).not.toContain(root.publicKey);
    expect(link).not.toContain(toBase64Url(desktopStatic.publicKey));
  });

  it("makes a photographed QR worthless once the pairing is used", async () => {
    const { link, responder, backend } = await fullPairing();

    // An attacker photographs the QR and tries the very same link afterwards.
    const attackerStatic = await backend.generateKeyPair();
    const attacker = await PairingInitiator.create({ link, staticKeyPair: attackerStatic, backend });
    const { message1: attackerMessage } = await attacker.start({ name: "attacker" });
    await expect(responder.readRequest(attackerMessage)).rejects.toThrow(PairingError);
    await expect(responder.grant({} as PairingGrant, { sasConfirmed: true })).rejects.toThrow(/already been used/);
  });

  it("refuses to disclose anything until the emoji have been confirmed", async () => {
    const backend = nobleBackend;
    const root = rootIdentityFromSeed(generateRootSeed());
    const desktopStatic = await backend.generateKeyPair();
    const phoneStatic = await backend.generateKeyPair();
    const responder = await PairingResponder.create({ relayUrl: RELAY, backend });
    const initiator = await PairingInitiator.create({
      link: responder.link(APP),
      staticKeyPair: phoneStatic,
      backend,
    });
    const { message1 } = await initiator.start({ name: "phone" });
    const { devicePublicKey } = await responder.readRequest(message1);
    const list = signDeviceList(
      addDevice(emptyDeviceList(root), {
        name: "phone",
        publicKey: toBase64Url(devicePublicKey),
        addedAt: new Date(0).toISOString(),
      }),
      root,
    );
    const grant: PairingGrant = {
      relayUrl: RELAY,
      staticPublicKey: toBase64Url(desktopStatic.publicKey),
      rootPublicKey: root.publicKey,
      deviceList: list,
      deviceId: deviceIdFor(devicePublicKey),
      hostName: "desktop",
    };
    await expect(responder.grant(grant, { sasConfirmed: false })).rejects.toThrow(/emoji were not confirmed/);
    await expect(responder.grant(grant, { sasConfirmed: true })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("verifies the grant itself rather than trusting the caller to", async () => {
    // A caller that forgot to verify would adopt an unsigned list. complete()
    // does it, so forgetting is not possible.
    const backend = nobleBackend;
    const honest = rootIdentityFromSeed(generateRootSeed());
    const impostor = rootIdentityFromSeed(generateRootSeed());
    const desktopStatic = await backend.generateKeyPair();
    const phoneStatic = await backend.generateKeyPair();
    const responder = await PairingResponder.create({ relayUrl: RELAY, backend });
    const initiator = await PairingInitiator.create({
      link: responder.link(APP),
      staticKeyPair: phoneStatic,
      backend,
    });
    const { message1 } = await initiator.start({ name: "phone" });
    const { devicePublicKey } = await responder.readRequest(message1);
    // The list is signed by one root; the grant claims another.
    const list = signDeviceList(
      addDevice(emptyDeviceList(impostor), {
        name: "phone",
        publicKey: toBase64Url(devicePublicKey),
        addedAt: new Date(0).toISOString(),
      }),
      impostor,
    );
    const message2 = await responder.grant(
      {
        relayUrl: RELAY,
        staticPublicKey: toBase64Url(desktopStatic.publicKey),
        rootPublicKey: honest.publicKey,
        deviceList: list,
        deviceId: deviceIdFor(devicePublicKey),
        hostName: "desktop",
      },
      { sasConfirmed: true },
    );
    await expect(initiator.complete(message2)).rejects.toThrow(/device list did not verify/);
  });

  it("bricks a pairing code that a stranger disturbs, and says so", async () => {
    const backend = nobleBackend;
    const responder = await PairingResponder.create({ relayUrl: RELAY, backend });
    await expect(responder.readRequest(new Uint8Array(96))).rejects.toThrow(/did not authenticate/);
    // The handshake state is poisoned, so a legitimate attempt after it cannot
    // succeed. The message says that instead of blaming the phone.
    const phone = await PairingInitiator.create({
      link: responder.link(APP),
      staticKeyPair: await backend.generateKeyPair(),
      backend,
    });
    const { message1 } = await phone.start({ name: "the real phone" });
    await expect(responder.readRequest(message1)).rejects.toThrow(/disturbed by an unexpected connection/);
  });

  it("refuses an expired code", async () => {
    let clock = 0;
    const responder = await PairingResponder.create({
      relayUrl: RELAY,
      backend: nobleBackend,
      ttlMs: 1000,
      now: () => clock,
    });
    const phone = await PairingInitiator.create({
      link: responder.link(APP),
      staticKeyPair: await nobleBackend.generateKeyPair(),
      backend: nobleBackend,
    });
    const { message1 } = await phone.start({ name: "slow phone" });
    clock = 1001;
    await expect(responder.readRequest(message1)).rejects.toThrow(/expired/);
  });

  it("derives one channel id both peers agree on, and a different one for pairing", async () => {
    const { desktopStatic, phoneStatic, responder, backend } = await fullPairing();
    const fromDesktop = await channelIdFor(desktopStatic, phoneStatic.publicKey, { backend });
    const fromPhone = await channelIdFor(phoneStatic, desktopStatic.publicKey, { backend });
    expect(toHex(fromDesktop)).toBe(toHex(fromPhone));
    expect(fromDesktop).toHaveLength(32);
    expect(toHex(fromDesktop)).not.toBe(toHex(responder.channelId));
  });

  it("carries the transport through the pairing channel once granted", async () => {
    const { responder, initiator } = await fullPairing();
    const desktop = await responder.session();
    const phone = await initiator.session();
    const frame = await phone.encrypt(utf8("first message from the phone"));
    expect(fromUtf8((await desktop.decrypt(frame))!)).toBe("first message from the phone");
  });

  it("explains a bad link instead of throwing something opaque", () => {
    expect(() => parsePairingLink("https://example.com/nope")).toThrow(new RegExp(`not a ${PRODUCT_NAME} pairing link`));
    expect(() => parsePairingLink("x#v9.aaaa.bbbb")).toThrow(/version v9 is not supported/);
    expect(() => parsePairingLink(`x#v1.${toBase64Url(utf8("wss://r/ws"))}.AAAA`)).toThrow(/expected 32/);
    expect(() => parsePairingLink(`x#v1.${toBase64Url(utf8("http://r"))}.${toBase64Url(new Uint8Array(32))}`)).toThrow(
      /not a WebSocket URL/,
    );
  });
});
