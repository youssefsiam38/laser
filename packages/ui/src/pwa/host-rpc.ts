/**
 * The push and dictation RPCs, as the page calls them.
 *
 * The shapes themselves live in `@lasercode/protocol` — the host answers push,
 * the worker answers dictation, and both are in the schema map the router
 * validates against. This file is what is left once that happened: the two
 * value types the page re-exports for convenience, and a thin typed `request`
 * so a call site cannot misspell a method or its params.
 *
 * Every call goes over the same JSON-RPC socket as the rest of the app, so it
 * also works through the relay — there is no second HTTP channel a phone would
 * have to reach.
 */
import type { ClientRequests } from "@lasercode/protocol";

export type {
  PushConfig,
  PushDeviceInfo,
  PushSubscriptionJson,
  TranscribeStatus,
} from "@lasercode/protocol";

/** The methods this layer uses. A subset of `ClientRequests`, named for the call sites. */
export type MobileMethod = Extract<keyof ClientRequests, `pi/push/${string}` | `pi/transcribe/${string}`>;

/** The one method the client needs; `HostClient` satisfies it structurally after a cast. */
export interface RawRequestClient {
  request(method: string, params: unknown): Promise<unknown>;
}

export function extendedRequest<M extends MobileMethod>(
  client: RawRequestClient,
  method: M,
  params: ClientRequests[M]["params"],
): Promise<ClientRequests[M]["result"]> {
  return client.request(method, params) as Promise<ClientRequests[M]["result"]>;
}

/** Narrow any object with a `request(method, params)` method to the raw shape. */
export function asRawClient(client: { request(method: never, params: never): Promise<unknown> }): RawRequestClient {
  return client as unknown as RawRequestClient;
}
