import type { DialogForm } from "../dialogs/model.js";
import type { AppState } from "../store.js";

export type DialogValues = Record<string, string | boolean>;

/** Presentation only. The canonical request and the existing answer action own settlement. */
export class QuestionPresentation {
  private state: { values: DialogValues; declining: boolean; busy: boolean };
  private listeners = new Set<() => void>();
  private disposed = false;
  private present = true;
  private focused = false;
  private declineFocus = false;
  readonly deadline: number | undefined;
  constructor(form: DialogForm, declining = false, now = Date.now(), private onDispose?: () => void) {
    this.state = { values: Object.fromEntries(form.fields.filter(f => f.default !== undefined).map(f => [f.id, f.default!])), declining, busy: false };
    this.deadline = form.timeoutMs === undefined ? undefined : now + form.timeoutMs;
    this.declineFocus = declining;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<typeof this.state>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setValue = (id: string, value: string | boolean) => this.update({ values: { ...this.state.values, [id]: value } });
  setDeclining = (declining: boolean) => { if (declining && !this.state.declining) this.declineFocus = true; this.update({ declining }); };
  claimInitialFocus() { if (this.focused) return false; this.focused = true; return true; }
  claimDeclineFocus() { const pending = this.declineFocus; this.declineFocus = false; return pending; }
  /** Synchronous guard shared by every mounted presentation of this request. */
  async answer(send: () => Promise<unknown>): Promise<void> {
    if (this.disposed || this.state.busy) return;
    this.update({ busy: true });
    try { await send(); } finally { this.update({ busy: false }); if (!this.present) this.dispose(); }
  }
  /** answerDialog removes optimistically, then restores the same request on failure. */
  setPresent(present: boolean) { this.present = present; if (!present && !this.state.busy) this.dispose(); }
  dispose() { this.disposed = true; this.listeners.clear(); this.onDispose?.(); }
}

export class MessageEditPresentation {
  private state: { draft: string; editing: boolean; sending: boolean };
  private listeners = new Set<() => void>();
  constructor(draft: string) { this.state = { draft, editing: false, sending: false }; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(patch: Partial<typeof this.state>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
}

/** Owned by the canonical app store, never by a mounted tool row or a Beam scope. */
export class TranscriptPresentation {
  private questions = new Map<string, Map<string, QuestionPresentation>>();
  private edits = new Map<string, Map<string, MessageEditPresentation>>();
  edit(path: string, id: string) { return this.edits.get(path)?.get(id); }
  rememberEdit(path: string, id: string, edit: MessageEditPresentation) {
    let session = this.edits.get(path);
    if (!session) this.edits.set(path, session = new Map());
    session.set(id, edit);
  }
  releaseEdit(path: string, id: string) { const session = this.edits.get(path); session?.delete(id); if (!session?.size) this.edits.delete(path); }
  /**
   * This session holds a message edit a person has started and not sent
   * (RP-5). Their words, held nowhere else: the transcript under them is never
   * released while it is here. An edit whose draft is empty holds nothing.
   */
  hasEditDraft(path: string): boolean {
    const session = this.edits.get(path);
    if (!session) return false;
    for (const edit of session.values()) if (edit.getSnapshot().draft.trim() !== "") return true;
    return false;
  }
  question(path: string, form: DialogForm, declining = false): QuestionPresentation {
    let session = this.questions.get(path);
    if (!session) this.questions.set(path, session = new Map());
    let question = session.get(form.id);
    if (!question) {
      const owned = session;
      question = new QuestionPresentation(form, declining, Date.now(), () => {
        if (owned.get(form.id) === question) owned.delete(form.id);
        if (!owned.size) this.questions.delete(path);
      });
      session.set(form.id, question);
    }
    return question;
  }
  reconcile(state: AppState) {
    for (const path of this.edits.keys()) if (!state.open[path]) this.edits.delete(path);
    for (const [path, questions] of this.questions) {
      const ids = new Set(state.open[path]?.dialogs.map(dialog => dialog.id));
      for (const [id, question] of questions) {
        if (!state.open[path]) question.dispose();
        else question.setPresent(ids.has(id));
      }
      if (!questions.size) this.questions.delete(path);
    }
  }
}
