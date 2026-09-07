// @vitest-environment happy-dom
import { act } from "react";
import { createHash, webcrypto } from "node:crypto";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogEntry } from "@lasercode/protocol";
import { ApiRequestDialog as Inspector } from "../../src/components/logs/ApiRequestDialog.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { ComponentProps } from "react";
function ApiRequestDialog(props: ComponentProps<typeof Inspector>) { return <TooltipProvider><Inspector {...props}/></TooltipProvider>; }

const client=vi.hoisted(()=>({request:vi.fn(),subscribe:vi.fn(()=>()=>{})}));
vi.mock("@/runtime",()=>({useLaserStable:()=>({client})}));
let container:HTMLDivElement;
let root:Root;
const entry:LogEntry={id:1,at:"2026-09-06T10:00:00.000Z",section:"provider",kind:"provider_request",level:"info",summary:"test-model",sessionPath:"/session",
  requestContext:{promptEntryId:"user-1",provider:"openai",model:"test-model"},
  detail:{instructions:"Unique system instructions",tools:[{name:"read",parameters:{type:"object"}}],input:[{role:"user",content:"hello"}],temperature:0.2}};
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;client.request.mockReset();client.request.mockResolvedValue({entries:[]});client.subscribe.mockClear();container=document.createElement("div");document.body.append(container);root=createRoot(container);
  vi.stubGlobal("CSS",{...CSS,highlights:new Map()});vi.stubGlobal("Highlight",class extends Set<Range>{constructor(...ranges:Range[]){super(ranges);}});
  vi.spyOn(Range.prototype,"getBoundingClientRect").mockReturnValue(new DOMRect(0,0,10,10));
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
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

it("shows source markers with keyboard/touch details without duplicating instruction search or changing Markdown",async()=>{
  vi.stubGlobal("crypto",webcrypto);
  const instructions="Project **quartz** rule.";
  const source={kind:"file" as const,label:"AGENTS.md",path:"/project/AGENTS.md"};
  const captured={...entry,detail:{instructions},requestContext:{...entry.requestContext,instructionSources:[{path:["instructions"],sha256:createHash("sha256").update(instructions).digest("hex"),spans:[{start:0,end:instructions.length,source}]}]}};
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry:captured}} onClose={()=>{}}/>));
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  expect(document.querySelector('[data-slot="confidence-marker"]')).not.toBeNull();
  expect(document.querySelector('[data-request-search-content]')?.textContent).toBe(instructions);
  const sourceButton=document.querySelector<HTMLButtonElement>('[aria-label="Recorded instruction sources"] button')!;
  await act(async()=>{sourceButton.focus();sourceButton.click();});
  expect(document.querySelector('[data-slot="popover-content"]')?.textContent).toContain("/project/AGENTS.md");
  expect(document.querySelector('[data-slot="popover-content"]')?.closest('[data-slot="dialog-content"]')).not.toBeNull();
  expect(document.querySelector('[data-request-source-text]')?.hasAttribute("title")).toBe(false);
  await act(async()=>sourceButton.click());
  await search("quartz");expect(count()).toBe("1 / 1");
  await search("AGENTS.md");expect(count()).toBe("No matches");
  await click("Markdown");expect(document.querySelector(".md-body strong")?.textContent).toBe("quartz");
  await search("quartz");expect(count()).toBe("1 / 1");
  await click("Full request");expect(count()).toBe("1 / 1");
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
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Content view"] button[aria-pressed="true"]')?.textContent).toBe("Markdown");
});

async function search(value:string) {
  await act(async()=>{
    const input=document.querySelector<HTMLInputElement>('[role="search"] input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
}
const count=()=>document.querySelector('[role="search"] [role="status"]')?.textContent;
const highlighted=()=>[...(CSS.highlights.get("request-matches")??[])].map((range:Range)=>range.toString());
it("highlights instructions in place, preserves focus, wraps matches and clears search before closing the modal",async()=>{
  const close=vi.fn();
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry:{...entry,detail:{instructions:"A needle here. Another needle there."}}}} onClose={close}/>));
  const input=document.querySelector<HTMLInputElement>('[role="search"] input')!;input.focus();
  await search("needle");expect(document.activeElement).toBe(input);expect(count()).toBe("1 / 2");expect(highlighted()).toEqual(["needle","needle"]);
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",shiftKey:true,bubbles:true,cancelable:true})));
  expect(count()).toBe("2 / 2");
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})));
  expect(count()).toBe("1 / 2");
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(close).not.toHaveBeenCalled();expect(document.querySelector('[role="search"]')).toBeNull();expect(CSS.highlights.has("request-matches")).toBe(false);
});
it("searches all retained JSON keys, values and syntax without filtering cards or changing Markdown preferences",async()=>{
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry}} onClose={()=>{}}/>));
  await search("parameters");expect(count()).toBe("No matches");
  expect(document.body.textContent).toContain("Unique system instructions");
  await click("Full request");expect(count()).toBe("1 / 1");expect(highlighted()).toEqual(["parameters"]);
  await search('"type": "object"');expect(count()).toBe("1 / 1");expect(highlighted()).toEqual(['"type": "object"']);
  await search("hello");expect(count()).toBe("1 / 1");
  expect(client.request.mock.calls.some(([method])=>method==="pi/prefs/set")).toBe(false);
});
it("finds across Markdown spans and scopes keyboard shortcuts to the request inspector",async()=>{
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry:{...entry,detail:{instructions:"An Ap**ple** instruction",other:{Apple:"outside"}}}}} onClose={()=>{}}/>));
  await click("Markdown");await search("Apple");expect(count()).toBe("1 / 1");expect(highlighted()).toEqual(["Apple"]);
  const input=document.querySelector<HTMLInputElement>('[role="search"] input')!;
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"f",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})));
  expect(document.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe("Find in full request");
  expect(highlighted()).toEqual(["Apple"]); // raw Markdown spelling does not contain Apple
  await act(async()=>input.dispatchEvent(new KeyboardEvent("keydown",{key:"f",ctrlKey:true,bubbles:true,cancelable:true})));
  expect(document.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe("Find in instructions");
  expect(document.querySelector(".md-body")).not.toBeNull();expect(highlighted()).toEqual(["Apple"]);
});
it("reveals a folded conversation match only for find, without counting its JSON duplicate",async()=>{
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry}} onClose={()=>{}}/>));
  await click("Conversation");
  const card=document.querySelector('[data-slot="request-viewport"] [data-slot="collapsible"]')!;
  expect(card.getAttribute("data-state")).toBe("closed");
  await search("hello");expect(count()).toBe("1 / 1");expect(highlighted()).toEqual(["hello"]);expect(card.getAttribute("data-state")).toBe("open");
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-request-find] [aria-label="Close search"]')!.click());
  expect(card.getAttribute("data-state")).toBe("closed");expect(CSS.highlights.has("request-matches")).toBe(false);
});
it("counts payload occurrences once across Instructions, Full request and Full JSON views",async()=>{
  const detail={instructions:"quartz",input:[{role:"user",content:"quartz"}]};
  await act(async()=>root.render(<ApiRequestDialog target={{kind:"log",entry:{...entry,detail}}} onClose={()=>{}}/>));
  await search("quartz");expect(count()).toBe("1 / 1");expect(highlighted()).toHaveLength(1);
  await click("Full request");expect(count()).toBe("1 / 2");expect(highlighted()).toHaveLength(2);
  const section=async(name:string)=>act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Request sections"] button')].find(b=>b.textContent?.startsWith(name))!.click());
  await section("Full JSON");expect(count()).toBe("1 / 2");expect(highlighted()).toHaveLength(2);
  await section("Conversation");expect(count()).toBe("1 / 1");expect(highlighted()).toHaveLength(1);
  await section("Instructions");expect(count()).toBe("1 / 1");expect(highlighted()).toHaveLength(1);
});
