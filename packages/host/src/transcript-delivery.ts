import { parseClientRequest, type JsonRpcNotification, type JsonRpcResponse, type SessionUpdateParams } from "@lasercode/protocol";

/** Connection-local transcript admission, deliberately separate from retirement
 * attachments. Loaded caches still need every seq after leaving the screen.
 * Legacy consumers retain the full stream until explicitly opting in. */
export class TranscriptDelivery {
  private selective = false;
  private readonly loaded = new Set<string>();
  private readonly loading = new Map<string, number>();
  private creating = 0;

  begin(raw: unknown): (response?: JsonRpcResponse) => void {
    let request;
    try { request = parseClientRequest(raw); } catch { return () => {}; }
    if (request.method === "session/load") {
      const { path, transcript } = request.params;
      if (transcript === "loaded") this.selective = true;
      this.loading.set(path, (this.loading.get(path) ?? 0) + 1);
      return response => {
        const count = (this.loading.get(path) ?? 1) - 1;
        if (count) this.loading.set(path, count); else this.loading.delete(path);
        if (response && !response.error) this.loaded.add(path);
      };
    }
    if (request.method === "session/new" || request.method === "pi/session/fork") {
      // The worker chooses the destination path. Admit its first events before
      // the response tells us which cache owns them, then narrow again.
      this.creating++;
      return response => {
        this.creating--;
        const path = (response?.result as { state?: { path?: string } } | undefined)?.state?.path;
        if (response && !response.error && path) this.loaded.add(path);
      };
    }
    return () => {};
  }

  accepts(notification: JsonRpcNotification): boolean {
    if (!this.selective || this.creating || notification.method !== "session/update") return true;
    const path = (notification.params as SessionUpdateParams).sessionPath;
    return this.loaded.has(path) || this.loading.has(path);
  }
}
