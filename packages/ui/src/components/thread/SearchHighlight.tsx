import { Fragment } from "react";
import { textMatches } from "./search-text.js";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const matches = textMatches(text, query);
  let end = 0;
  return <>{matches.map(m => {
    const before = text.slice(end, m.start);
    end = m.end;
    return <Fragment key={m.start}>{before}<mark className="rounded-sm bg-attention/20 text-ink">{text.slice(m.start, m.end)}</mark></Fragment>;
  })}{text.slice(end)}</>;
}
