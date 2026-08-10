import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  codeOfMessageKey,
  DIAGNOSTIC_MESSAGES,
  type DiagnosticMessageKey,
} from "../../src/diagnostics/messages.js";

// ---------------------------------------------------------------------------
// The validator diagnostic-message catalog is the SINGLE HOME for the wording
// of every `loom.*` diagnostic (M-T1.11).  Codes were always stable; the
// strings used to be inline literals across ~50 files, so the diagnostic
// surface could not be enumerated, reviewed, or translated.
//
// This is the ratchet that keeps it that way.  Three invariants, each of which
// FAILS when a single call site regresses (mutation-proved in the PR):
//
//   1. No inline wording — a diagnostic site that attaches a `loom.*` code
//      must take its message from `diagMessage(...)`.
//   2. Key ⇒ code agreement — the catalog key a site renders must belong to
//      the code that same site attaches (`codeOfMessageKey`).  This is the one
//      a copy-pasted call site actually gets wrong.
//   3. No orphans — every catalog entry is reachable from a call site, so a
//      deleted check takes its wording with it.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The validator surface the catalog owns: the AST validators, the IR check
 *  leaves, and the validator registry that wraps them. */
function catalogedSources(): string[] {
  const out: string[] = [];
  for (const dir of [
    path.join("src", "language", "validators"),
    path.join("src", "ir", "validate", "checks"),
  ]) {
    for (const f of fs.readdirSync(path.join(repoRoot, dir)).sort()) {
      if (f.endsWith(".ts")) out.push(path.join(dir, f));
    }
  }
  out.push(path.join("src", "language", "ddd-validator.ts"));
  return out;
}

interface Site {
  file: string;
  line: number;
  /** The `loom.*` code the site attaches. */
  code: string;
  /** The message argument, as source text. */
  message: ts.Expression;
  sf: ts.SourceFile;
}

/** Every diagnostic construction site carrying a literal `loom.*` code — both
 *  shapes: Langium's `accept(sev, msg, { …, code })` and the IR checks'
 *  `{ severity, message, source, code }` object literal. */
function sitesIn(file: string): Site[] {
  const src = fs.readFileSync(path.join(repoRoot, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true);
  const out: Site[] = [];
  const push = (message: ts.Expression, codeNode: ts.Expression): void => {
    if (!ts.isStringLiteral(codeNode) || !codeNode.text.startsWith("loom.")) return;
    out.push({
      file,
      line: sf.getLineAndCharacterOfPosition(message.getStart(sf)).line + 1,
      code: codeNode.text,
      message,
      sf,
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && /(^|\.)accept$/.test(n.expression.getText(sf))) {
      const opts = n.arguments[2];
      if (n.arguments.length >= 3 && opts && ts.isObjectLiteralExpression(opts)) {
        const code = opts.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText(sf) === "code",
        );
        if (code) push(n.arguments[1]!, code.initializer);
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map<string, ts.Expression>();
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) props.set(p.name.getText(sf), p.initializer);
      }
      const message = props.get("message");
      const code = props.get("code");
      if (props.has("severity") && message && code) push(message, code);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const ALL_SITES = catalogedSources().flatMap(sitesIn);

/** The catalog key a site renders, or `undefined` when it does not go through
 *  the catalog at all. */
function keyOf(site: Site): string | undefined {
  const m = site.message;
  if (!ts.isCallExpression(m)) return undefined;
  if (m.expression.getText(site.sf) !== "diagMessage") return undefined;
  const arg = m.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : undefined;
}

const where = (s: Site): string => `${s.file}:${s.line} (${s.code})`;

describe("validator diagnostic-message catalog", () => {
  it("covers the whole validator surface", () => {
    // Guards the scanner itself: if the AST shapes above ever stop matching,
    // the invariants below would pass vacuously.
    expect(ALL_SITES.length).toBeGreaterThan(400);
  });

  it("has no inline wording — every coded diagnostic renders from the catalog", () => {
    const inline = ALL_SITES.filter((s) => keyOf(s) === undefined).map(where);
    expect(inline).toEqual([]);
  });

  it("renders a key that belongs to the code the site attaches", () => {
    const mismatched: string[] = [];
    for (const s of ALL_SITES) {
      const key = keyOf(s);
      if (key === undefined) continue;
      if (!(key in DIAGNOSTIC_MESSAGES)) mismatched.push(`${where(s)} → unknown key '${key}'`);
      else if (codeOfMessageKey(key as DiagnosticMessageKey) !== s.code) {
        mismatched.push(`${where(s)} → key '${key}' belongs to a different code`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("has no orphan entries", () => {
    const used = new Set(ALL_SITES.map(keyOf).filter((k): k is string => k !== undefined));
    const orphans = Object.keys(DIAGNOSTIC_MESSAGES).filter((k) => !used.has(k));
    expect(orphans).toEqual([]);
  });

  it("keys are a `loom.*` code, optionally `#<slug>`-qualified", () => {
    const bad = Object.keys(DIAGNOSTIC_MESSAGES).filter(
      (k) => !/^loom\.[a-z0-9]+(-[a-z0-9]+)*(#[a-z0-9]+(-[a-z0-9]+)*)?$/.test(k),
    );
    expect(bad).toEqual([]);
  });

  it("renders every entry — no catalog entry throws or comes out blank", () => {
    // Params are `unknown`, so a Proxy standing in for the params object
    // exercises each builder without needing per-entry fixtures.
    const anyParams = new Proxy({}, { get: (_t, prop) => `<${String(prop)}>` });
    for (const [key, entry] of Object.entries(DIAGNOSTIC_MESSAGES)) {
      const text = typeof entry === "string" ? entry : (entry as (p: unknown) => string)(anyParams);
      expect(text.trim(), key).not.toBe("");
    }
  });
});
