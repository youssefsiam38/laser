/** Owned by one local socket / relay generation, never by the shared router. */
export class SearchCancellation {
  private readonly active = new Map<string, AbortController>();
  private closed = false;

  begin(id: string): { signal: AbortSignal; finish(): void } {
    this.cancel(id);
    const controller = new AbortController();
    if (this.closed) controller.abort();
    else this.active.set(id, controller);
    return { signal: controller.signal, finish: () => {
      if (this.active.get(id) === controller) this.active.delete(id);
    } };
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
    this.active.delete(id);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}
