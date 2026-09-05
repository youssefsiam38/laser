/**
 * WireGuard-style cookies (RFC-less but well described in the WireGuard paper,
 * §5.4). Under load the relay stops doing work for unverified sources: it hands
 * back a MAC of the client's IP under a secret it rotates every two minutes and
 * refuses the connection. A client that can actually receive at that address
 * echoes the cookie back and gets in.
 *
 * The point is that the responder keeps **zero per-client state**: the cookie is
 * verified by recomputation, so a flood costs one HMAC and nothing else.
 *
 * `node:crypto`'s HMAC is a Node built-in, not a linked crypto library
 * (AGENTS.md invariant 7). It never touches channel traffic: the only input is a
 * source IP, and the relay holds no key related to any channel.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_ROTATION_MS = 120_000;
const COOKIE_BYTES = 16;

export class CookieJar {
  private current = randomBytes(32);
  private previous = randomBytes(32);
  private rotatedAt: number;

  constructor(
    private readonly rotationMs: number = COOKIE_ROTATION_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.rotatedAt = this.now();
  }

  /** The cookie a client at `ip` should echo back. */
  issue(ip: string): string {
    this.maybeRotate();
    return this.mac(this.current, ip);
  }

  /** Accepts the current secret and the previous one, so a rotation mid-retry is not a failure. */
  verify(ip: string, cookie: string | undefined): boolean {
    if (!cookie) return false;
    this.maybeRotate();
    return this.equals(cookie, this.mac(this.current, ip)) || this.equals(cookie, this.mac(this.previous, ip));
  }

  /**
   * Rotate by elapsed windows, not by call. Advancing one step per invocation
   * meant that after a quiet stretch — and cookies are only touched under load,
   * so quiet stretches are the norm — an hours-old secret was promoted into
   * `previous` and stayed acceptable for another full window. Nothing older
   * than one window survives now, and `rotatedAt` advances on the schedule
   * rather than drifting to the time of the call.
   */
  private maybeRotate(): void {
    const now = this.now();
    const steps = Math.floor((now - this.rotatedAt) / this.rotationMs);
    if (steps < 1) return;
    if (steps >= 2) this.previous = randomBytes(32);
    else this.previous = this.current;
    this.current = randomBytes(32);
    this.rotatedAt += steps * this.rotationMs;
  }

  private mac(secret: Buffer, ip: string): string {
    return createHmac("sha256", secret).update(ip).digest().subarray(0, COOKIE_BYTES).toString("base64url");
  }

  private equals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
