import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLaserStable } from "@/runtime";

import { useShell } from "./shell-context.js";

export type DesktopFolderPicker = {
  chooseDirectory(): Promise<string | null>;
};

/**
 * The desktop shell's native folder chooser, when this page runs inside it.
 * The one way a folder is picked anywhere in the app: Add project here, and
 * "New project…" in the move-session dialog (M13-T58) reuse it rather than
 * growing a second picker.
 */
export function desktopFolderPicker(): DesktopFolderPicker | undefined {
  return (globalThis as typeof globalThis & { desktop?: DesktopFolderPicker }).desktop;
}

/**
 * Add Project is one native action, not a path-entry form. In Electron, opening
 * this surface immediately hands control to the operating system's folder
 * chooser. A browser cannot browse the desktop host's filesystem, so it gets a
 * clear explanation instead of a text field that only appears to solve that.
 */
export function AddProjectDialog() {
  const { addProjectOpen, setAddProjectOpen } = useShell();
  const { actions } = useLaserStable();
  const opening = useRef(false);
  const desktop = desktopFolderPicker();

  useEffect(() => {
    if (!addProjectOpen || !desktop || opening.current) return;
    opening.current = true;

    void desktop
      .chooseDirectory()
      .then(async (cwd) => {
        if (!cwd) return;
        const project = await actions.addProject(cwd);
        if (project) void actions.goProject(project.cwd);
      })
      .catch((error: unknown) => {
        actions.toast(
          "error",
          `Could not open the folder picker. ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        opening.current = false;
        setAddProjectOpen(false);
      });
  }, [actions, addProjectOpen, desktop, setAddProjectOpen]);

  // Electron owns the visible dialog. Do not put a second Laser modal behind
  // it: cancellation should return directly to the surface that launched it.
  if (desktop) return null;

  return (
    <Dialog open={addProjectOpen} onOpenChange={setAddProjectOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-surface-2 text-live">
            <FolderOpen className="size-5" aria-hidden="true" />
          </div>
          <DialogTitle>Add projects from the desktop app</DialogTitle>
          <DialogDescription>
            Open {PRODUCT_DISPLAY_NAME} on the computer that holds your projects, then choose a folder with its operating system picker.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => setAddProjectOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
