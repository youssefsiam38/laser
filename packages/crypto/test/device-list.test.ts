/** M6-T3's "done when": a revoked device cannot come back, including by replay. */
import { describe, expect, it } from "vitest";
import {
  DeviceListError,
  DeviceListStore,
  addDevice,
  canonicalJson,
  deviceIdFor,
  emptyDeviceList,
  generateRootSeed,
  isAuthorized,
  nobleBackend,
  revokeDevice,
  rootIdentityFromSeed,
  signDeviceList,
  toBase64Url,
  verifyDeviceList,
} from "../src/index.js";

async function fixture() {
  const root = rootIdentityFromSeed(generateRootSeed());
  const phone = await nobleBackend.generateKeyPair();
  const laptop = await nobleBackend.generateKeyPair();
  const at = new Date(0).toISOString();
  let body = emptyDeviceList(root, new Date(0));
  body = addDevice(body, { name: "iPhone", publicKey: toBase64Url(phone.publicKey), addedAt: at }, new Date(0));
  body = addDevice(body, { name: "Laptop", publicKey: toBase64Url(laptop.publicKey), addedAt: at }, new Date(0));
  return { root, phone, laptop, body };
}

describe("device list", () => {
  it("signs, verifies, and authorizes by public key", async () => {
    const { root, phone, laptop, body } = await fixture();
    const signed = signDeviceList(body, root);
    const verified = verifyDeviceList(signed, root.publicKey);
    expect(verified.version).toBe(3);
    expect(isAuthorized(verified, phone.publicKey)).toBe(true);
    expect(isAuthorized(verified, laptop.publicKey)).toBe(true);
    expect(isAuthorized(verified, (await nobleBackend.generateKeyPair()).publicKey)).toBe(false);
  });

  it("revokes by re-signing, and the revoked device is gone", async () => {
    const { root, phone, body } = await fixture();
    const after = revokeDevice(body, deviceIdFor(phone.publicKey));
    expect(after.version).toBe(body.version + 1);
    expect(isAuthorized(verifyDeviceList(signDeviceList(after, root), root.publicKey), phone.publicKey)).toBe(false);
  });

  it("refuses an older list, so replaying one cannot undo a revocation", async () => {
    const { root, phone, body } = await fixture();
    const oldSigned = signDeviceList(body, root);
    const revoked = signDeviceList(revokeDevice(body, deviceIdFor(phone.publicKey)), root);

    const store = new DeviceListStore(root.publicKey, oldSigned);
    expect(isAuthorized(store.current!, phone.publicKey)).toBe(true);
    store.accept(revoked);
    expect(isAuthorized(store.current!, phone.publicKey)).toBe(false);
    expect(() => store.accept(oldSigned)).toThrow(/would undo a revocation/);
    expect(isAuthorized(store.current!, phone.publicKey)).toBe(false);
  });

  it("catches two different lists claiming the same version", async () => {
    const { root, phone, laptop, body } = await fixture();
    const a = signDeviceList(revokeDevice(body, deviceIdFor(phone.publicKey), new Date(1)), root);
    const b = signDeviceList(revokeDevice(body, deviceIdFor(laptop.publicKey), new Date(1)), root);
    const store = new DeviceListStore(root.publicKey, a);
    expect(() => store.accept(b)).toThrow(/may be compromised/);
  });

  it("rejects a tampered entry, a foreign root, and a forged id", async () => {
    const { root, laptop, body } = await fixture();
    const signed = signDeviceList(body, root);

    const renamed = structuredClone(signed);
    renamed.body.devices[0]!.name = "Attacker's phone";
    expect(() => verifyDeviceList(renamed, root.publicKey)).toThrow(/does not verify/);

    const other = rootIdentityFromSeed(generateRootSeed());
    expect(() => verifyDeviceList(signed, other.publicKey)).toThrow(/different desktop/);

    // An id that is well-formed but belongs to a different device: re-signed, so
    // the signature is valid and only the id/key mismatch can catch it.
    const forgedId = structuredClone(signed);
    forgedId.body.devices[0]!.id = deviceIdFor(laptop.publicKey);
    const resigned = signDeviceList(forgedId.body, root);
    expect(() => verifyDeviceList(resigned, root.publicKey)).toThrow(/id that does not match/);
  });

  it("canonicalizes deterministically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(DeviceListError);
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/only safe integers/);
  });
});
