import { createContext, useContext, type ComponentProps } from "react";
import { toast } from "sonner";
import { fileLinkPath } from "@/lib/file-links";

export const FileLinkDirectory = createContext<string | undefined>(undefined);
export const hasSourceEditor = () => typeof (globalThis as { desktop?: { openSourceFile?: unknown } }).desktop?.openSourceFile === "function";

export async function openSourcePath(path: string): Promise<void> {
  const desktop = (globalThis as { desktop?: { openSourceFile?: (path: string) => Promise<{ opened: boolean; reason?: string }> } }).desktop;
  try {
    if (desktop?.openSourceFile) {
      const result = await desktop.openSourceFile(path);
      if (!result.opened) toast.error(result.reason ?? "Couldn’t open this file. Check your default text editor.");
    } else {
      await navigator.clipboard.writeText(path);
      toast.success("Path copied. Open it in your editor on the project computer.");
    }
  } catch { toast.error("Couldn’t open or copy this path. Try again from the desktop app."); }
}

export function SourceFileLink({ href = "", children, title: _title, ...props }: ComponentProps<"a">) {
  const cwd = useContext(FileLinkDirectory);
  const path = fileLinkPath(href, cwd);
  if (path) return <a {...props} dir="ltr" href={href} data-file-path={path} onClick={event => {
    event.preventDefault(); void openSourcePath(path);
  }} onAuxClick={event => { event.preventDefault(); }} onContextMenu={event => event.preventDefault()}>{children}</a>;
  // Unresolved relative links must not silently become host HTTP routes.
  if (href && !href.startsWith("#") && !href.startsWith("//") && !/^[a-z][a-z\d+.-]*:/i.test(href)) {
    const explain = () => toast.error("This file’s project directory was not recorded. Open it from the project computer.");
    return <a {...props} role="link" tabIndex={0} onClick={explain} onKeyDown={event => { if (event.key === "Enter") explain(); }}>{children}</a>;
  }
  return <a {...props} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a>;
}
