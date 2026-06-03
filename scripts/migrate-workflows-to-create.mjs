// One-shot codemod for Phase A2-S5f: migrate every legacy paren-body workflow
//
//     workflow Name(params) [transactional[(level)]] { <body> }
//
// to the members-only form with a synthesized command-triggered `create`:
//
//     workflow Name [transactional[(level)]] {
//       create(params) { <body> }
//     }
//
// Run BEFORE the grammar reshape (it parses the *current* paren-form via the
// committed `out/` build, then emits the new form).  Idempotent-ish: it skips
// any workflow that already lacks a `(` header (already migrated / new-form).
//
//   npm run build && node scripts/migrate-workflows-to-create.mjs

import fs from "node:fs";
import path from "node:path";
import { AstUtils, EmptyFileSystem } from "langium";
import { createDddServices } from "../out/language/ddd-module.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const DRY = process.argv.includes("--dry");
const ONLY = process.argv.find((a) => a.endsWith(".ddd"));

// leading whitespace of the line that `offset` sits on.
function lineIndent(text, offset) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(start, offset));
  return m ? m[0] : "";
}

function migrateText(text) {
  const res = parser.parse(text);
  if (res.parserErrors.length > 0) return { text, changed: 0, skipped: "parse-errors" };
  const wfs = [...AstUtils.streamAst(res.value)].filter(
    (n) => n.$type === "Workflow" && n.$cstNode,
  );
  // descending offset so earlier splices keep later offsets valid
  wfs.sort((a, b) => b.$cstNode.offset - a.$cstNode.offset);
  let out = text;
  let changed = 0;
  for (const wf of wfs) {
    const wfText = wf.$cstNode.text;
    const braceRel = wfText.indexOf("{");
    if (braceRel < 0) continue;
    const header = wfText.slice(0, braceRel); // `workflow Name(params) transactional `
    // Already members-only (no `(` in the header before the brace)? skip.
    if (!header.includes("(")) continue;
    const bi = lineIndent(text, wf.$cstNode.offset);
    const params = (wf.params ?? []).map((p) => p.$cstNode.text).join(", ");
    const es = wf.eventSourced ? " eventSourced" : "";
    const tx = wf.transactional
      ? wf.isolation
        ? ` transactional(${wf.isolation})`
        : " transactional"
      : "";
    // Verbatim inter-brace body, re-indented one level (+2) so it nests inside
    // the synthesized create.  Trim outer blank lines, keep inner structure.
    const innerStart = wf.$cstNode.offset + braceRel + 1;
    const innerEnd = wf.$cstNode.end - 1; // the matching `}`
    const inner = text.slice(innerStart, innerEnd).trim();
    const reindented = inner.replace(/\n/g, "\n  ");
    const newWf =
      `workflow ${wf.name}${es}${tx} {\n` +
      `${bi}  create(${params}) {\n` +
      `${bi}    ${reindented}\n` +
      `${bi}  }\n` +
      `${bi}}`;
    out = out.slice(0, wf.$cstNode.offset) + newWf + out.slice(wf.$cstNode.end);
    changed++;
  }
  return { text: out, changed };
}

function collectDdd() {
  const dirs = [
    path.join(repoRoot, "examples"),
    path.join(repoRoot, "web/src/examples"),
    path.join(repoRoot, "test/e2e/fixtures"),
  ];
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ddd")) out.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

const files = ONLY ? [path.resolve(ONLY)] : collectDdd();
let total = 0;
for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  const { text, changed, skipped } = migrateText(before);
  if (skipped) {
    console.log(`SKIP ${path.relative(repoRoot, f)} (${skipped})`);
    continue;
  }
  if (changed > 0) {
    total += changed;
    if (DRY) {
      console.log(`\n===== ${path.relative(repoRoot, f)} (${changed} workflow(s)) =====`);
      // show only the workflow regions for review
      console.log(text);
    } else {
      fs.writeFileSync(f, text, "utf8");
      console.log(`MIGRATED ${path.relative(repoRoot, f)} (${changed})`);
    }
  }
}
console.log(
  `\n${DRY ? "[dry] would migrate" : "migrated"} ${total} workflow(s) across ${files.length} file(s)`,
);
