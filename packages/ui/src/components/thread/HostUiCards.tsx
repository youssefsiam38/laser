import { useEffect } from "react";
import type { UiDialogRequest, UiDialogResponse } from "@piorbit/protocol";

import { useHostUiRequests } from "@/runtime";
import { DialogBody } from "./DialogBody.js";

/**
 * Free-standing extension dialogs (no owning tool row), one at a time,
 * oldest first, rendered as a card above the composer. Non-modal: the
 * composer stays usable; Esc anywhere cancels the top card unless a Radix
 * layer already consumed the key.
 */
export function HostUiCards() {
  const { requests, respond } = useHostUiRequests();
  const request = requests[0];
  if (!request) return null;
  return <HostUiCard key={request.id} request={request} respond={respond} pending={requests.length - 1} />;
}

function HostUiCard({
  request,
  respond,
  pending,
}: {
  request: UiDialogRequest;
  respond: (response: UiDialogResponse) => Promise<void>;
  pending: number;
}) {
  const answer = (response: UiDialogResponse) => void respond(response).catch(() => {});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      answer({ id: request.id, cancelled: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);

  return (
    <div
      data-slot="host-ui-card"
      role="region"
      aria-label={`Extension ${request.method}: ${request.title}`}
      className="rounded-2xl border border-line bg-surface p-4 shadow-float-sm"
    >
      <DialogBody
        dialog={request}
        eyebrow={`Extension · ${request.method}${pending > 0 ? ` · +${pending} waiting` : ""}`}
        onValue={(value) => answer({ id: request.id, value })}
        onConfirm={(confirmed) => answer({ id: request.id, confirmed })}
        onCancel={() => answer({ id: request.id, cancelled: true })}
      />
    </div>
  );
}
