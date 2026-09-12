import { createContext, useContext } from "react";
import type { ProjectFileContent } from "@lasercode/protocol";

export type FileViewerSource = { request: { cwd: string; path: string }; file?: ProjectFileContent } | { request?: never; file: ProjectFileContent };
export interface FileOpener {
  openFile(source: FileViewerSource, trigger: HTMLElement): void;
  readFile(cwd: string, path: string): Promise<ProjectFileContent>;
}
export const FileOpenerContext = createContext<FileOpener | undefined>(undefined);
export const useFileOpener = () => useContext(FileOpenerContext);
