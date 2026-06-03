// One-shot codemod for the inline `.ddd` strings inside `.ts` test files
// (Phase A2-S5f).  Rewrites legacy paren-body workflows embedded in template
// literals:
//
//     workflow X(params) [transactional[(lvl)]] { <stmts> }
//   → workflow X [transactional[(lvl)]] { create(params) { <stmts> } }
//
// Brace-counted (handles nested `{}` and `${…}` interpolations in the body).
// SKIPS workflow-surface tests (members-only bodies with on/handle/apply/state
// — those are hand-edited, since their bodies aren't free statements) and
// headers with a `${…}` interpolation between `)` and `{` (hand-edited).
//
//   node scripts/migrate-workflows-in-tests.mjs [--dry]

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DRY = process.argv.includes("--dry");

// Hand-edited instead (new-member / members-only bodies):
const EXCLUDE = new Set([
  "test/ir/workflow-state.test.ts",
  "test/ir/workflow-subscriptions.test.ts",
  "test/ir/workflow-correlation.test.ts",
  "test/ir/workflow-event-sourced.test.ts",
  "test/ir/workflow-handle.test.ts",
  "test/ir/workflow-transactional-legality.test.ts",
  "test/ir/workflow-state-resolution.test.ts",
  "test/language/validation/workflow-subscriptions-validator.test.ts",
]);

// header: workflow NAME [eventSourced] [transactional[(lvl)]] (params) {
const HEAD =
  /workflow\s+([A-Za-z_]\w*)((?:\s+eventSourced)?(?:\s+transactional(?:\([^)]*\))?)?)\s*\(([^)]*)\)\s*\{/g;
// legacy ordering: workflow NAME(params) transactional[(lvl)] {  (mods AFTER params)
const HEAD_TX = /workflow\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s+(transactional(?:\([^)]*\))?)\s*\{/g;

function matchClose(text, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function runPass(text, re, build) {
  let changed = 0;
  let out = "";
  let pos = 0;
  re.lastIndex = 0;
  let m;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex walk
  while ((m = re.exec(text)) !== null) {
    const full = m[0];
    const openIdx = m.index + full.length - 1; // the `{`
    const closeIdx = matchClose(text, openIdx);
    if (closeIdx < 0) continue;
    const body = text.slice(openIdx + 1, closeIdx);
    out += text.slice(pos, m.index);
    out += build(m, body);
    pos = closeIdx + 1;
    re.lastIndex = pos;
    changed++;
  }
  out += text.slice(pos);
  return { text: out, changed };
}

function migrate(text) {
  // Pass 1: mods-before-params (plain + eventSourced).
  const p1 = runPass(
    text,
    HEAD,
    (m, body) => `workflow ${m[1]}${m[2]} {\n      create(${m[3]}) {${body}}\n    }`,
  );
  // Pass 2: legacy mods-after-params (transactional[(lvl)]).
  const p2 = runPass(
    p1.text,
    HEAD_TX,
    (m, body) => `workflow ${m[1]} ${m[3]} {\n      create(${m[2]}) {${body}}\n    }`,
  );
  return { text: p2.text, changed: p1.changed + p2.changed };
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
}

const files = [];
walk(path.join(repoRoot, "test"), files);
let total = 0;
let touched = 0;
for (const f of files) {
  const rel = path.relative(repoRoot, f);
  if (EXCLUDE.has(rel)) continue;
  const before = fs.readFileSync(f, "utf8");
  if (!/workflow\s+[A-Za-z_]\w*(\s+eventSourced)?\s*\(/.test(before)) continue;
  const { text, changed } = migrate(before);
  if (changed > 0 && text !== before) {
    total += changed;
    touched++;
    if (!DRY) fs.writeFileSync(f, text, "utf8");
    console.log(`${DRY ? "[dry] " : ""}${rel}: ${changed} workflow(s)`);
  }
}
console.log(`\n${DRY ? "[dry] " : ""}${total} workflow(s) across ${touched} file(s)`);
