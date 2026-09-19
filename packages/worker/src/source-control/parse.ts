import type { ChangedFile, FileChangeStatus } from "@lasercode/protocol";

/** `git diff --numstat -z`: `added\\tremoved\\tpath\\0`. Binaries use `-`. */
export function parseNumstatFiles(text: string): Map<string, { added: number | null; removed: number | null }> {
  const out = new Map<string, { added: number | null; removed: number | null }>();
  for (const chunk of text.split("\0")) {
    if (!chunk) continue;
    const first = chunk.indexOf("\t");
    const second = chunk.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const addedRaw = chunk.slice(0, first);
    const removedRaw = chunk.slice(first + 1, second);
    const path = chunk.slice(second + 1);
    if (!path) continue;
    out.set(path, {
      added: addedRaw === "-" ? null : Number.parseInt(addedRaw, 10) || 0,
      removed: removedRaw === "-" ? null : Number.parseInt(removedRaw, 10) || 0,
    });
  }
  return out;
}

/** `git diff --name-status --no-renames -z`: `status\\0path\\0`. */
export function parseNameStatus(text: string): Map<string, FileChangeStatus> {
  const out = new Map<string, FileChangeStatus>();
  const chunks = text.split("\0");
  for (let i = 0; i < chunks.length; i++) {
    const code = chunks[i];
    if (!code) continue;
    const path = chunks[i + 1];
    if (!path) continue;
    i += 1;
    const letter = code[0];
    if (letter === "A") out.set(path, "added");
    else if (letter === "D") out.set(path, "deleted");
    else out.set(path, "modified");
  }
  return out;
}

export function mergeChangeLists(
  status: Map<string, FileChangeStatus>,
  numstat: Map<string, { added: number | null; removed: number | null }>,
): ChangedFile[] {
  const paths = new Set([...status.keys(), ...numstat.keys()]);
  const files: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const counts = numstat.get(path) ?? { added: 0, removed: 0 };
    const kind = status.get(path) ?? (counts.added && !counts.removed ? "added" : counts.removed && !counts.added ? "deleted" : "modified");
    files.push({ path, status: kind, added: counts.added, removed: counts.removed });
  }
  return files;
}
