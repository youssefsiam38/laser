/**
 * Ask the Wayland compositor which protocols it offers.
 *
 * This is the whole wire protocol we need: connect to the display socket,
 * request the registry, ask for a sync, and read `wl_registry.global` events
 * until the sync callback fires. No library, no fds, a few hundred bytes.
 *
 * It exists because Chromium cannot tell us afterwards whether the compositor
 * supports explicit sync (`wp_linux_drm_syncobj_manager_v1`), and on an NVIDIA
 * GPU that single fact decides whether the window will show the frame that was
 * actually rendered or one from a moment ago. See `linux-display.ts`.
 *
 * The file doubles as a tiny program: run under Node (Electron with
 * `ELECTRON_RUN_AS_NODE=1`), it prints `{ globals: string[] }` as JSON and
 * exits. `linux-display.ts` runs it synchronously before the browser process
 * starts, which is the only moment a Chromium switch can still be set.
 */
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `wl_display` is always object 1; we allocate 2 for the registry, 3 for the sync callback. */
const DISPLAY = 1;
const REGISTRY = 2;
const CALLBACK = 3;

export interface WaylandGlobalsResult {
  globals: string[];
  error?: string;
}

/** Where the compositor listens, following the same rules as libwayland. */
export function waylandSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  const display = env["WAYLAND_DISPLAY"] ?? "wayland-0";
  if (isAbsolute(display)) return display;
  const runtime = env["XDG_RUNTIME_DIR"];
  return runtime ? join(runtime, display) : undefined;
}

/** The two requests we send, back to back: `wl_display.get_registry(2)` and `wl_display.sync(3)`. */
export function registryAndSyncRequests(): Buffer {
  const message = Buffer.alloc(24);
  message.writeUInt32LE(DISPLAY, 0);
  message.writeUInt32LE((12 << 16) | 1, 4); // size 12, opcode 1 = get_registry
  message.writeUInt32LE(REGISTRY, 8);
  message.writeUInt32LE(DISPLAY, 12);
  message.writeUInt32LE((12 << 16) | 0, 16); // size 12, opcode 0 = sync
  message.writeUInt32LE(CALLBACK, 20);
  return message;
}

export interface ParsedEvents {
  /** Interface names from every `wl_registry.global` seen so far. */
  globals: string[];
  /** True once the sync callback's `done` arrived: the registry is complete. */
  done: boolean;
  /** Bytes left over: an incomplete trailing message. */
  rest: Buffer;
}

/**
 * Decode as many complete Wayland messages as `buffer` holds. Every message is
 * `uint32 object id`, `uint32 size << 16 | opcode`, then arguments; a string is
 * `uint32 length` (counting its NUL) followed by the bytes padded to four.
 */
export function parseWaylandEvents(buffer: Buffer, globals: string[] = []): ParsedEvents {
  let done = false;
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const object = buffer.readUInt32LE(offset);
    const sizeAndOpcode = buffer.readUInt32LE(offset + 4);
    const size = sizeAndOpcode >>> 16;
    const opcode = sizeAndOpcode & 0xffff;
    if (size < 8 || buffer.length - offset < size) break;
    if (object === REGISTRY && opcode === 0 && size >= 16) {
      // global(name: uint, interface: string, version: uint)
      const length = buffer.readUInt32LE(offset + 12);
      const start = offset + 16;
      const end = Math.min(start + Math.max(length - 1, 0), offset + size);
      globals.push(buffer.toString("utf8", start, end));
    } else if (object === CALLBACK && opcode === 0) {
      done = true;
    }
    offset += size;
  }
  return { globals, done, rest: buffer.subarray(offset) };
}

/** Connect, ask, and resolve with the interface names. Never rejects; errors are reported in the result. */
export function readWaylandGlobals(env: NodeJS.ProcessEnv, timeoutMs = 1000): Promise<WaylandGlobalsResult> {
  return new Promise((resolve) => {
    const path = waylandSocketPath(env);
    if (!path) {
      resolve({ globals: [], error: "no XDG_RUNTIME_DIR" });
      return;
    }
    const globals: string[] = [];
    let pending: Buffer = Buffer.alloc(0);
    let settled = false;
    const socket = connect(path);
    const finish = (result: WaylandGlobalsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ globals, error: "timeout" }), timeoutMs);
    socket.on("connect", () => socket.write(registryAndSyncRequests()));
    socket.on("data", (chunk: Buffer) => {
      const parsed = parseWaylandEvents(Buffer.concat([pending, chunk]), globals);
      pending = parsed.rest;
      if (parsed.done) finish({ globals });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => finish({ globals, error: error.code ?? String(error) }));
    socket.on("close", () => finish({ globals, error: "closed" }));
  });
}

// Run as a program: print the result as one line of JSON.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  readWaylandGlobals(process.env).then((result) => {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  });
}
