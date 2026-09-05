/**
 * The one dictation adapter instance the runtime and the composer button share.
 *
 * assistant-ui wants the adapter in the runtime's `adapters.dictation`; the
 * button that starts it lives in the composer and wants the live level, the
 * phase, the last error and the final phrase. Module-level stores connect the
 * two without either knowing about the other.
 */
import { useSyncExternalStore } from "react";
import {
  MediaRecorderDictationAdapter,
  transcribeTransport,
  type DictationPhase,
  type TranscribeScope,
} from "./dictation.js";
import type { RawRequestClient } from "./host-rpc.js";

function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of listeners) l();
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const level = store(0);
const phase = store<DictationPhase>("idle");
const error = store<unknown>(undefined);
let phraseSink: ((phrase: string) => void) | undefined;

let instance: { client: RawRequestClient; adapter: MediaRecorderDictationAdapter } | undefined;

/**
 * Which project and session a recording belongs to. Read at `begin` time, not
 * at construction: the adapter outlives every session, and the recording that
 * matters is the one being made now.
 */
let scope: TranscribeScope | undefined;

export function setDictationScope(next: TranscribeScope | undefined): void {
  scope = next;
}

/** One adapter per host client. Safe to call on every render. */
export function getMobileDictationAdapter(client: RawRequestClient): MediaRecorderDictationAdapter {
  if (instance?.client === client) return instance.adapter;
  const adapter = new MediaRecorderDictationAdapter({
    transport: transcribeTransport(client, () => scope),
    onLevel: (v) => level.set(v),
    onPhase: (p) => phase.set(p),
    onPhrase: (p) => phraseSink?.(p),
    onError: (e) => error.set(e),
  });
  instance = { client, adapter };
  return adapter;
}

/** The composer button registers where the final phrase should go (caret placement). */
export function setDictationPhraseSink(sink: ((phrase: string) => void) | undefined): void {
  phraseSink = sink;
}

export function clearDictationError(): void {
  error.set(undefined);
}

export const useDictationLevel = (): number => useSyncExternalStore(level.subscribe, level.get, () => 0);
export const useDictationPhase = (): DictationPhase => useSyncExternalStore(phase.subscribe, phase.get, () => "idle" as const);
export const useDictationError = (): unknown => useSyncExternalStore(error.subscribe, error.get, () => undefined);
