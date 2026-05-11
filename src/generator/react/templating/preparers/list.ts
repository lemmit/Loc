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
import type { ColumnVM, ListPageVM } from "../view-models.js";

export function prepareListPageVM(
  agg: AggregateIR,
  aggregatesByName: Map<string, AggregateIR>,
): ListPageVM {
  const slug = snake(plural(agg.name));

  // Leading row-id-link column.
  const columns: ColumnVM[] = [];
  columns.push({
    key: "id",
    title: "Id",
    kind: "row-id-link",
    testIdExpr: `\`${slug}-row-\${row.id}-link\``,
    valueExpr: "row.id",
    toExpr: `\`/${slug}/\${row.id}\``,
  });

  // One column per primitive-like field.
  for (const f of agg.fields) {
    if (isPrimitiveLike(f.type)) {
      columns.push(columnForField(slug, f, aggregatesByName));
    }
  }

  return {
    aggregateName: agg.name,
    slug,
    humanPlural: humanize(plural(agg.name)),
    humanPluralLower: humanize(plural(agg.name)).toLowerCase(),
    humanSingularLower: humanize(agg.name).toLowerCase(),
    breadcrumbs: [
      { label: "Home", to: "/" },
      { label: humanize(plural(agg.name)) },
    ],
    columns,
    hookName: `useAll${plural(agg.name)}`,
    hookImportPath: `../../api/${camel(agg.name)}`,
  };
}

/** Pick a column descriptor for a single aggregate field.  Mirrors the
 *  per-type branching the legacy cellForField encoded; encapsulates it
 *  as data so the template doesn't need any of these decisions. */
function columnForField(
  slug: string,
  f: FieldIR,
  aggregatesByName: Map<string, AggregateIR>,
): ColumnVM {
  const t = unwrapOpt(f.type);
  const testIdExpr = `\`${slug}-row-\${row.id}-${f.name}\``;
  const valueExpr = `row.${f.name}`;
  const title = humanize(f.name);
  const key = f.name;

  if (t.kind === "enum") {
    return { key, title, kind: "enum", testIdExpr, valueExpr };
  }
  if (t.kind === "id") {
    if (aggregatesByName.has(t.targetName)) {
      const target = snake(plural(t.targetName));
      return {
        key,
        title,
        kind: "id-link",
        testIdExpr,
        valueExpr,
        toExpr: `\`/${target}/\${${valueExpr}}\``,
      };
    }
    return { key, title, kind: "id", testIdExpr, valueExpr };
  }
  if (t.kind === "primitive" && t.name === "datetime") {
    return { key, title, kind: "datetime", testIdExpr, valueExpr };
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return { key, title, kind: "bool", testIdExpr, valueExpr };
  }
  if (t.kind === "primitive" && (t.name === "int" || t.name === "long")) {
    return { key, title, kind: "number", testIdExpr, valueExpr, decimals: 0 };
  }
  if (t.kind === "primitive" && t.name === "decimal") {
    return { key, title, kind: "number", testIdExpr, valueExpr, decimals: 2 };
  }
  // *Id string heuristic — same treatment as a real Id<X> when the
  // suffix-derived target aggregate is known to this deployable.
  const heur = stringIdHeuristic(f.name, t as { kind: string; name?: string }, aggregatesByName);
  if (heur) {
    const target = snake(plural(heur.targetName));
    return {
      key,
      title,
      kind: "id-link",
      testIdExpr,
      valueExpr,
      toExpr: `\`/${target}/\${${valueExpr}}\``,
    };
  }
  return { key, title, kind: "string", testIdExpr, valueExpr };
}

// Re-export TypeIR as the local cell-typing surface.  Avoids dragging
// the IR module into pack code.
export type { TypeIR };
