import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EmptyFileSystem, AstUtils, type AstNode } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";
import { seedFromBody, emitBody } from "../web/src/builder/page/model.js";
import type { BodyProp } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// Page-builder data-layer round-trip (Builders, Phase 1).  For every page
// `body:` in the corpus: seed the builder tree, emit it back, splice over the
// body's CST range, re-parse, and assert an identical AST.  Recognize-or-opaque
// must lose nothing.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;

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

describe("page-builder model round-trip", () => {
  for (const file of collectDddFiles()) {
    const rel = path.relative(repoRoot, file);
    const text = fs.readFileSync(file, "utf8");
    const original = parser.parse(text);
    if (original.parserErrors.length > 0) continue; // fragments handled elsewhere

    const bodies: BodyProp[] = [];
    for (const node of AstUtils.streamAst(original.value) as Iterable<AstNode>) {
      if (node.$type === "BodyProp") bodies.push(node as BodyProp);
    }
    if (bodies.length === 0) continue;

    it(`round-trips ${bodies.length} page body/bodies in ${rel}`, () => {
      const normOrig = norm(original.value);
      for (const body of bodies) {
        const cst = body.expr.$cstNode;
        if (!cst) continue;
        const emitted = emitBody(seedFromBody(body.expr));
        const spliced = text.slice(0, cst.offset) + emitted + text.slice(cst.end);
        const re = parser.parse(spliced);
        expect(re.parserErrors, `emitted body must parse:\n${emitted}`).toEqual([]);
        expect(norm(re.value), `emitted body must round-trip:\n${emitted}`).toEqual(normOrig);
      }
    });
  }
});
