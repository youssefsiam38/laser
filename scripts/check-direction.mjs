#!/usr/bin/env node
/** Prevent layout regressions: source strings are parsed, not grepped through comments. */
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const utility = /(?:^|[\s:])!?-?(?:(?:ml|mr|pl|pr|left|right|space-x|translate-x)-[^\s]+|text-(?:left|right)\b|(?:rounded-(?:l|r|tl|tr|bl|br)|border-(?:l|r))(?=-|!?(?:\s|$))|float-(?:left|right)\b|hairline-[lr]\b)/g;
const property = /(?<![\w-])(?:left|right|margin-left|margin-right|padding-left|padding-right|border-left(?:-\w+)?|border-right(?:-\w+)?|border-(?:top|bottom)-(?:left|right)-radius)\s*:/g;

export function checkDirectionSource(source, filename = "component.tsx") {
  const lines = source.split("\n");
  const failures = [];
  const allowed = (line) => /(?:\/\/|\/\*|\{\/\*)[ \t]*bidi-allow-physical:[ \t]*[^\s*/].+/.test(`${lines[line - 1] ?? ""}\n${lines[line] ?? ""}`);
  const report = (start, value, pattern) => {
    for (const match of value.matchAll(pattern)) {
      const line = source.slice(0, start + match.index).split("\n").length - 1;
      if (!allowed(line)) failures.push({ line: line + 1, token: match[0].trim() });
    }
  };
  if (filename.endsWith(".css")) {
    // Preserve offsets while ignoring prose comments.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    report(0, css, property);
  } else {
    const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        report(node.getStart(tree) + 1, node.text, utility);
        report(node.getStart(tree) + 1, node.text, property);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return failures;
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else if (/\.(?:tsx?|css)$/.test(path)) paths.push(path);
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let count = 0;
  for (const path of await walk(resolve(root, "packages/ui/src"))) {
    for (const failure of checkDirectionSource(await readFile(path, "utf8"), path)) {
      console.error(`${relative(root, path)}:${failure.line}: physical direction ${failure.token}; use an inline logical utility (DESIGN.md, Direction).`);
      count++;
    }
  }
  if (count) process.exitCode = 1;
  else console.log("Direction guard: no physical layout utilities or CSS properties.");
}
