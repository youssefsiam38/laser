"use client";
/**
 * The API request inspector itself, loaded when a person opens one (M16-T31).
 *
 * `ApiRequestDialog.tsx` owns the dialog, its title and the capture picker;
 * everything below — the request model, the provenance marker, the JSON viewer
 * and the find bar — arrives with this module and fills the open dialog in.
 */
import { TextMessagePartProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";
import { Braces, Check, Copy, FileText, Info, ListFilter, MessagesSquare, Search, ShieldCheck, Wrench } from "lucide-react";
import type { InstructionSourceMap, InstructionSourceSpan, LogBodySummary, LogEntry } from "@lasercode/protocol";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/assistant-ui/elements/json-viewer";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { SpecSheet } from "@/components/assistant-ui/elements/spec-sheet";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { activityRow, activityTrigger, collapsePanel } from "@/components/assistant-ui/elements/surfaces";
import { formatBytes } from "@/format";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { ApiRequestCaptureBar, ApiRequestLoading } from "./api-request-frame.js";
import { adoptCaptures, NO_SHOWN_CAPTURES } from "./captures.js";
import { inspectRequest, requestFieldLabel, requestFieldText, type RequestField } from "./request-model.js";
import { ConversationSearch } from "@/components/assistant-ui/elements/conversation-search";
import { SyntaxHighlighter } from "@/components/assistant-ui/elements/shiki-highlighter";
import { useRequestFind } from "./use-request-find.js";
import { ConfidenceMarker } from "@/components/assistant-ui/elements/confidence-marker";
import { FileLinkDirectory } from "@/components/ui/source-file-link";
import { requestSourceSpans } from "./request-sources.js";
import { createRequestJsonText } from "./request-json-text.js";
import { ReleasedBody } from "./ReleasedBody.js";

import type { ApiRequestTarget } from "./ApiRequestDialog.js";

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
export function ApiRequestDialogBody({ target: opened }: { target: ApiRequestTarget }) {
  const { client } = useLaserStable();
  // The inspector answers for the request a person opened it on. In the
  // transcript its parent is a live row: `at`, `beforeAt` and `entryId` all
  // move while a turn streams — a later prompt closes the window, and the
  // settled turn's entries are re-read — and none of that is somebody asking
  // for a different capture. So the target is resolved once, when the dialog
  // opens, and kept for its lifetime; opening the inspector on another
  // message mounts another inspector, with that message's target (M16-T35).
  const [target] = useState(opened);
  const [shown, setShown] = useState(NO_SHOWN_CAPTURES);
  const [loading, setLoading] = useState(true);
  const [legacy, setLegacy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(undefined);
    const load = async (): Promise<RequestPage> => {
      if (target.kind === "log") return { entries:[target.entry],hasMore:false };
      return loadMessageRequests(client, target);
    };
    void load().then(page=> {
      if (!live) return;
      // Additive: a re-read offers what it found without taking away the
      // capture on screen, so Refresh fills the picker, it does not reset it.
      setLegacy(Boolean(page.legacy));
      setMore(page.hasMore);
      setShown(current=>adoptCaptures(current,page.entries));
    }).catch(()=>{if(live)setError("Could not load the captured requests. Check the host connection and try again.");})
      .finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;};
  },[client,target,refresh]);
  const entry = shown.entries.find(item=>item.id===shown.selected);
  const captures=useMemo(()=>shown.entries.map(row=>({id:row.id,at:row.at,label:row.requestContext?.model ?? row.summary})),[shown.entries]);
  return <>
    <ApiRequestCaptureBar captures={captures} selected={shown.selected} onSelect={id=>setShown(current=>({...current,selected:id}))} loading={loading} onRefresh={()=>setRefresh(n=>n+1)} />
    {legacy && shown.entries.length>0 && <p className="flex shrink-0 items-start gap-2 border-b border-line px-5 py-2 text-xs text-attention"><Info className="size-4 shrink-0" />Legacy captures matched by timestamp, not a recorded message link. These are requests between this message and the next; attribution may be incomplete.</p>}
    {more && <p className="px-5 py-2 text-xs text-attention">Showing the latest retained page. More requests are available in Logs.</p>}
    {/* A failed re-read is a line above the capture, not the loss of it. */}
    {error && entry && <p role="alert" className="flex shrink-0 items-start gap-2 border-b border-line px-5 py-2 text-xs text-danger"><Info className="size-4 shrink-0" />{error}</p>}
    {entry ? <FileLinkDirectory.Provider value={entry.cwd}><RequestBody key={entry.id} entry={entry} /></FileLinkDirectory.Provider>
      : loading ? <ApiRequestLoading label="Loading captured requests" />
      : error ? <div role="alert" className="p-5 text-danger">{error}</div>
      : <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><FileText className="size-8 text-ink-3" /><h3 className="text-base font-medium">No captured request for this message</h3><p className="max-w-prose text-sm text-ink-2">It may not have reached a provider yet, or its logs were cleared or expired. Older versions did not record message links. Retained requests can also be inspected from Logs.</p></div>}
  </>;
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
  // The store keeps recent bodies in full and reduces older ones to a summary
  // (D-245). That is an answer, not a failure, so it has its own state.
  const [released,setReleased]=useState<LogBodySummary>();
  const [truncated,setTruncated]=useState(false);
  /** Stored size, shown bytes and fingerprint, when only part of a body is here (RP-7). */
  const [cut,setCut]=useState<{stored:number;shown:number;sha256:string}>();
  const [section,setSection]=useState<Section>("instructions");
  const [search,setSearch]=useState("");
  // Closed until asked for: the page is for reading the request, the find bar is a tool.
  const [searchOpen,setSearchOpen]=useState(false);
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
  // A payload is content-addressed, and a capture's id names one request: a
  // second read of the same row is the same bytes, never a second fetch.
  const detailRef=entry.detailRef?.ref;
  useEffect(()=>{
    if(!detailRef)return;
    let live=true;
    void client.request("pi/logs/content",{ref:detailRef,maxBytes:8*1024*1024}).then(result=>{
      if(!live)return;
      setReleased(result.released);
      if(result.released)return;
      setTruncated(result.truncated);
      setCut(result.truncated?{stored:result.bytes,shown:result.truncatedAt??result.text.length,sha256:detailRef}:undefined);
      try { setPayload(JSON.parse(result.text)); } catch {setPayload(result.text);}
    }).catch(()=>{if(live)setError("This payload could not be loaded. It may have expired under log retention.");})
      .finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;};
  },[client,entry.id,detailRef]);
  const view=useMemo(()=>inspectRequest(payload),[payload]);
  const jsonText=useMemo(()=>createRequestJsonText(payload),[payload]);
  const fields=section==="json"?[]:view[section];
  const query=searchOpen?search:"";
  const searching=Boolean(query.trim());
  const fullSearch=scope==="request";
  const find=useRequestFind(query,`${section}:${scope}:${contentView}:${loading}`);
  const sectionLabel=SECTIONS.find(item=>item.id===section)!.label;
  const closeSearch=()=>{
    // Escape from the find input while the source panel is open closes the
    // panel first — the same order the dialog keeps for Escape anywhere else.
    const closeSources=find.viewport.current?.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[data-close-source-panel]');
    if(closeSources){closeSources.click();return;}
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
  if(released)return <div className="min-h-0 flex-1 overflow-y-auto"><ReleasedBody summary={released} /></div>;
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
        <Button variant="ghost" size="sm" onClick={()=>void copy(jsonText())}>{copied?<Check/>:<Copy/>}{copied?"Copied":"Copy JSON"}</Button>
      </header>
      {searchOpen&&<ConversationSearch data-request-find label={scope==="request"?"Find in full request":`Find in ${sectionLabel.toLowerCase()}`} inputRef={find.input} query={search} hits={find.matches} activeIndex={find.activeIndex} onQueryChange={setSearch} onStep={find.step} onClose={closeSearch}
        toolbar={<div role="group" aria-label="Request search scope" className="flex items-center gap-1 border-b border-line px-2 py-1">
          {(["section","request"] as const).map(value=><button key={value} type="button" aria-pressed={scope===value} onClick={()=>setScope(value)} className={cn("min-w-0 rounded-md px-2 py-1 text-xs font-medium text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-live",scope===value&&"bg-surface-2 text-ink")}>
            {value==="section"?sectionLabel:"Full request"}
          </button>)}
          <span className="ms-auto hidden text-xs text-ink-3 sm:inline">{scope==="request"?"All keys and values":"This section"}</span>
        </div>}/>}
      <div ref={find.viewport} data-slot="request-viewport" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {truncated&&<p role="alert" data-slot="request-truncated" className="mb-3 text-sm text-attention">
          Showing the first {(cut?.shown??0).toLocaleString()} bytes ({formatBytes(cut?.shown??0)}) of
          a {(cut?.stored??0).toLocaleString()}-byte ({formatBytes(cut?.stored??0)}) request.
          {cut?<> Fingerprint <span className="typed wrap-break-word">{cut.sha256}</span>.</>:null} The rest is stored and is not on this
          page, so structured sections and search cover only what is shown here. Sizes describe the redacted copy this app keeps.
        </p>}
        {/* Full search indexes the payload ONCE, never a concatenation of tabs.
            Section cards index their main text, not previews or duplicate JSON. */}
        {fullSearch||section==="json"?<RequestJson value={payload} search={searching} getText={jsonText} literalText={truncated&&typeof payload==="string"?payload:undefined}/>
          : fields.length ? <div className="flex flex-col gap-3">{fields.map(field=><RequestFieldCard key={`${entry.id}:${field.path}`} field={field} expanded={section==="instructions"} reveal={searching} markdown={(section==="instructions"||section==="conversation")&&contentView==="markdown"} sources={section==="instructions"?entry.requestContext?.instructionSources ?? EMPTY_SOURCES:undefined}/>)}</div>
          : <p className="py-8 text-center text-sm text-ink-3">No fields recorded in this section. Provider-specific fields remain in Parameters and Full JSON.</p>}
      </div>
      <p className="shrink-0 border-t border-line px-4 py-2 text-xs text-ink-3">Captured at the engine's pre-request hook, not a network trace.{entry.requestContext?.instructionSources ? " Includes registered extension rewrites; transport-added headers are not represented." : " Instruction sources were not recorded for this capture."} A message may trigger several calls and retries.</p>
    </div>
  </div>;
}

const EMPTY_SOURCES: InstructionSourceMap[] = [];

function RequestFieldCard({field,expanded,markdown,reveal,sources}:{field:RequestField;expanded:boolean;markdown:boolean;reveal:boolean;sources?:InstructionSourceMap[]|undefined}) {
  const [open,setOpen]=useState(expanded);
  const text=useMemo(()=>requestFieldText(field.value),[field.value]);
  const [spans,setSpans]=useState<InstructionSourceSpan[]>();
  useEffect(()=>{
    let live=true;
    setSpans(undefined);
    if(sources) void requestSourceSpans(field,sources).then(value=>{if(live)setSpans(value);}).catch(()=>{
      if(live&&text)setSpans([{start:0,end:text.length,source:{kind:"unrecorded",origin:"unrecorded",reason:"verification-unavailable",label:"Source verification unavailable on this connection"}}]);
    });
    return()=>{live=false;};
  },[field,sources,text]);
  const claims=useMemo(()=>spans?.map((span,i)=>({id:String(i),text:(text ?? "").slice(span.start,span.end),source:span.source})) ?? [],[spans,text]);
  const markdownBody=text!==undefined&&<TextMessagePartProvider text={text} isRunning={false}><MarkdownText dir="ltr" /></TextMessagePartProvider>;
  const preview = text ?? (field.value === null || typeof field.value === "number" || typeof field.value === "boolean" ? JSON.stringify(field.value) : undefined);
  return <Collapsible open={reveal||open} onOpenChange={setOpen} className={cn(activityRow,"border border-line")}>
    <CollapsibleTrigger data-slot="request-field-trigger" className={cn(activityTrigger,"py-2")}>
      <ChevronRight data-slot="request-field-chevron" className="rtl:-scale-x-100 size-4 shrink-0 transition-transform duration-(--motion-fast) ease-(--motion-ease) group-data-[state=open]/trigger:rotate-90 group-data-[state=open]/trigger:rtl:-rotate-90 motion-reduce:transition-none" />
      <span className="min-w-0 truncate font-medium">{requestFieldLabel(field)}</span>
      {preview !== undefined && <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{preview}</span>}
      <code dir="ltr" className="ms-auto min-w-0 truncate text-xs text-ink-3">{field.path}</code>
    </CollapsibleTrigger>
    <CollapsibleContent className={collapsePanel}>
      <div className="flex min-w-0 flex-col gap-3 border-t border-line p-3">
        {text!==undefined&&(spans?.length ? <ConfidenceMarker claims={claims} markdown={markdown}/>
          :<div data-request-search-content>{markdown?markdownBody:<p className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-ink">{text}</p>}</div>)}
        {typeof field.value!=="string"&&<RequestJson value={field.value} search={reveal&&text===undefined} />}
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

/** Find exposes the exact retained JSON, including structural keys and syntax.
 * Keep the foldable viewer mounted so clearing find restores its disclosure. */
function RequestJson({value,search,literalText,getText}:{value:unknown;search:boolean;literalText?:string|undefined;getText?:(()=>string)|undefined}) {
  const ownText=useMemo(()=>createRequestJsonText(value),[value]);
  const code=search?(literalText??(getText??ownText)()):"";
  return <>
    <div hidden={search}><JsonViewer value={value} expandedDepth={2} className="max-h-none"/></div>
    {search&&<div data-request-search-content><SyntaxHighlighter code={code} language="json" streaming={code.length>200_000} className="[&>pre]:whitespace-pre-wrap! [&>pre]:wrap-break-word! [&>pre]:overflow-x-hidden!"/></div>}
  </>;
}
