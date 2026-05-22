import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Model } from "../../src/language/generated/ast.js";
import { printStructural } from "../../src/language/print/index.js";
import { parseRawResult } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Round-trip safety net for the structural `.ddd` printer (System/Model
// Builder, Phase C).
//
// For every top-level member in the example corpus: print it, splice the
// printed text back over its own CST range, re-parse the whole document, and
// assert the AST is structurally identical.  Printing a top-level `system`
// exercises the whole printer recursively (modules, aggregates, ui, etc.), so
// this gates the printer against grammar drift before it can corrupt source.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Comparable projection of an AST: keep `$type`, own non-`$` fields, and
// references as `{ $ref }`; drop positions / containers / documents.
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$refText === "string") return { $ref: o.$refText };
    if (typeof o.$type === "string") {
      const out: Record<string, unknown> = { $type: o.$type };
      for (const k of Object.keys(o)) if (!k.startsWith("$")) out[k] = norm(o[k]);
      return out;
    }
  }
  return v;
}

function collectDddFiles(): string[] {
  const dirs = [path.join(repoRoot, "examples"), path.join(repoRoot, "web/src/examples")];
  const out: string[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith(".ddd")) out.push(path.join(d, f));
  }
  return out.sort();
}

describe("print-structural round-trip", () => {
  for (const file of collectDddFiles()) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, "utf8");
    const original = parseRawResult(text);

    if (original.parserErrors.length > 0) {
      it.skip(`round-trips every top-level member in ${rel} (fragment — not a complete model)`, () => {});
      continue;
    }

    it(`round-trips every top-level member in ${rel}`, () => {
      const normOrig = norm(original.value);
      const members = (original.value as Model).members;
      for (const member of members) {
        const cst = member.$cstNode;
        if (!cst) continue;
        const printed = printStructural(member);
        const spliced = text.slice(0, cst.offset) + printed + text.slice(cst.end);
        const re = parseRawResult(spliced);
        expect(re.parserErrors, `printed member must parse:\n${printed}`).toEqual([]);
        expect(norm(re.value), `printed member must round-trip:\n${printed}`).toEqual(normOrig);
      }
    });
  }
});
