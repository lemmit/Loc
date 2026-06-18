// Macro-layer (AST→AST) page-body builders for the scaffold family.
//
// These are the unfoldable-source twins of the IR-phase expanders in
// `src/ir/lower/walker-primitive-expander.ts`.  Where the ⑤c expanders
// build `ExprIR` (opaque, never printable), these build the SAME tree as
// Langium AST (`callExpr`/`stringLit`/`intLit`/`nameRefExpr`), so the result
// prints to literal `.ddd` source and can be unfolded/ejected like any other
// macro output.  See `docs/proposals/unfoldable-page-scaffolding.md`.
//
// Phase 1 (foundation): the data-light `scaffoldNewForm` shape, proving the
// AST-builder + printability path end to end.  The data-rich builders
// (`scaffoldList` columns + filter bar, `scaffoldDetails` field card +
// related cards) and the compile-path relocation (deleting the ⑤c arms) land
// in later phases, behind a byte-identical gate.

import type { Expression } from "../../../language/generated/ast.js";
import { callExpr, intLit, nameRefExpr, stringLit } from "../../api/index.js";

/** AST twin of `expandScaffoldNewForm` (walker-primitive-expander.ts):
 *  `Stack(Breadcrumbs, Heading "Create <agg>", Card(CreateForm(of:)))`.
 *  Built from the aggregate NAME alone — the create form needs no field
 *  reflection (its fields come from `wireShape(<Agg>.create)` at lower
 *  time), so this is the simplest sentinel to relocate. */
export function scaffoldNewFormBody(aggName: string): Expression {
  const slug = snake(plural(aggName));
  const humanPlural = humanize(plural(aggName));
  const humanAgg = humanize(aggName);
  return callExpr("Stack", [
    {
      value: callExpr("Breadcrumbs", [
        {
          value: callExpr("Anchor", [
            { value: stringLit("Home") },
            { name: "to", value: stringLit("/") },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit(humanPlural) },
            { name: "to", value: stringLit(`/${slug}`) },
          ]),
        },
        { value: callExpr("Text", [{ value: stringLit("New") }]) },
      ]),
    },
    {
      value: callExpr("Heading", [
        { value: stringLit(`Create ${humanAgg.toLowerCase()}`) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("Card", [
        {
          value: callExpr("CreateForm", [
            { name: "of", value: nameRefExpr(aggName) },
            { name: "testid", value: stringLit(`${slug}-new`) },
          ]),
        },
      ]),
    },
    { name: "testid", value: stringLit(`${slug}-new-page`) },
  ]);
}

// Naming helpers — copied verbatim from `_pages.ts` (kept module-local so the
// scaffold macro family doesn't pull in the wider `util/naming` dep graph;
// dedup is a follow-up once the builders consolidate).

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function plural(s: string): string {
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  if (s.endsWith("s")) return s + "es";
  return s + "s";
}

function humanize(s: string): string {
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
