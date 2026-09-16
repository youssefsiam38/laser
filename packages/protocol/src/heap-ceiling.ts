/** Bytes in one mebibyte. Shared by launchers and explicit-argv reporting. */
export const MIB_BYTES = 1024 * 1024;

/**
 * Read only an explicit Node old-space flag.
 *
 * V8's measured heap limit is a different fact and must never be
 * reverse-engineered into configuration. The last explicit spelling wins,
 * matching Node's argv handling.
 */
export function configuredOldSpaceBytes(execArgv: readonly string[]): number | undefined {
  let raw: string | undefined;
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index]!;
    if (value === "--max-old-space-size") {
      raw = execArgv[index + 1];
      index += 1;
      continue;
    }
    if (value.startsWith("--max-old-space-size=")) raw = value.slice("--max-old-space-size=".length);
  }
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  const mib = Number(raw);
  const bytes = mib * MIB_BYTES;
  return Number.isSafeInteger(mib) && Number.isSafeInteger(bytes) ? bytes : undefined;
}

/**
 * Environment inherited by a Node child after removing every case spelling of
 * NODE_OPTIONS. Optional prefixes let a platform launcher remove its own
 * process controls without duplicating the security-sensitive loop.
 */
export function nodeLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  options: { dropPrefixes?: readonly string[] } = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "NODE_OPTIONS" || options.dropPrefixes?.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  return env;
}
