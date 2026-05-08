// ---------------------------------------------------------------------------
// View-model preparer for the per-view table page.  Cells reuse the
// page-list cell-* templates by binding `valueExpr` to `row.<col>`
// and `testIdExpr` to a view-scoped indexed string (`view-<slug>-
// row-${idx}-<col>`).  Same VM shape as ListPageVM cells; the
// renderer just iterates a different Tr scope (q.data.map((row, idx))).
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  TypeIR,
  ViewIR,
} from "../../../../ir/loom-ir.js";
import { humanize, plural, snake } from "../../../../util/naming.js";
import type { CellVM, ViewTablePageVM } from "../view-models.js";

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function unwrapOpt(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

interface Column {
  name: string;
  accessPath: string;
  kind: string;
  linkTargetSlug?: string;
}

export function prepareViewTablePageVM(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): ViewTablePageVM {
  const slug = snake(view.name);
  const columns = collectColumns(view, ctx, aggregatesByName);
  const cells: CellVM[] = columns.map((c) => cellVMForColumn(slug, c));
  return {
    componentName: `${pascal(view.name)}ViewPage`,
    hookName: `use${pascal(view.name)}View`,
    slug,
    humanView: humanize(view.name),
    columnHeaders: columns.map((c) => humanize(c.name)),
    cells,
  };
}

function cellVMForColumn(slug: string, c: Column): CellVM {
  const testIdExpr = `\`view-${slug}-row-\${idx}-${c.name}\``;
  const valueExpr = `row.${c.accessPath}`;
  if (c.linkTargetSlug) {
    return {
      template: "cell-id-link",
      testIdExpr,
      valueExpr,
      toExpr: `\`/${c.linkTargetSlug}/\${${valueExpr}}\``,
    };
  }
  if (c.kind === "datetime") return { template: "cell-datetime", testIdExpr, valueExpr };
  if (c.kind === "bool") return { template: "cell-bool", testIdExpr, valueExpr };
  if (c.kind === "int" || c.kind === "long") return { template: "cell-number", testIdExpr, valueExpr, decimals: 0 };
  if (c.kind === "decimal") return { template: "cell-number", testIdExpr, valueExpr, decimals: 2 };
  if (c.kind === "enum") return { template: "cell-enum", testIdExpr, valueExpr };
  if (c.kind === "id") return { template: "cell-id", testIdExpr, valueExpr };
  return { template: "cell-string", testIdExpr, valueExpr };
}

function collectColumns(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): Column[] {
  const columnKind = (t: TypeIR): string => {
    const inner = unwrapOpt(t);
    if (inner.kind === "primitive") return inner.name;
    return inner.kind;
  };
  if (view.output) {
    return view.output.fields.map((f) => {
      const inner = unwrapOpt(f.type);
      const linkTargetSlug =
        inner.kind === "id" && aggregatesByName.has(inner.targetName)
          ? snake(plural(inner.targetName))
          : undefined;
      return {
        name: f.name,
        accessPath: f.name,
        kind: columnKind(f.type),
        linkTargetSlug,
      };
    });
  }
  const agg = ctx.aggregates.find((a) => a.name === view.aggregateName);
  if (!agg) return [{ name: "id", accessPath: "id", kind: "string" }];
  const cols: Column[] = [{ name: "id", accessPath: "id", kind: "string" }];
  for (const f of agg.fields) {
    const inner = unwrapOpt(f.type);
    if (
      inner.kind === "primitive" ||
      inner.kind === "enum" ||
      inner.kind === "id"
    ) {
      cols.push({
        name: f.name,
        accessPath: f.name,
        kind: columnKind(f.type),
        linkTargetSlug:
          inner.kind === "id" && aggregatesByName.has(inner.targetName)
            ? snake(plural(inner.targetName))
            : undefined,
      });
    }
  }
  return cols;
}
