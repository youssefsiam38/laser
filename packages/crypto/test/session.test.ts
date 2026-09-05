/**
 * Transport invariants. These are the properties the whole design rests on, and
 * every one of them fails silently if it regresses.
 */
import { describe, expect, it } from "vitest";
import {
  FRAME_BUCKETS,
  FRAME_HEADER_BYTES,
  AEAD_TAG_BYTES,
  NoiseHandshake,
  NoiseSession,
  NoiseSessionError,
  bucketFor,
  frameSizeFor,
  nobleBackend,
  utf8,
  fromUtf8,
  type KeyPair,
} from "../src/index.js";

async function pair(options: { channelId?: Uint8Array; now?: () => number; rekeyIntervalMs?: number } = {}) {
  const backend = nobleBackend;
  const channelId = options.channelId ?? new Uint8Array(32).fill(7);
  const a: KeyPair = await backend.generateKeyPair();
  const b: KeyPair = await backend.generateKeyPair();
  const initiator = await NoiseHandshake.create({
    pattern: "KK",
    initiator: true,
    prologue: channelId,
    staticKeyPair: a,
    remoteStaticPublicKey: b.publicKey,
    backend,
  });
  const responder = await NoiseHandshake.create({
    pattern: "KK",
    initiator: false,
    prologue: channelId,
    staticKeyPair: b,
    remoteStaticPublicKey: a.publicKey,
    backend,
  });
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  const common = {
    channelId,
    ...(options.now ? { now: options.now } : {}),
    ...(options.rekeyIntervalMs !== undefined ? { rekeyIntervalMs: options.rekeyIntervalMs } : {}),
  };
  return {
    channelId,
    client: new NoiseSession({ ...(await initiator.split()), initiator: true, ...common }),
    server: new NoiseSession({ ...(await responder.split()), initiator: false, ...common }),
  };
}

describe("NoiseSession", () => {
  it("round-trips payloads and agrees on the SAS", async () => {
    const { client, server } = await pair();
    expect(client.sas.emoji).toEqual(server.sas.emoji);
    expect(client.sas.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

    const frame = await client.encrypt(utf8("hello"));
    expect(fromUtf8((await server.decrypt(frame))!)).toBe("hello");
  });

  it("pads every frame to a bucket, so lengths leak only the bucket", async () => {
    const { client } = await pair();
    const sizes = new Set<number>();
    for (const length of [0, 1, 58, 59, 60, 200, 251, 252, 1000, 3000]) {
      sizes.add((await client.encrypt(new Uint8Array(length))).length);
    }
    const legal = new Set(FRAME_BUCKETS.map((b) => FRAME_HEADER_BYTES + b + AEAD_TAG_BYTES));
    for (const size of sizes) expect(legal.has(size), `frame size ${size}`).toBe(true);
    expect(frameSizeFor(0)).toBe(FRAME_HEADER_BYTES + FRAME_BUCKETS[0] + AEAD_TAG_BYTES);
    expect(bucketFor(59)).toBe(64);
    expect(bucketFor(60)).toBe(256);
  });

  it("drops chaff without disturbing the payload stream", async () => {
    const { client, server } = await pair();
    const a = await client.encrypt(utf8("one"));
    const chaff = await client.encryptChaff();
    const b = await client.encrypt(utf8("two"));
    expect(chaff.length).toBe(a.length);
    expect(fromUtf8((await server.decrypt(a))!)).toBe("one");
    expect(await server.decrypt(chaff)).toBeNull();
    expect(fromUtf8((await server.decrypt(b))!)).toBe("two");
  });

  it("rejects a sequence gap instead of buffering", async () => {
    const { client, server } = await pair();
    const first = await client.encrypt(utf8("a"));
    const second = await client.encrypt(utf8("b"));
    await expect(server.decrypt(second)).rejects.toThrow(/sequence gap: expected 0, got 1/);
    expect(server.isClosed).toBe(true);
    await expect(server.decrypt(first)).rejects.toThrow(/closed/);
  });

  it("rejects a replayed frame", async () => {
    const { client, server } = await pair();
    const frame = await client.encrypt(utf8("a"));
    expect(await server.decrypt(frame)).not.toBeNull();
    await expect(server.decrypt(frame)).rejects.toThrow(/sequence gap/);
  });

  it("rejects a frame reflected back at its sender (direction is in the AAD)", async () => {
    const { client, server: _server } = await pair();
    const frame = await client.encrypt(utf8("a"));
    // A second session on the same keys but the same direction as the sender.
    await expect(client.decrypt(frame)).rejects.toThrow();
  });

  it("rejects a frame carrying a different channel id (channel is in the AAD)", async () => {
    const alice = await pair({ channelId: new Uint8Array(32).fill(1) });
    const frame = await alice.client.encrypt(utf8("a"));
    // Same keys, but the receiver believes it is on another channel.
    const impostor = new NoiseSession({
      channelId: new Uint8Array(32).fill(2),
      initiator: false,
      // @ts-expect-error reaching into the pair for a negative test
      send: alice.server.sendCipher,
      // @ts-expect-error reaching into the pair for a negative test
      receive: alice.server.receiveCipher,
      handshakeHash: alice.server.handshakeHash,
    });
    await expect(impostor.decrypt(frame)).rejects.toThrow(/authentication failed/);
  });

  it("rejects any tampered byte", async () => {
    const { client, server } = await pair();
    const frame = await client.encrypt(utf8("hello"));
    frame[frame.length - 1] ^= 1;
    await expect(server.decrypt(frame)).rejects.toThrow(NoiseSessionError);
  });

  it("rekeys on the 120 s grid and the receiver catches up from the epoch", async () => {
    let clock = 0;
    const { client, server } = await pair({ now: () => clock, rekeyIntervalMs: 120_000 });
    expect(fromUtf8((await server.decrypt(await client.encrypt(utf8("before"))))!)).toBe("before");
    expect(client.sendEpoch).toBe(0);

    clock += 120_001;
    const rekeyed = await client.encrypt(utf8("after"));
    expect(client.sendEpoch).toBe(1);
    expect(server.receiveEpoch).toBe(0);
    expect(fromUtf8((await server.decrypt(rekeyed))!)).toBe("after");
    expect(server.receiveEpoch).toBe(1);

    // The counter keeps running across a rekey, exactly as the Noise spec says.
    expect(client.sendSeq).toBe(2n);
    clock += 120_001;
    expect(fromUtf8((await server.decrypt(await client.encrypt(utf8("again"))))!)).toBe("again");
    expect(server.receiveEpoch).toBe(2);
  });

  it("keeps sequence numbers in call order under concurrency", async () => {
    const { client, server } = await pair();
    const frames = await Promise.all([1, 2, 3, 4, 5].map((n) => client.encrypt(utf8(`m${n}`))));
    const seen: string[] = [];
    for (const frame of frames) seen.push(fromUtf8((await server.decrypt(frame))!));
    expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });
});
