import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { providerLogModule } from "../src/modules/provider-log.js";

it("records the last user on the active branch without rewriting the provider payload", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
  const send = vi.fn();
  await providerLogModule.activate({pi:{on:(name:string,handler:never)=>handlers.set(name,handler)} as unknown as ExtensionAPI,send});
  const ctx={model:{provider:"openai",id:"test",api:"openai-responses"},sessionManager:{getBranch:()=>[
    {type:"message",id:"earlier",message:{role:"user"}},
    {type:"message",id:"current",message:{role:"user"}},
    {type:"message",id:"tool",message:{role:"toolResult"}},
  ]}} as unknown as ExtensionContext;
  const payload={model:"test",input:[{role:"user",content:"question"}]};
  const result=await handlers.get("before_provider_request")!({payload},ctx);
  expect(result).toBeUndefined();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({payload,context:{promptEntryId:"current",provider:"openai",model:"test",api:"openai-responses"}}));
  expect(send.mock.calls[0]?.[0].payload).toBe(payload);
});
