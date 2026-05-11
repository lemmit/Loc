// ---------------------------------------------------------------------------
// View-model preparer for the per-view table page.  Columns carry semantic
// descriptors so pack templates can dispatch to cell partials directly via
// `{{> (concat "cell-" kind)}}` without TS-side pre-rendering.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  TypeIR,
  ViewIR,
} from "../../../../ir/loom-ir.js";
import { humanize, plural, snake } from "../../../../util/naming.js";
import type { ColumnVM, ViewTablePageVM } from "../view-models.js";

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
  const rawCols = collectColumns(view, ctx, aggregatesByName);
  const columns: ColumnVM[] = rawCols.map((c) => columnVMForColumn(slug, c));
  return {
    componentName: `${pascal(view.name)}ViewPage`,
    hookName: `use${pascal(view.name)}View`,
    slug,
    humanView: humanize(view.name),
    columns,
  };
}

function columnVMForColumn(slug: string, c: Column): ColumnVM {
  const testIdExpr = `\`view-${slug}-row-\${idx}-${c.name}\``;
  const valueExpr = `row.${c.accessPath}`;
  const key = c.name;
  const title = humanize(c.name);

  if (c.linkTargetSlug) {
    return {
      key,
      title,
      kind: "id-link",
      testIdExpr,
      valueExpr,
      toExpr: `\`/${c.linkTargetSlug}/\${${valueExpr}}\``,
    };
  }
  if (c.kind === "datetime") return { key, title, kind: "datetime", testIdExpr, valueExpr };
  if (c.kind === "bool") return { key, title, kind: "bool", testIdExpr, valueExpr };
  if (c.kind === "int" || c.kind === "long") return { key, title, kind: "number", testIdExpr, valueExpr, decimals: 0 };
  if (c.kind === "decimal") return { key, title, kind: "number", testIdExpr, valueExpr, decimals: 2 };
  if (c.kind === "enum") return { key, title, kind: "enum", testIdExpr, valueExpr };
  if (c.kind === "id") return { key, title, kind: "id", testIdExpr, valueExpr };
  return { key, title, kind: "string", testIdExpr, valueExpr };
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
