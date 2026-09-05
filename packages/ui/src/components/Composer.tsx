import { useEffect, useRef, useState } from "react";
import type { ContentBlock } from "@piorbit/protocol";
import type { SessionView } from "../store.js";

interface Props {
  view: SessionView;
  onSend: (content: ContentBlock[], behavior: "prompt" | "steer" | "followUp") => Promise<void>;
  onAbort: () => Promise<void>;
}

export function Composer({ view, onSend, onAbort }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ mimeType: string; data: string }>>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Extensions may set the editor text (setEditorText / pasteToEditor).
  useEffect(() => {
    if (view.editorText !== undefined) setText(view.editorText);
  }, [view.editorText]);

  const submit = async (behavior: "prompt" | "steer" | "followUp") => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    const content: ContentBlock[] = [];
    if (trimmed) content.push({ type: "text", text: trimmed });
    for (const img of images) content.push({ type: "image", mimeType: img.mimeType, data: img.data });
    // Clear immediately: an extension command keeps `session/prompt` pending
    // until its dialog is answered, and the composer must not look stuck.
    const restore = { text, images };
    setText("");
    setImages([]);
    setBusy(true);
    try {
      await onSend(content, behavior);
    } catch {
      setText(restore.text);
      setImages(restore.images);
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    for (const item of e.clipboardData.items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        setImages((imgs) => [...imgs, { mimeType: item.type, data: url.slice(url.indexOf(",") + 1) }]);
      };
      reader.readAsDataURL(file);
      e.preventDefault();
    }
  };

  const below = Object.entries(view.widgets).filter(([, w]) => w.placement === "belowEditor");
  const statuses = Object.entries(view.statuses);

  return (
    <div className="composer">
      {(view.queue.steering.length > 0 || view.queue.followUp.length > 0) && (
        <div className="queue">
          {view.queue.steering.map((q, i) => (
            <span key={`s${i}`} className="chip chip-steer" title="steer: delivered after this turn's tools">{q}</span>
          ))}
          {view.queue.followUp.map((q, i) => (
            <span key={`f${i}`} className="chip chip-follow" title="follow-up: delivered when the agent stops">{q}</span>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="attachments">
          {images.map((img, i) => (
            <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" onClick={() => setImages((a) => a.filter((_, j) => j !== i))} title="Click to remove" />
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        placeholder={view.running ? "Steer (Enter) or queue a follow-up (Shift+Enter)…" : "Message Pi… (Enter to send, Shift+Enter for newline)"}
        rows={Math.min(8, Math.max(1, text.split("\n").length))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit(view.running ? "steer" : "prompt");
          } else if (e.key === "Enter" && e.shiftKey && view.running) {
            e.preventDefault();
            void submit("followUp");
          }
        }}
        aria-label="Message"
      />
      <div className="composer-row">
        <div className="statuses">
          {statuses.map(([k, v]) => (
            <span key={k} className="status" title={k}>{v}</span>
          ))}
        </div>
        {view.running ? (
          <>
            <button onClick={() => void submit("steer")} disabled={busy}>Steer</button>
            <button onClick={() => void submit("followUp")} disabled={busy}>Follow up</button>
            <button className="danger" onClick={() => void onAbort()}>Stop</button>
          </>
        ) : (
          <button className="primary" onClick={() => void submit("prompt")} disabled={busy || (!text.trim() && images.length === 0)}>
            Send
          </button>
        )}
      </div>
      {below.map(([key, w]) => (
        <pre key={key} className="widget">{w.lines.join("\n")}</pre>
      ))}
    </div>
  );
}
