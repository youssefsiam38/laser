/** Resolve transcript paths before the browser can turn them into web routes.
 * The caller supplies the owning session/capture directory, never location.href.
 * Hash-only citations and real URLs remain ordinary links. */
export function fileLinkPath(href: string, cwd?: string): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("//")) return undefined;
  let path = href;
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      path = decodeURIComponent(url.pathname);
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(path)) return undefined;
      path = decodeURIComponent(path.split(/[?#]/, 1)[0]!);
    }
  } catch { return undefined; }
  path = path.replace(/:\d+(?::\d+)?$/, "");
  if (/[\u0000-\u001f\\]/.test(path)) return undefined;
  if (!path.startsWith("/")) {
    if (!cwd?.startsWith("/")) return undefined;
    path = `${cwd}/${path}`;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Only file anchors gain file: support; images never receive local schemes. */
export function markdownUrl(url: string, key: string): string {
  url = url.trim();
  if (/[\u0000-\u001f]/.test(url)) return "";
  if (key === "href" && /^file:/i.test(url)) return fileLinkPath(url) ? url : "";
  return /^(?:[a-z][a-z\d+.-]*:)/i.test(url) && !/^(?:https?|mailto|tel|irc|ircs|xmpp):/i.test(url) ? "" : url;
}
