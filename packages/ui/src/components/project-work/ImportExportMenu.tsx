"use client";
/**
 * The workspace's Import… / Export… / Publish… entry (M21-T21).
 *
 * It sits beside **+ Create** in the workspace header, because it belongs to
 * the same question — where the work in this project comes from and where it
 * goes — and because the header is the one place a person looks for something
 * that acts on the project rather than on one item.
 *
 * A menu rather than three buttons: these are deliberate, occasional acts, and
 * three competing buttons beside Create would read as three equal primary
 * actions. Each item ends in a dialog that ends in a preview.
 */
import { Download, MoreHorizontal, Upload, UploadCloud } from "lucide-react";
import { useState } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import type { ProjectWorkStore } from "@/project-work";

import { ExportDialog, ImportDialog, PublishDialog } from "./ImportExportDialogs.js";

type OpenDialog = "import" | "export" | "publish" | undefined;

export function ImportExportMenu({ store }: { store: ProjectWorkStore | undefined }) {
  const [open, setOpen] = useState<OpenDialog>(undefined);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TooltipIconButton tooltip="Import, export or publish this project's work" className="shrink-0">
            <MoreHorizontal />
          </TooltipIconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={() => setOpen("import")}>
            <Upload />
            Import…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("export")}>
            <Download />
            Export…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("publish")}>
            <UploadCloud />
            Publish…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ImportDialog store={store} open={open === "import"} onOpenChange={(next) => setOpen(next ? "import" : undefined)} />
      <ExportDialog store={store} open={open === "export"} onOpenChange={(next) => setOpen(next ? "export" : undefined)} />
      <PublishDialog store={store} open={open === "publish"} onOpenChange={(next) => setOpen(next ? "publish" : undefined)} />
    </>
  );
}
