// COMPLETENESS pin for the frontend collection-op seam.
//
// `FRONTEND_RENDERED_COLLECTION_OPS` (`ir/util/collection-op-site.ts`) is
// simultaneously a validator POLICY — the ops
// `loom.frontend-collection-op-unsupported` lets through — and an emitter
// CONTRACT: every frontend's `renderCollectionOp` table must answer for all of
// them.  The gate and the JS leaves share the constant, so those two cannot
// drift; the four per-target TABLES cannot, because each is real code in a
// different language.  This file is what stops them drifting instead.
//
// Both directions matter, and the second is the sharper one:
//
//   • an op in the set with NO arm on some target ⇒ the gate lets the body
//     through and that target falls back to the walker's verbatim
//     `<recv>.<member>` emit — the exact defect the gate was built to prevent,
//     shipped as unbuildable output on one frontend only;
//   • an op NOT in the set that has an arm ⇒ dead code that reads as support,
//     which is how a "we render this" claim quietly becomes wrong.
//
// The sibling `collection-ops.test.ts` asserts what each arm EMITS; this one
// asserts that the arms exist and that the set is exactly the intersection.

import { describe, expect, it } from "vitest";
import { JS_COLLECTION_RENDERERS } from "../../../src/generator/_expr/js-collection-ops.js";
import { FS_COLLECTION_RENDERERS } from "../../../src/generator/feliz/fs-expr.js";
import { DART_COLLECTION_RENDERERS } from "../../../src/generator/flutter/dart-expr.js";
import { FRONTEND_RENDERED_COLLECTION_OPS } from "../../../src/ir/util/collection-op-site.js";
import { COLLECTION_OP_SIGNATURES } from "../../../src/util/collection-ops.js";

const RENDERED = [...FRONTEND_RENDERED_COLLECTION_OPS].sort();

/** The two targets with a keyed table of their own.  (The four JS frontends
 *  share `JS_COLLECTION_RENDERERS`, which is the TypeScript BACKEND's table and
 *  therefore covers the whole catalogue — the frontend subset is applied at the
 *  seam, not in the table, so it is checked separately below.  HEEx's arms are
 *  a `switch` in its parallel walker, not a table, so its coverage is asserted
 *  through emitted output in `collection-ops.test.ts`.) */
const KEYED_TABLES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["feliz (FS_COLLECTION_RENDERERS)", FS_COLLECTION_RENDERERS],
  ["flutter (DART_COLLECTION_RENDERERS)", DART_COLLECTION_RENDERERS],
];

describe("every frontend renders exactly the ops the gate lets through", () => {
  for (const [label, table] of KEYED_TABLES) {
    it(`${label} has an arm for every rendered op`, () => {
      const missing = RENDERED.filter((op) => table[op] === undefined);
      expect(
        missing,
        `${label} is missing ${missing.join(", ")} — the gate lets those through, so this ` +
          `target would fall back to the walker's verbatim emit`,
      ).toEqual([]);
    });

    it(`${label} has NO arm for a refused op — no dead support`, () => {
      const extra = Object.keys(table)
        .filter((op) => !FRONTEND_RENDERED_COLLECTION_OPS.has(op))
        .sort();
      expect(
        extra,
        `${label} renders ${extra.join(", ")}, which the gate still refuses — either ungate ` +
          `them (on EVERY frontend) or delete the arms`,
      ).toEqual([]);
    });
  }

  it("the JS table covers every rendered op", () => {
    // This table is the TypeScript backend's own, shared with the four JS
    // frontends, so it legitimately carries arms the frontends decline — the
    // subset is applied at `renderJsCollectionOp`, not here.  Only the
    // must-have direction is checkable.
    const missing = RENDERED.filter((op) => JS_COLLECTION_RENDERERS[op] === undefined);
    expect(missing).toEqual([]);
  });

  it("every rendered op is a real catalogue op", () => {
    const catalogue = new Set(COLLECTION_OP_SIGNATURES.map((s) => s.name));
    expect(RENDERED.filter((op) => !catalogue.has(op))).toEqual([]);
  });

  it("the refused remainder is exactly the eight representation divergences", () => {
    // Named literally, so NARROWING the gate has to come here and say which op
    // stopped diverging — and so the `unsupported-register.ts` row, the two
    // diagnostic messages and `docs/page-metamodel.md` have one list to match.
    const refused = COLLECTION_OP_SIGNATURES.map((s) => s.name)
      .filter((op) => !FRONTEND_RENDERED_COLLECTION_OPS.has(op))
      .sort();
    expect(refused).toEqual([
      "avg",
      "contains",
      "distinct",
      "first",
      "firstOrNull",
      "max",
      "min",
      "sum",
    ]);
  });
});
