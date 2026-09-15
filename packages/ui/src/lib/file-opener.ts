import { createContext, useContext } from "react";
import type { ProjectFileContent } from "@lasercode/protocol";

/**
 * What a viewer was asked to show. A `picture` is an image this window already
 * rebuilt and is accounted for in the image pool: it is shown from that very
 * blob, never fetched again or copied, and `release` gives the pool its hold
 * back when the viewer closes (RP-5b).
 */
export type FileViewerSource =
  | { request: { cwd: string; path: string }; file?: ProjectFileContent; picture?: never; release?: never }
  | { request?: never; file: ProjectFileContent; picture?: never; release?: never }
  | { request?: never; file?: never; picture: { url: string; blob: Blob; name: string; mediaType: string; bytes: number }; release?: (() => void) | undefined };
export interface FileOpener {
  openFile(source: FileViewerSource, trigger: HTMLElement): void;
  readFile(cwd: string, path: string): Promise<ProjectFileContent>;
}
export const FileOpenerContext = createContext<FileOpener | undefined>(undefined);
export const useFileOpener = () => useContext(FileOpenerContext);
