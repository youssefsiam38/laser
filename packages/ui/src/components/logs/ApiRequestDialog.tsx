"use client";
import { useEffect, useMemo, useState } from "react";
import { Braces, Check, Copy, FileText, Info, ListFilter, MessagesSquare, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import type { LogEntry } from "@lasercode/protocol";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/assistant-ui/elements/json-viewer";
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

export type ApiRequestTarget = { kind: "log"; entry: LogEntry } | {
  kind: "message"; path: string; entryId?: string; at?: string; beforeAt?: string;
};
const SECTIONS = [
  { id: "instructions", label: "Instructions", icon: FileText },
  { id: "conversation", label: "Conversation", icon: MessagesSquare },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "parameters", label: "Parameters", icon: ListFilter },
  { id: "json", label: "Full JSON", icon: Braces },
] as const;
type Section = typeof SECTIONS[number]["id"];

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
      const query = { kind:"provider_request",sessionPath:target.path,limit:200 };
      if (target.entryId) {
        const exact = await client.request("pi/logs/query", {...query,promptEntryId:target.entryId});
        if (exact.entries.length) return exact;
      }
      if (!target.at) return {entries:[],hasMore:false};
      const older = await client.request("pi/logs/query", {...query,afterAt:target.at,...(target.beforeAt ? {beforeAt:target.beforeAt} : {})});
      if (live) setLegacy(true);
      return {...older, entries:older.entries.filter(entry=>!entry.requestContext?.promptEntryId)};
    };
    void load().then(page=> {
      if (!live) return;
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
    <DialogContent className="flex h-[85dvh] w-[96vw] max-w-none min-w-0 flex-col gap-0 overflow-hidden p-0 sm:h-[80dvh] sm:w-[80vw] sm:max-w-none">
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
        : entry ? <RequestBody key={`${entry.id}:${refresh}`} entry={entry} />
        : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><FileText className="size-8 text-ink-3" /><h3 className="text-base font-medium">No captured request for this message</h3><p className="max-w-prose text-sm text-ink-2">It may not have reached a provider yet, or its logs were cleared or expired. Older versions did not record message links. Retained requests can also be inspected from Logs.</p></div>}
    </DialogContent>
  </Dialog>;
}

function RequestBody({entry}:{entry:LogEntry}) {
  const {client}=useLaserStable();
  const [payload,setPayload]=useState<unknown>(entry.detail);
  const [loading,setLoading]=useState(Boolean(entry.detailRef));
  const [error,setError]=useState<string>();
  const [truncated,setTruncated]=useState(false);
  const [section,setSection]=useState<Section>("instructions");
  const [search,setSearch]=useState("");
  const {copy,copied}=useCopy();
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
  const filtered=useMemo(()=>fields.filter(field=>`${field.path} ${JSON.stringify(field.value)}`.toLowerCase().includes(search.toLowerCase())),[fields,search]);
  if(loading)return <div className="grid flex-1 place-items-center"><GenerationLoader label="Fetching the complete payload" /></div>;
  if(error)return <p role="alert" className="p-5 text-danger">{error}</p>;
  if(payload===undefined)return <div className="p-6"><h3 className="font-medium">Request body was not recorded</h3><p className="mt-2 text-ink-2">Only the summary is retained. Full payloads may have been disabled when this request ran.</p></div>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
    <aside className="shrink-0 border-b border-line bg-surface-2 p-3 md:w-56 md:overflow-y-auto md:border-e md:border-b-0">
      <nav aria-label="Request sections" className="flex gap-1 overflow-x-auto md:flex-col">
        {SECTIONS.map(({id,label,icon:Icon})=><button key={id} type="button" aria-current={section===id?"page":undefined} onClick={()=>{setSection(id);setSearch("");}}
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
        <h3 className="text-base font-medium">{SECTIONS.find(item=>item.id===section)?.label}</h3>
        <span className="flex-1" />
        {section!=="json"&&<input type="search" aria-label="Filter request fields" placeholder="Search fields…" value={search} onChange={e=>setSearch(e.target.value)} className="order-last w-full min-w-0 rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-live sm:order-none sm:w-auto" />}
        <Button variant="ghost" size="sm" onClick={()=>void copy(JSON.stringify(payload,null,2))}>{copied?<Check/>:<Copy/>}{copied?"Copied":"Copy JSON"}</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {truncated&&<p role="alert" className="mb-3 text-sm text-attention">Payload exceeds the 8 MB inspection limit. This is a truncated capture; structured sections may be unavailable.</p>}
        {section==="json"?<JsonViewer value={payload} className="max-h-none" expandedDepth={2}/>
          : filtered.length ? <div className="flex flex-col gap-3">{filtered.map(field=><RequestFieldCard key={`${entry.id}:${field.path}`} field={field} expanded={section==="instructions"}/>)}</div>
          : <p className="py-8 text-center text-sm text-ink-3">{search?"No fields match this search.":"No fields recorded in this section. Provider-specific fields remain in Parameters and Full JSON."}</p>}
      </div>
      <p className="shrink-0 border-t border-line px-4 py-2 text-xs text-ink-3">Captured at the engine's pre-request hook, not a network trace. Later extension rewrites or transport-added headers are not represented. A message may trigger several calls and retries.</p>
    </div>
  </div>;
}

function RequestFieldCard({field,expanded}:{field:RequestField;expanded:boolean}) {
  const text=requestFieldText(field.value);
  const preview = text ?? (field.value === null || typeof field.value === "number" || typeof field.value === "boolean" ? JSON.stringify(field.value) : undefined);
  return <Collapsible defaultOpen={expanded} className={cn(activityRow,"border border-line")}>
    <CollapsibleTrigger className={cn(activityTrigger,"py-2")}>
      <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
      <span className="min-w-0 truncate font-medium">{requestFieldLabel(field)}</span>
      {preview !== undefined && <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{preview}</span>}
      <code className="ms-auto min-w-0 truncate text-xs text-ink-3">{field.path}</code>
    </CollapsibleTrigger>
    <CollapsibleContent className={collapsePanel}>
      <div className="flex min-w-0 flex-col gap-3 border-t border-line p-3">
        {text!==undefined&&<p className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-ink">{text}</p>}
        {typeof field.value!=="string"&&<JsonViewer value={field.value} expandedDepth={1} className="max-h-none"/>}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}
