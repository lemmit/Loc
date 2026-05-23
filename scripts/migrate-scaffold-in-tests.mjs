// Migrate inline `scaffold X: a, b` strings inside test source files
// (which embed DDD source as JS string literals) to the new
// `with scaffold(X: [a, b])` form on the enclosing `ui` declaration.
//
// Same logic as scripts/migrate-scaffold-keyword.mjs but operates
// on the contents of template-literal strings inside .test.ts files.
// We scan each line, build per-ui scaffold collections, then rewrite.

import { promises as fs } from "node:fs";
import * as path from "node:path";

const ROOT = "test";
const SELECTORS = ["modules", "contexts", "aggregates", "workflows", "views"];
const SCAFFOLD_LINE = /^([\t ]*)scaffold\s+(\w+)\s*:\s*([^\n}`]+?)\s*$/;
const UI_HEAD = /^([\t ]*)ui\s+(\w+)\s*\{/;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield p;
  }
}

async function migrateFile(file) {
  const src = await fs.readFile(file, "utf8");
  const lines = src.split("\n");
  const uis = [];
  let cur = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (cur === null) {
      const m = line.match(UI_HEAD);
      if (m) {
        cur = { headLineIdx: i, indent: m[1], scaffolds: [] };
        depth = 1;
        continue;
      }
    } else {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            uis.push(cur);
            cur = null;
            break;
          }
        }
      }
      if (cur) {
        const m = line.match(SCAFFOLD_LINE);
        if (m && SELECTORS.includes(m[2])) {
          cur.scaffolds.push({
            lineIdx: i,
            selector: m[2],
            names: m[3].split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean),
          });
        }
      }
    }
  }
  if (uis.length === 0 || uis.every((u) => u.scaffolds.length === 0)) {
    return false;
  }
  const sorted = uis
    .filter((u) => u.scaffolds.length > 0)
    .sort((a, b) => b.headLineIdx - a.headLineIdx);
  for (const u of sorted) {
    const merged = {};
    for (const s of u.scaffolds) {
      if (!merged[s.selector]) merged[s.selector] = [];
      for (const n of s.names) {
        if (!merged[s.selector].includes(n)) merged[s.selector].push(n);
      }
    }
    const argParts = SELECTORS.filter((sel) => merged[sel]).map(
      (sel) => `${sel}: [${merged[sel].join(", ")}]`,
    );
    const withClause = ` with scaffold(${argParts.join(", ")})`;
    const head = lines[u.headLineIdx];
    lines[u.headLineIdx] = head.replace(/(\bui\s+\w+)(\s*\{)/, `$1${withClause}$2`);
    for (const s of u.scaffolds.slice().reverse()) {
      lines.splice(s.lineIdx, 1);
    }
  }
  const out = lines.join("\n");
  if (out !== src) {
    await fs.writeFile(file, out);
    return true;
  }
  return false;
}

let changed = 0;
for await (const f of walk(ROOT)) {
  if (await migrateFile(f)) {
    console.log("migrated:", f);
    changed++;
  }
}
console.log(`\nTotal test files migrated: ${changed}`);
