import { useEffect, useState } from "react";
import type { ProjectFileContent } from "@lasercode/protocol";
import { useFileOpener } from "@/lib/file-opener";

/** Visibility gates reads; leaving the viewport releases the component's retained bytes. */
export function useProjectImage(cwd: string, path: string) {
  const opener = useFileOpener();
  const [element, ref] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [file, setFile] = useState<ProjectFileContent>();
  useEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.target === element) setVisible(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  useEffect(() => {
    let current = true;
    setFile(undefined);
    if (visible && opener) void opener.readFile(cwd, path).then(file => { if (current) setFile(file); }, () => {});
    return () => { current = false; };
  }, [visible, opener, cwd, path]);
  return { ref, file: visible ? file : undefined, visible };
}
