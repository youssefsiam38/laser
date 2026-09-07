/**
 * provider-log — feeds the logs page (M4-T5).
 * Always active. `before_provider_request` carries the full serialized provider
 * payload; `after_provider_response` carries status and headers only (Pi exposes
 * no raw response body; the assembled assistant message comes from session events).
 */
import type { LaserModule } from "./index.js";
import type { BeforeProviderRequestEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InstructionSourceMap } from "@lasercode/protocol";

export const providerLogModule: LaserModule = {
  name: "provider-log",
  detect: () => true,
  activate({ pi, send, requestProvenance }) {
    const capture = (event: BeforeProviderRequestEvent, ctx: ExtensionContext, sources?: InstructionSourceMap[]) => {
      const prompt = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
      send({ type: "lasercode/provider/request", at: new Date().toISOString(), payload: event.payload,
        context: {
          ...(prompt ? { promptEntryId: prompt.id } : {}),
          ...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, api: ctx.model.api } : {}),
          ...(sources ? { instructionSources: sources } : {}),
        },
      });
      return undefined;
    };
    if (requestProvenance) requestProvenance.onRequest(capture);
    else pi.on("before_provider_request", async (event, ctx) => capture(event, ctx));
    pi.on("after_provider_response", async (event: { status: number; headers: Record<string, string> }) => {
      send({ type: "lasercode/provider/response", at: new Date().toISOString(), status: event.status, headers: event.headers });
      return undefined;
    });
  },
};
