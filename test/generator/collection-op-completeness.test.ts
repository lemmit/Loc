// Collection-op completeness gate (docs/old/plans/stdlib.md, slice A4).
//
// The catalogue (src/util/collection-ops.ts) is the single source of truth for
// which collection ops exist on an array receiver.  Each of the five domain
// backends carries a keyed renderer table (`*_COLLECTION_RENDERERS`) that maps
// every op name to its native rendering.  This test pins that EVERY catalogue
// op has an entry in EVERY backend table, so adding a seventh op fails CI until
// each backend is filled in — the same anti-silent-gap discipline as the scalar
// intrinsic + walker-stdlib completeness pins.

import { describe, expect, it } from "vitest";
import { CS_COLLECTION_RENDERERS } from "../../src/generator/dotnet/render-expr.js";
import { ELIXIR_COLLECTION_RENDERERS } from "../../src/generator/elixir/render-expr.js";
import { JAVA_COLLECTION_RENDERERS } from "../../src/generator/java/render-expr.js";
import { PY_COLLECTION_RENDERERS } from "../../src/generator/python/render-expr.js";
import { TS_COLLECTION_RENDERERS } from "../../src/generator/typescript/render-expr.js";
import { COLLECTION_OP_SIGNATURES } from "../../src/util/collection-ops.js";

const TABLES: Record<string, Record<string, unknown>> = {
  "typescript (TS_COLLECTION_RENDERERS)": TS_COLLECTION_RENDERERS,
  "dotnet (CS_COLLECTION_RENDERERS)": CS_COLLECTION_RENDERERS,
  "java (JAVA_COLLECTION_RENDERERS)": JAVA_COLLECTION_RENDERERS,
  "python (PY_COLLECTION_RENDERERS)": PY_COLLECTION_RENDERERS,
  "elixir (ELIXIR_COLLECTION_RENDERERS)": ELIXIR_COLLECTION_RENDERERS,
};

// Ops that DESUGAR in lowering to other ops and never reach a renderer — so
// they carry no `*_COLLECTION_RENDERERS` entry (and must be skipped by the
// per-table completeness assertion below).  `avg(λ)` desugars to
// `count == 0 ? null : sum(λ) / count`.
const DESUGARED_COLLECTION_OPS = new Set(["avg"]);

describe("collection-op completeness — every catalogue op renders on every backend", () => {
  for (const op of COLLECTION_OP_SIGNATURES) {
    if (DESUGARED_COLLECTION_OPS.has(op.name)) continue;
    it(`${op.name}: renderer on all 5 backends`, () => {
      for (const [label, table] of Object.entries(TABLES)) {
        expect(table[op.name], `missing renderer for '${op.name}' in ${label}`).toBeTypeOf(
          "function",
        );
      }
    });
  }

  it("no orphan renderers — every table key is a catalogue op", () => {
    const known = new Set(COLLECTION_OP_SIGNATURES.map((o) => o.name));
    for (const [label, table] of Object.entries(TABLES)) {
      for (const key of Object.keys(table)) {
        expect(known.has(key), `orphan renderer '${key}' in ${label} (not in the catalogue)`).toBe(
          true,
        );
      }
    }
  });
});
