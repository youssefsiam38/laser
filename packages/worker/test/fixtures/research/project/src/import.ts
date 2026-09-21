export function importDocument(path: string): string {
  // PDF is refused here until a parser is chosen.
  if (path.endsWith(".pdf")) throw new Error("PDF import is not supported");
  return path;
}
