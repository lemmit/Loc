// ---------------------------------------------------------------------------
// View-model preparer for aggregate list pages.
//
// Mirrors the decisions the legacy buildListPage in pages-builder.ts
// makes: column ordering, humanised headers, per-cell formatter
// choice (id-link vs datetime vs bool vs number vs enum vs string),
// link-target resolution for Id<X> fields and the *Id string heuristic.
//
// The preparer returns a plain JSON view-model.  Pack templates
// render against it; no design-system specifics leak in here.
// ---------------------------------------------------------------------------

import type { AggregateIR, FieldIR, TypeIR } from "../../../../ir/loom-ir.js";
import { camel, humanize, plural, snake } from "../../../../util/naming.js";
import { isPrimitiveLike, unwrapOpt } from "../../form-helpers.js";
import { stringIdHeuristic } from "../../pages-builder.js";
import type { CellVM, ListPageVM } from "../view-models.js";

export function prepareListPageVM(
  agg: AggregateIR,
  aggregatesByName: Map<string, AggregateIR>,
): ListPageVM {
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanPluralLower = humanPlural.toLowerCase();
  const humanSingularLower = humanize(agg.name).toLowerCase();
  // Column headers: leading "Id" plus one per primitive-like field.
  const columnHeaders: string[] = ["Id"];
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) columnHeaders.push(humanize(f.name));
  }
  // Cells: leading row-id-link, then one per primitive-like field.
  const cells: CellVM[] = [];
  // Leading row-id link: targets the row's own detail page.  Distinct
  // from `cell-id-link` because (a) row.id is non-null by invariant
  // so no nullish guard is needed, (b) the testid lands on the
  // Anchor with a "-link" suffix instead of on the Table.Td, (c) no
  // stop-propagation since the row-level click handler navigates to
  // the same URL anyway.
  cells.push({
    template: "cell-row-id-link",
    testIdExpr: `\`${slug}-row-\${row.id}-link\``,
    valueExpr: "row.id",
    toExpr: `\`/${slug}/\${row.id}\``,
  });
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) cells.push(cellForField(slug, f, aggregatesByName));
  }
  return {
    aggregateName: agg.name,
    slug,
    humanPlural,
    humanPluralLower,
    humanSingularLower,
    breadcrumbs: [
      { label: "Home", to: "/" },
      { label: humanPlural },
    ],
    columnHeaders,
    cells,
    hookName: `useAll${plural(agg.name)}`,
    hookImportPath: `../../api/${camel(agg.name)}`,
  };
}

/** Pick a cell template + assemble its VM for a single aggregate
 *  field.  Mirrors the per-type branching the legacy displayCellExpr
 *  encodes; encapsulates it as data so the template doesn't need
 *  any of these decisions. */
function cellForField(
  slug: string,
  f: FieldIR,
  aggregatesByName: Map<string, AggregateIR>,
): CellVM {
  const t = unwrapOpt(f.type);
  const testIdExpr = `\`${slug}-row-\${row.id}-${f.name}\``;
  const valueExpr = `row.${f.name}`;
  if (t.kind === "enum") {
    return { template: "cell-enum", testIdExpr, valueExpr };
  }
  if (t.kind === "id") {
    if (aggregatesByName.has(t.targetName)) {
      const target = snake(plural(t.targetName));
      return {
        template: "cell-id-link",
        testIdExpr,
        valueExpr,
        toExpr: `\`/${target}/\${${valueExpr}}\``,
      };
    }
    return { template: "cell-id", testIdExpr, valueExpr };
  }
  if (t.kind === "primitive" && t.name === "datetime") {
    return { template: "cell-datetime", testIdExpr, valueExpr };
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return { template: "cell-bool", testIdExpr, valueExpr };
  }
  if (t.kind === "primitive" && (t.name === "int" || t.name === "long")) {
    return { template: "cell-number", testIdExpr, valueExpr, decimals: 0 };
  }
  if (t.kind === "primitive" && t.name === "decimal") {
    return { template: "cell-number", testIdExpr, valueExpr, decimals: 2 };
  }
  // *Id string heuristic — same treatment as a real Id<X> when the
  // suffix-derived target aggregate is known to this deployable.
  // `stringIdHeuristic` is exported from pages-builder for reuse.
  const heur = stringIdHeuristic(f.name, t as { kind: string; name?: string }, aggregatesByName);
  if (heur) {
    const target = snake(plural(heur.targetName));
    return {
      template: "cell-id-link",
      testIdExpr,
      valueExpr,
      toExpr: `\`/${target}/\${${valueExpr}}\``,
    };
  }
  return { template: "cell-string", testIdExpr, valueExpr };
}

// Re-export TypeIR as the local cell-typing surface.  Avoids dragging
// the IR module into pack code.
export type { TypeIR };
