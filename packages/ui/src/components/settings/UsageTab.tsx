import { useLaserView } from "@/runtime";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountUsage } from "../shell/AccountUsage.js";

/** Read-only account telemetry; no project-scoped setting or worker is created. */
export function UsageTab() {
  const view = useLaserView();
  return <ScrollArea className="h-full">
    <div className="mx-auto flex max-w-160 flex-col gap-4 px-6 py-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Account usage</h2>
        <p className="mt-1 text-sm leading-6 text-ink-2">All reported allowance windows and credits, including provider labels whose meaning is not yet documented. These are account-wide limits, not project settings or this chat’s token totals.</p>
      </div>
      {view ? <AccountUsage state={view.state.accountUsage} /> : <p className="text-sm text-ink-2">Open a session with a connected account provider to load its allowance here.</p>}
    </div>
  </ScrollArea>;
}
