// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogEntry } from "@lasercode/protocol";
import { ApiRequestDialog } from "../../src/components/logs/ApiRequestDialog.js";

const client=vi.hoisted(()=>({request:vi.fn(),subscribe:vi.fn(()=>()=>{})}));
vi.mock("@/runtime",()=>({useLaserStable:()=>({client})}));
let container:HTMLDivElement;
let root:Root;
const entry:LogEntry={id:1,at:"2026-09-06T10:00:00.000Z",section:"provider",kind:"provider_request",level:"info",summary:"test-model",sessionPath:"/session",
  requestContext:{promptEntryId:"user-1",provider:"openai",model:"test-model"},
  detail:{instructions:"Unique system instructions",tools:[{name:"read",parameters:{type:"object"}}],input:[{role:"user",content:"hello"}],temperature:0.2}};
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;client.request.mockReset();client.subscribe.mockClear();container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
const click=async(text:string)=>{const button=[...document.body.querySelectorAll("button")].find(button=>button.textContent?.includes(text));expect(button).toBeDefined();await act(async()=>button!.click());};

it("loads exact message-linked requests and exposes tools, parameters, full JSON and close",async()=>{
  client.request.mockResolvedValue({entries:[entry],hasMore:false});
  const close=vi.fn();
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"message",path:"/session",entryId:"user-1"}} onClose={close}/>));
  expect(client.request).toHaveBeenCalledWith("pi/logs/query",expect.objectContaining({sessionPath:"/session",promptEntryId:"user-1",kind:"provider_request"}));
  expect(document.body.textContent).toContain("Unique system instructions");
  expect(document.querySelector(".md-body")).toBeNull();
  await click("Markdown");
  expect(client.request).toHaveBeenCalledWith("pi/prefs/set",{namespace:"request-inspector",value:{contentView:"markdown"}});
  expect(document.querySelector(".md-body")).not.toBeNull();
  await click("Tools");await click("read");expect(document.body.textContent).toContain("parameters");
  await click("Parameters");expect(document.body.textContent).toContain("temperature");
  await click("Full JSON");expect(document.querySelector('[data-slot="json-viewer"]')).not.toBeNull();
  await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());expect(close).toHaveBeenCalledOnce();
});
it("labels timestamp fallback and excludes captures linked to a different message",async()=>{
  const {requestContext:_,...legacy}=entry;
  client.request.mockResolvedValueOnce({entries:[],hasMore:false}).mockResolvedValueOnce({entries:[legacy,{...entry,id:2}],hasMore:false});
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"message",path:"/session",entryId:"old",at:entry.at,beforeAt:"2026-09-06T10:01:00.000Z"}} onClose={()=>{}}/>));
  expect(document.body.textContent).toContain("Legacy captures matched by timestamp");
  expect(document.querySelectorAll("select option")).toHaveLength(1);
  expect(client.request).toHaveBeenCalledWith("pi/logs/query",expect.objectContaining({afterAt:entry.at,beforeAt:"2026-09-06T10:01:00.000Z"}));
});
it("opens a log's referenced payload without a message lookup and explains truncation",async()=>{
  client.request.mockResolvedValue({text:'{"incomplete":',truncated:true});
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry:{...entry,detail:undefined,detailRef:{ref:"a".repeat(64),bytes:9e6,preview:"payload"}}}} onClose={()=>{}}/>));
  expect(client.request).toHaveBeenCalledWith("pi/logs/content",{ref:"a".repeat(64),maxBytes:8*1024*1024});
  expect(document.body.textContent).toContain("truncated capture");
});
it("explains summary-only logging without inventing an API body",async()=>{
  const {detail:_,...summary}=entry;
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry:summary}} onClose={()=>{}}/>));
  expect(document.body.textContent).toContain("Request body was not recorded");
  expect(client.request).toHaveBeenCalledWith("pi/prefs/get",{namespace:"request-inspector"});
});
it("restores the machine-level Markdown preference",async()=>{
  client.request.mockResolvedValue({entries:[{namespace:"request-inspector",value:{contentView:"markdown"}}]});
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry}} onClose={()=>{}}/>));
  expect(document.querySelector(".md-body")).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.textContent).toBe("Markdown");
});
