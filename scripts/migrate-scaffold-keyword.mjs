// One-shot migration script: converts legacy `scaffold X: a, b` directives
// inside `ui` blocks to the new `with scaffold(X: [a, b])` macro call on
// the ui declaration head.  Run from repo root: `node scripts/migrate-scaffold-keyword.mjs`.
//
// Strategy: text-level transform.  For each `.ddd` file:
//   1. Find each `ui <Name> {` opening line.
//   2. Scan forward inside the brace block (depth-tracked) for
//      `scaffold <selector>: <names>` directives.
//   3. Collect them all per ui.
//   4. Remove the directive lines.
//   5. Splice `with scaffold(<selector>: [<names>], ...)` onto the
//      `ui <Name>` head, preserving indentation.
//
// Limitations (acceptable for the migration we have):
//   - Doesn't handle scaffold directives split across multiple physical
//     lines (none in the current corpus).
//   - Doesn't handle inline comments on a scaffold line (none present).
//   - Doesn't preserve original argument formatting whitespace.

import { promises as fs } from "node:fs";
import * as path from "node:path";

const ROOTS = ["examples", "web/src/examples"];
const SELECTORS = ["modules", "contexts", "aggregates", "workflows", "views"];
const SCAFFOLD_LINE = /^([\t ]*)scaffold\s+(\w+)\s*:\s*([^\n}]+?)\s*$/;
const UI_HEAD = /^([\t ]*)ui\s+(\w+)\s*\{/;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && entry.name.endsWith(".ddd")) yield p;
  }
}

async function migrateFile(file) {
  const src = await fs.readFile(file, "utf8");
  const lines = src.split("\n");
  // Find `ui <Name> {` heads and their corresponding closing braces;
  // record per-ui scaffold directives.
  const uis = []; // { headLineIdx, depth0, scaffolds: [{lineIdx, selector, names}] }
  let cur = null;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (cur === null) {
      const m = line.match(UI_HEAD);
      if (m) {
        cur = { headLineIdx: i, indent: m[1], openCount: 1, scaffolds: [] };
        depth = 1;
      }
    } else {
      // Count braces to track when this ui block ends.
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
            names: m[3]
              .split(/\s*,\s*/)
              .map((s) => s.trim())
              .filter(Boolean),
          });
        }
      }
    }
  }
  if (uis.length === 0 || uis.every((u) => u.scaffolds.length === 0)) {
    return false;
  }
  // Apply edits in reverse order so line indices stay stable.
  const sorted = uis
    .filter((u) => u.scaffolds.length > 0)
    .sort((a, b) => b.headLineIdx - a.headLineIdx);
  for (const u of sorted) {
    // Build merged args: per selector, union of names preserving order.
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
    // Splice the with clause into the ui head line.
    const head = lines[u.headLineIdx];
    lines[u.headLineIdx] = head.replace(/(\bui\s+\w+)(\s*\{)/, `$1${withClause}$2`);
    // Remove scaffold directive lines (in reverse).
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
for (const root of ROOTS) {
  try {
    for await (const f of walk(root)) {
      if (await migrateFile(f)) {
        console.log("migrated:", f);
        changed++;
      }
    }
  } catch (err) {
    if (err.code === "ENOENT") continue;
    throw err;
  }
}
console.log(`\nTotal files migrated: ${changed}`);
