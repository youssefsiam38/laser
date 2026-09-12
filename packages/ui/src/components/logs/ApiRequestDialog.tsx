"use client";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Braces, Check, Copy, FileText, Info, ListFilter, MessagesSquare, RefreshCw, Search, ShieldCheck, Wrench } from "lucide-react";
import type { InstructionSourceMap, InstructionSourceSpan, LogEntry } from "@lasercode/protocol";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/assistant-ui/elements/json-viewer";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { SpecSheet } from "@/components/assistant-ui/elements/spec-sheet";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { activityRow, activityTrigger, collapsePanel } from "@/components/assistant-ui/elements/surfaces";
import { useCopy } from "@/hooks";
import { dateTime } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { inspectRequest, requestFieldLabel, requestFieldText, type RequestField } from "./request-model.js";
import { ConversationSearch } from "@/components/assistant-ui/elements/conversation-search";
import { SyntaxHighlighter } from "@/components/assistant-ui/elements/shiki-highlighter";
import { useRequestFind } from "./use-request-find.js";
import { ConfidenceMarker } from "@/components/assistant-ui/elements/confidence-marker";
import { FileLinkDirectory } from "@/components/ui/source-file-link";
import { requestSourceSpans } from "./request-sources.js";

export type ApiRequestTarget = { kind: "log"; entry: LogEntry } | {
  kind: "message"; path: string; entryId?: string; at?: string; beforeAt?: string;
};
type MessageRequestTarget = Extract<ApiRequestTarget, { kind: "message" }>;
type RequestPage = { entries: LogEntry[]; hasMore: boolean; legacy?: boolean };
const SECTIONS = [
  { id: "instructions", label: "Instructions", icon: FileText },
  { id: "conversation", label: "Conversation", icon: MessagesSquare },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "parameters", label: "Parameters", icon: ListFilter },
  { id: "json", label: "Full JSON", icon: Braces },
] as const;
type Section = typeof SECTIONS[number]["id"];
type ContentView = "plain" | "markdown";
const REQUEST_INSPECTOR_PREFS = "request-inspector";

/** Both entry points mount this same inspector; nothing sends a model request. */
export function ApiRequestDialog({ target, onClose }: { target: ApiRequestTarget; onClose: () => void }) {
  const { client } = useLaserStable();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [legacy, setLegacy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const targetKey = target.kind === "log" ? `log:${target.entry.id}` : `message:${target.path}:${target.entryId}:${target.at}:${target.beforeAt}`;
  useEffect(() => {
    let live = true;
    setLoading(true); setError(undefined); setLegacy(false); setMore(false);
    const load = async () => {
      if (target.kind === "log") return { entries:[target.entry],hasMore:false };
      return loadMessageRequests(client, target);
    };
    void load().then(page=> {
      if (!live) return;
      setLegacy(Boolean(page.legacy));
      setEntries(page.entries); setMore(page.hasMore);
      setSelected(current=>page.entries.some(entry=>entry.id===current)?current:page.entries[0]?.id);
    }).catch(()=>{if(live)setError("Could not load the captured requests. Check the host connection and try again.");})
      .finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;};
    // Target identity is stable even when its parent's live state rerenders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[client,targetKey,refresh]);
  const entry = entries.find(item=>item.id===selected);
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent dir="ltr" onEscapeKeyDown={e=>{
      const modal=e.target instanceof Element?e.target.closest('[role="dialog"]'):null;
      const closeFind=modal?.querySelector<HTMLButtonElement>('[data-request-find] [aria-label="Close search"]');
      if(closeFind){e.preventDefault();closeFind.click();}
    }} className="flex h-[85dvh] w-[96vw] max-w-none min-w-0 flex-col gap-0 overflow-hidden p-0 sm:h-[80dvh] sm:w-[80vw] sm:max-w-none">
      <DialogHeader className="shrink-0 border-b border-line p-5 pe-14">
        <DialogTitle className="flex items-center gap-2"><Braces className="size-5 text-live" />API request</DialogTitle>
        <DialogDescription>Inspect what the engine prepared for the provider: instructions, context, tools and settings.</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-5 py-2">
        <label className="min-w-0 flex-1 text-xs text-ink-2">Captured request
          <select aria-label="Captured request" value={selected ?? ""} onChange={e=>setSelected(Number(e.target.value))} disabled={!entries.length}
            className="ms-2 max-w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink">
            {!entries.length && <option value="">No capture</option>}
            {entries.map((row,index)=><option key={row.id} value={row.id}>{index+1} / {entries.length} · {dateTime(row.at)} · {row.requestContext?.model ?? row.summary}</option>)}
          </select>
        </label>
        <Button variant="ghost" size="sm" disabled={loading} onClick={()=>setRefresh(n=>n+1)} aria-label="Refresh captured requests"><RefreshCw className={cn(loading && "motion-safe:animate-busy")} />Refresh</Button>
      </div>
      {legacy && entries.length>0 && <p className="flex shrink-0 items-start gap-2 border-b border-line px-5 py-2 text-xs text-attention"><Info className="size-4 shrink-0" />Legacy captures matched by timestamp, not a recorded message link. These are requests between this message and the next; attribution may be incomplete.</p>}
      {more && <p className="px-5 py-2 text-xs text-attention">Showing the latest retained page. More requests are available in Logs.</p>}
      {loading ? <div className="grid flex-1 place-items-center"><GenerationLoader label="Loading captured requests" /></div>
        : error ? <div role="alert" className="p-5 text-danger">{error}</div>
        : entry ? <FileLinkDirectory.Provider value={entry.cwd}><RequestBody key={`${entry.id}:${refresh}`} entry={entry} /></FileLinkDirectory.Provider>
        : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><FileText className="size-8 text-ink-3" /><h3 className="text-base font-medium">No captured request for this message</h3><p className="max-w-prose text-sm text-ink-2">It may not have reached a provider yet, or its logs were cleared or expired. Older versions did not record message links. Retained requests can also be inspected from Logs.</p></div>}
    </DialogContent>
  </Dialog>;
}

/** Prefer branch-exact attribution; timestamp matching covers older captures. */
async function loadMessageRequests(
  client: ReturnType<typeof useLaserStable>["client"],
  target: MessageRequestTarget,
): Promise<RequestPage> {
  const query = { kind: "provider_request", sessionPath: target.path, limit: 200 } as const;
  if (target.entryId) {
    const exact = await client.request("pi/logs/query", { ...query, promptEntryId: target.entryId });
    if (exact.entries.length) return exact;
  }
  if (!target.at) return { entries: [], hasMore: false };
  const window = await client.request("pi/logs/query", {
    ...query,
    afterAt: target.at,
    ...(target.beforeAt ? { beforeAt: target.beforeAt } : {}),
  });
  return {
    ...window,
    legacy: true,
    entries: window.entries.filter((entry) => !entry.requestContext?.promptEntryId),
  };
}

function RequestBody({entry}:{entry:LogEntry}) {
  const {client}=useLaserStable();
  const [payload,setPayload]=useState<unknown>(entry.detail);
  const [loading,setLoading]=useState(Boolean(entry.detailRef));
  const [error,setError]=useState<string>();
  const [truncated,setTruncated]=useState(false);
  const [section,setSection]=useState<Section>("instructions");
  const [search,setSearch]=useState("");
  const [searchOpen,setSearchOpen]=useState(true);
  const [scope,setScope]=useState<"section"|"request">("section");
  const [contentView,setContentView]=useState<ContentView>("plain");
  const {copy,copied}=useCopy();
  useEffect(()=>{
    let live=true;
    const adopt=(value:unknown)=>{
      if(!live||!value||typeof value!=="object")return;
      const mode=(value as {contentView?:unknown}).contentView;
      if(mode==="plain"||mode==="markdown")setContentView(mode);
    };
    void Promise.resolve(client.request("pi/prefs/get",{namespace:REQUEST_INSPECTOR_PREFS})).then(result=>adopt(result?.entries[0]?.value)).catch(()=>{});
    const unsubscribe=client.subscribe((method,params)=>{
      if(method!=="pi/prefs/updated")return;
      const entry=params as {namespace?:string;value?:unknown};
      if(entry.namespace!==REQUEST_INSPECTOR_PREFS)return;
      adopt(entry.value);
    });
    return()=>{live=false;unsubscribe();};
  },[client]);
  const chooseContentView=(mode:ContentView)=>{
    setContentView(mode);
    void client.request("pi/prefs/set",{namespace:REQUEST_INSPECTOR_PREFS,value:{contentView:mode}}).catch(()=>{});
  };
  useEffect(()=>{
    if(!entry.detailRef)return;
    let live=true;
    void client.request("pi/logs/content",{ref:entry.detailRef.ref,maxBytes:8*1024*1024}).then(result=>{
      if(!live)return;
      setTruncated(result.truncated);
      try { setPayload(JSON.parse(result.text)); } catch {setPayload(result.text);}
    }).catch(()=>{if(live)setError("This payload could not be loaded. It may have expired under log retention.");})
      .finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;};
  },[client,entry]);
  const view=useMemo(()=>inspectRequest(payload),[payload]);
  const fields=section==="json"?[]:view[section];
  const query=searchOpen?search:"";
  const searching=Boolean(query.trim());
  const fullSearch=scope==="request";
  const find=useRequestFind(query,`${section}:${scope}:${contentView}:${loading}`);
  const sectionLabel=SECTIONS.find(item=>item.id===section)!.label;
  const closeSearch=()=>{
    setSearch("");setSearchOpen(false);
    requestAnimationFrame(()=>find.viewport.current?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[aria-label="Search request"]')?.focus({preventScroll:true}));
  };
  useEffect(()=>{
    const modal=find.viewport.current?.closest('[role="dialog"]');
    if(!modal)return;
    const key=(e:KeyboardEvent)=>{
      if(!modal.contains(e.target as Node)||!(e.ctrlKey||e.metaKey)||e.altKey||e.key.toLowerCase()!=="f")return;
      e.preventDefault();e.stopPropagation();setScope(e.shiftKey?"request":"section");setSearchOpen(true);
      requestAnimationFrame(()=>{find.input.current?.focus();find.input.current?.select();});
    };
    document.addEventListener("keydown",key,true);
    return()=>document.removeEventListener("keydown",key,true);
  },[find.input,find.viewport,loading]);
  if(loading)return <div className="grid flex-1 place-items-center"><GenerationLoader label="Fetching the complete payload" /></div>;
  if(error)return <p role="alert" className="p-5 text-danger">{error}</p>;
  if(payload===undefined)return <div className="p-6"><h3 className="font-medium">Request body was not recorded</h3><p className="mt-2 text-ink-2">Only the summary is retained. Full payloads may have been disabled when this request ran.</p></div>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
    <aside className="shrink-0 border-b border-line bg-surface-2 p-3 md:w-56 md:overflow-y-auto md:border-e md:border-b-0">
      <nav aria-label="Request sections" className="flex gap-1 overflow-x-auto md:flex-col">
        {SECTIONS.map(({id,label,icon:Icon})=><button key={id} type="button" aria-current={section===id?"page":undefined} onClick={()=>{setSection(id);setScope("section");}}
          className={cn("flex shrink-0 pointer-coarse:min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-live",section===id?"bg-surface text-ink":"text-ink-2 hover:bg-surface")}>
          <Icon className="size-4 shrink-0" />{label}{id!=="json"&&<span className="ms-auto ps-2 font-mono text-xs text-ink-3">{view[id].length}</span>}
        </button>)}
      </nav>
      <SpecSheet bare className="mt-5 hidden md:flex" rows={[
        {label:"provider",value:entry.requestContext?.provider ?? "Not recorded"},
        {label:"model",value:entry.requestContext?.model ?? view.model ?? "Not recorded",typed:true},
        {label:"API",value:entry.requestContext?.api ?? "Not recorded",typed:true},
        {label:"capture",value:`#${entry.id}`,typed:true},
      ]} />
      <p className="mt-4 hidden items-start gap-2 text-xs leading-relaxed text-ink-3 md:flex"><ShieldCheck className="size-4 shrink-0" />Credential fields are redacted. Conversation content may still be sensitive.</p>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h3 className="text-base font-medium">{fullSearch?"Full request":sectionLabel}</h3>
        <span className="flex-1" />
        {!fullSearch&&(section==="instructions"||section==="conversation")&&<div role="group" aria-label="Content view" className="flex rounded-md border border-line bg-surface-2 p-0.5">
          {(["plain","markdown"] as const).map(mode=><button key={mode} type="button" aria-pressed={contentView===mode} onClick={()=>chooseContentView(mode)}
            className={cn("rounded px-2 py-1 text-xs font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-live",contentView===mode&&"bg-surface text-ink shadow-sm")}>{mode==="plain"?"Plain":"Markdown"}</button>)}
        </div>}
        {!searchOpen&&<Button variant="ghost" size="sm" aria-label="Search request" onClick={()=>{setSearchOpen(true);requestAnimationFrame(()=>find.input.current?.focus());}}><Search/>Search</Button>}
        <Button variant="ghost" size="sm" onClick={()=>void copy(JSON.stringify(payload,null,2))}>{copied?<Check/>:<Copy/>}{copied?"Copied":"Copy JSON"}</Button>
      </header>
      {searchOpen&&<ConversationSearch data-request-find label={scope==="request"?"Find in full request":`Find in ${sectionLabel.toLowerCase()}`} inputRef={find.input} query={search} hits={find.matches} activeIndex={find.activeIndex} onQueryChange={setSearch} onStep={find.step} onClose={closeSearch}
        toolbar={<div role="group" aria-label="Request search scope" className="flex items-center gap-1 border-b border-line px-2 py-1">
          {(["section","request"] as const).map(value=><button key={value} type="button" aria-pressed={scope===value} onClick={()=>setScope(value)} className={cn("min-w-0 rounded-md px-2 py-1 text-xs font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-live",scope===value&&"bg-surface-2 text-ink")}>
            {value==="section"?sectionLabel:"Full request"}
          </button>)}
          <span className="ms-auto hidden text-xs text-ink-3 sm:inline">{scope==="request"?"All keys and values":"This section"}</span>
        </div>}/>}
      <div ref={find.viewport} data-slot="request-viewport" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {truncated&&<p role="alert" className="mb-3 text-sm text-attention">Payload exceeds the 8 MB inspection limit. This is a truncated capture; structured sections may be unavailable.</p>}
        {/* Full search indexes the payload ONCE, never a concatenation of tabs.
            Section cards index their main text, not previews or duplicate JSON. */}
        {fullSearch||section==="json"?<RequestJson value={payload} search={searching} literalText={truncated&&typeof payload==="string"?payload:undefined}/>
          : fields.length ? <div className="flex flex-col gap-3">{fields.map(field=><RequestFieldCard key={`${entry.id}:${field.path}`} field={field} expanded={section==="instructions"} reveal={searching} markdown={(section==="instructions"||section==="conversation")&&contentView==="markdown"} sources={section==="instructions"?entry.requestContext?.instructionSources:undefined}/>)}</div>
          : <p className="py-8 text-center text-sm text-ink-3">No fields recorded in this section. Provider-specific fields remain in Parameters and Full JSON.</p>}
      </div>
      <p className="shrink-0 border-t border-line px-4 py-2 text-xs text-ink-3">Captured at the engine's pre-request hook, not a network trace.{entry.requestContext?.instructionSources ? " Includes registered extension rewrites; transport-added headers are not represented." : " Instruction sources were not recorded for this capture."} A message may trigger several calls and retries.</p>
    </div>
  </div>;
}

function RequestFieldCard({field,expanded,markdown,reveal,sources}:{field:RequestField;expanded:boolean;markdown:boolean;reveal:boolean;sources?:InstructionSourceMap[]|undefined}) {
  const [open,setOpen]=useState(expanded);
  const text=requestFieldText(field.value);
  const [spans,setSpans]=useState<InstructionSourceSpan[]>();
  useEffect(()=>{
    let live=true;
    setSpans(undefined);
    if(sources)void requestSourceSpans(field,sources).then(value=>{if(live)setSpans(value);}).catch(()=>{
      if(live&&text)setSpans([{start:0,end:text.length,source:{kind:"unrecorded",label:"Source verification unavailable on this connection"}}]);
    });
    return()=>{live=false;};
  },[field,sources,text]);
  const markdownBody=text!==undefined&&<TextMessagePartProvider text={text} isRunning={false}><MarkdownText dir="ltr" /></TextMessagePartProvider>;
  const preview = text ?? (field.value === null || typeof field.value === "number" || typeof field.value === "boolean" ? JSON.stringify(field.value) : undefined);
  return <Collapsible open={reveal||open} onOpenChange={setOpen} className={cn(activityRow,"border border-line")}>
    <CollapsibleTrigger className={cn(activityTrigger,"py-2")}>
      <ChevronRight className="rtl:-scale-x-100 size-4 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90 group-data-[state=open]/trigger:rtl:-rotate-90" />
      <span className="min-w-0 truncate font-medium">{requestFieldLabel(field)}</span>
      {preview !== undefined && <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{preview}</span>}
      <code dir="ltr" className="ms-auto min-w-0 truncate text-xs text-ink-3">{field.path}</code>
    </CollapsibleTrigger>
    <CollapsibleContent className={collapsePanel}>
      <div className="flex min-w-0 flex-col gap-3 border-t border-line p-3">
        {text!==undefined&&(spans?.length ? <ConfidenceMarker claims={spans.map((span,i)=>({id:String(i),text:text.slice(span.start,span.end),source:span.source}))}>{markdown?markdownBody:undefined}</ConfidenceMarker>
          :<div data-request-search-content>{markdown?markdownBody:<p className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-ink">{text}</p>}</div>)}
        {typeof field.value!=="string"&&<RequestJson value={field.value} search={reveal&&text===undefined} />}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

/** Find exposes the exact retained JSON, including structural keys and syntax.
 * Keep the foldable viewer mounted so clearing find restores its disclosure. */
function RequestJson({value,search,literalText}:{value:unknown;search:boolean;literalText?:string|undefined}) {
  const code=useMemo(()=>literalText??JSON.stringify(value,null,2)??"",[value,literalText]);
  return <>
    <div hidden={search}><JsonViewer value={value} expandedDepth={2} className="max-h-none"/></div>
    {search&&<div data-request-search-content><SyntaxHighlighter code={code} language="json" streaming={code.length>200_000} className="[&>pre]:whitespace-pre-wrap! [&>pre]:wrap-break-word! [&>pre]:overflow-x-hidden!"/></div>}
  </>;
}
