import { useEffect, useState } from "react";
import type { UiDialogRequest, UiDialogResponse } from "@piorbit/protocol";
import type { SessionView } from "../store.js";

interface Props {
  view: SessionView;
  onAnswer: (response: UiDialogResponse) => Promise<void>;
}

/** Extension dialogs (M1-T6). One at a time, oldest first; never modal-trapped: Esc cancels. */
export function Dialogs({ view, onAnswer }: Props) {
  const dialog = view.dialogs[0];
  if (!dialog) return null;
  return <Dialog key={dialog.id} dialog={dialog} onAnswer={onAnswer} />;
}

function Dialog({ dialog, onAnswer }: { dialog: UiDialogRequest; onAnswer: Props["onAnswer"] }) {
  const [value, setValue] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
  const [left, setLeft] = useState<number | undefined>(dialog.timeoutMs ? Math.ceil(dialog.timeoutMs / 1000) : undefined);

  useEffect(() => {
    if (left === undefined) return;
    const t = setInterval(() => setLeft((s) => (s === undefined || s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [left === undefined]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void onAnswer({ id: dialog.id, cancelled: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog.id, onAnswer]);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label={dialog.title}>
      <div className="dialog">
        <h2>{dialog.title}</h2>
        {left !== undefined && <p className="muted">Auto-cancels in {left}s</p>}
        {dialog.method === "select" && (
          <div className="dialog-options">
            {dialog.options.map((o) => (
              <button key={o} onClick={() => void onAnswer({ id: dialog.id, value: o })}>{o}</button>
            ))}
          </div>
        )}
        {dialog.method === "confirm" && (
          <>
            {dialog.message && <p>{dialog.message}</p>}
            <div className="dialog-actions">
              <button className="primary" onClick={() => void onAnswer({ id: dialog.id, confirmed: true })}>Yes</button>
              <button onClick={() => void onAnswer({ id: dialog.id, confirmed: false })}>No</button>
            </div>
          </>
        )}
        {dialog.method === "input" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onAnswer({ id: dialog.id, value });
            }}
          >
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={dialog.placeholder} />
            <div className="dialog-actions">
              <button className="primary" type="submit">OK</button>
              <button type="button" onClick={() => void onAnswer({ id: dialog.id, cancelled: true })}>Cancel</button>
            </div>
          </form>
        )}
        {dialog.method === "editor" && (
          <>
            <textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} rows={12} />
            <div className="dialog-actions">
              <button className="primary" onClick={() => void onAnswer({ id: dialog.id, value })}>Save</button>
              <button onClick={() => void onAnswer({ id: dialog.id, cancelled: true })}>Cancel</button>
            </div>
          </>
        )}
        {dialog.method === "select" && (
          <div className="dialog-actions">
            <button onClick={() => void onAnswer({ id: dialog.id, cancelled: true })}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
