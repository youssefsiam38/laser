/**
 * provider-log — feeds the logs page (M4-T5).
 * Always active. `before_provider_request` carries the full serialized provider
 * payload; `after_provider_response` carries status and headers only (Pi exposes
 * no raw response body; the assembled assistant message comes from session events).
 */
import type { PiorbitModule } from "./index.js";

export const providerLogModule: PiorbitModule = {
  name: "provider-log",
  detect: () => true,
  activate({ pi, send }) {
    pi.on("before_provider_request", async (event: { payload: unknown }) => {
      send({ type: "piorbit/provider/request", at: new Date().toISOString(), payload: event.payload });
      return undefined;
    });
    pi.on("after_provider_response", async (event: { status: number; headers: Record<string, string> }) => {
      send({ type: "piorbit/provider/response", at: new Date().toISOString(), status: event.status, headers: event.headers });
      return undefined;
    });
  },
};
