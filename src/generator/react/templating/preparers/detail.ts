// ---------------------------------------------------------------------------
// View-model preparer for the aggregate detail page.
//
// Mirrors the legacy buildDetailPage in pages-builder.ts: page header
// (display-field title + breadcrumbs + type eyebrow + id chip),
// per-field info card with humanised labels, nested part-tables for
// `contains` collections, operation buttons grouped to the right.
//
// Operation modal-form functions (function openXModal + function
// XForm) are pre-rendered via the legacy renderOperationModalFn for
// now and slotted into the page VM as `operationsModalsTsx`.  Phase
// 1.4 ports those to template-driven emission too.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  FieldIR,
  ParamIR,
} from "../../../../ir/loom-ir.js";
import { camel, humanize, plural, snake } from "../../../../util/naming.js";
import {
  componentsForFields,
  idTargetsInFields,
  isPrimitiveLike,
  needsController,
  unwrapOpt,
} from "../../form-helpers.js";
import { iconForOp, stringIdHeuristic } from "../../pages-builder.js";
import type {
  ColumnVM,
  DetailPageVM,
  FieldRowVM,
  OperationButtonVM,
  PartTableVM,
} from "../view-models.js";

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function prepareDetailPageVM(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): DetailPageVM {
  const slug = snake(plural(agg.name));
  const ops = agg.operations.filter((o) => o.visibility === "public");
  const humanAgg = humanize(agg.name);
  const humanPlural = humanize(plural(agg.name));

  // Title binds to the display-marked field when present, else a
  // short id slice.  Same heuristic as the legacy builder.
  const displayField = agg.fields.find((f) => f.display);
  const titleExpr = displayField
    ? `data.${displayField.name}`
    : `data.id.slice(0, 8) + "…"`;

  // Field rows for the info card.
  const fieldRows: FieldRowVM[] = agg.fields.map((f) =>
    fieldRowVM(slug, f, ctx, aggregatesByName),
  );

  // Nested part-tables for `contains` collections.  Cells reuse the
  // page-list cell templates — same wire shape, different testid
  // prefix and access scope.
  const parts: PartTableVM[] = [];
  for (const c of agg.contains) {
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) continue;
    if (!c.collection) {
      // Non-collection parts render as a JSON dump in the legacy
      // builder; preserve that for parity.  Modelled as a single
      // "raw" part with no cells — the template renders the JSON
      // fallback.  Phase 1.3 doesn't add new functionality here.
      parts.push(rawObjectPart(slug, c.name));
      continue;
    }
    parts.push(collectionPartVM(slug, part, c.name, aggregatesByName));
  }

  // Operation buttons — first one filled, rest light, with verb-mapped icons.
  const opButtons: OperationButtonVM[] = ops.map((op, i) => ({
    name: op.name,
    humanName: humanize(op.name),
    variant: i === 0 ? "filled" : "light",
    icon: iconForOp(op.name),
    testId: `${slug}-op-${op.name}`,
  }));

  // Tabler icons — alert / not-found always; op icons added per-op.
  const opIcons = [
    ...new Set(
      ops.map((op) => iconForOp(op.name)).filter((v): v is string => Boolean(v)),
    ),
  ].sort();
  const tablerIcons = ["IconAlertCircle", "IconAlertTriangle", ...opIcons]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  // API import lines.
  const opHookImports = ops
    .map((op) => `use${pascal(op.name)}${agg.name}`)
    .join(", ");
  const reqImports = ops.map((op) => `${pascal(op.name)}Request`).join(", ");
  const apiImportLines: string[] = [];
  apiImportLines.push(
    `import { use${agg.name}ById${ops.length > 0 ? `, ${opHookImports}` : ""}${reqImports.length > 0 ? `, ${reqImports}` : ""} } from "../../api/${camel(agg.name)}";`,
  );
  // Cross-aggregate useAll<X>() hooks for op-param Id<X> selects.
  const detailIdTargets = idTargetsInFields(
    ops.flatMap((o: { params: ParamIR[] }) => o.params.map((p) => ({ type: p.type }))),
    ctx,
    aggregatesByName,
  );
  for (const t of detailIdTargets) {
    apiImportLines.push(
      `import { useAll${plural(t.name)} } from "../../api/${camel(t.name)}";`,
    );
  }

  // Per-op mutation hook calls (one const per op, inside the page
  // function body).
  const opHookCallLines = ops.map(
    (op) => `  const ${camel(op.name)} = use${pascal(op.name)}${agg.name}(id ?? "");`,
  );

  // RHF imports — Controller needed when any op param requires it.
  const opFields = ops.flatMap((o: { params: ParamIR[] }) =>
    o.params.map((p) => ({ type: p.type })),
  );
  const needsCtrl = needsController(opFields, ctx);

  // Operation modal functions are rendered by the renderer (which
  // calls renderOperationModal once per op via the pack's
  // operation-modal template).  Phase 1.4 ports the modal forms
  // out of the legacy renderOperationModalFn.  Preparer stops
  // pre-rendering — keeping a thin contract: VMs carry data, the
  // render orchestrator owns the per-pack composition.
  const operationsModalsTsx: string[] = [];

  // Sanity helper: componentsForFields drives the Mantine import
  // line in the legacy builder.  In template-pack rendering the
  // Mantine page-detail.hbs hardcodes the union (Stack / Title /
  // Card / Group / Button / Text / Skeleton / Alert / Anchor /
  // Breadcrumbs / Badge / Table / TextInput / NumberInput / etc.)
  // since strict tsc tolerates unused imports here (jsx="react-jsx",
  // noUnusedLocals=false in the generated tsconfig).  This helper
  // call stays as a future hook for tighter import tracking.
  void componentsForFields(opFields, ctx);

  return {
    aggregateName: agg.name,
    aggregateNameCamel: camel(agg.name),
    slug,
    humanAgg,
    humanAggLower: humanAgg.toLowerCase(),
    humanPlural,
    titleExpr,
    fieldRows,
    parts,
    opButtons,
    apiImportLines,
    tablerIcons,
    needsController: needsCtrl,
    operationsModalsTsx,
    opHookCallLines,
  };
}

// ---------------------------------------------------------------------------
// Field-row VM construction — picks a `field-row-*` template per
// type, returns a minimal VM the template renders.
// ---------------------------------------------------------------------------

function fieldRowVM(
  slug: string,
  f: FieldIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
): FieldRowVM {
  const t = unwrapOpt(f.type);
  const testId = `${slug}-detail-${f.name}`;
  const label = humanize(f.name);
  const valueExpr = `data.${f.name}`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (vo) {
      const voFields = vo.fields.map((vf) => ({
        humanLabel: humanize(vf.name),
        testId: `${testId}-${vf.name}`,
        valueExpr: `${valueExpr}.${vf.name}`,
      }));
      return {
        template: "field-row-valueobject",
        label,
        testId,
        valueExpr,
        voFields,
      };
    }
  }
  if (t.kind === "enum") {
    return { template: "field-row-enum", label, testId, valueExpr };
  }
  if (t.kind === "id") {
    if (aggregatesByName.has(t.targetName)) {
      const target = snake(plural(t.targetName));
      return {
        template: "field-row-id-link",
        label,
        testId,
        valueExpr,
        toExpr: `\`/${target}/\${${valueExpr}}\``,
      };
    }
    return { template: "field-row-id", label, testId, valueExpr };
  }
  if (t.kind === "primitive" && t.name === "datetime") {
    return { template: "field-row-datetime", label, testId, valueExpr };
  }
  if (t.kind === "primitive" && t.name === "bool") {
    return { template: "field-row-bool", label, testId, valueExpr };
  }
  if (t.kind === "primitive" && (t.name === "int" || t.name === "long")) {
    return { template: "field-row-number", label, testId, valueExpr, decimals: 0 };
  }
  if (t.kind === "primitive" && t.name === "decimal") {
    return { template: "field-row-number", label, testId, valueExpr, decimals: 2 };
  }
  // *Id heuristic for plain string fields named <Aggregate>Id.
  const heur = stringIdHeuristic(f.name, t as { kind: string; name?: string }, aggregatesByName);
  if (heur) {
    const target = snake(plural(heur.targetName));
    return {
      template: "field-row-id-link",
      label,
      testId,
      valueExpr,
      toExpr: `\`/${target}/\${${valueExpr}}\``,
    };
  }
  return { template: "field-row-string", label, testId, valueExpr };
}

// ---------------------------------------------------------------------------
// Part-table VM construction — reuses page-list cell templates so a
// pack only writes one cell-* set, not two.
// ---------------------------------------------------------------------------

function collectionPartVM(
  slug: string,
  part: EntityPartIR,
  name: string,
  aggregatesByName: Map<string, AggregateIR>,
): PartTableVM {
  const partFields = part.fields.filter((f) => isPrimitiveLike(f.type));
  const cols = ["id", ...partFields.map((f) => f.name)];
  const columns: ColumnVM[] = cols.map((c) =>
    partColumnVM(slug, name, c, partFields, aggregatesByName),
  );
  return {
    name,
    humanName: humanize(name),
    columns,
    testId: `${slug}-detail-${name}`,
    arrayExpr: `data.${name}`,
  };
}

function partColumnVM(
  slug: string,
  partName: string,
  col: string,
  partFields: FieldIR[],
  aggregatesByName: Map<string, AggregateIR>,
): ColumnVM {
  const testIdExpr = `\`${slug}-detail-${partName}-row-\${row.id}-${col}\``;
  const valueExpr = `row.${col}`;
  const key = col;
  const title = humanize(col);
  if (col === "id") {
    return { key, title, kind: "id", testIdExpr, valueExpr };
  }
  const fld = partFields.find((f) => f.name === col);
  if (fld) {
    const t = unwrapOpt(fld.type);
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
    if (t.kind === "enum") {
      return { key, title, kind: "enum", testIdExpr, valueExpr };
    }
    const heur = stringIdHeuristic(col, t as { kind: string; name?: string }, aggregatesByName);
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
  }
  return { key, title, kind: "string", testIdExpr, valueExpr };
}

function rawObjectPart(slug: string, name: string): PartTableVM {
  // Sentinel: no columns.  Template falls back to a JSON dump for
  // these single-instance parts.  arrayExpr is the access path on
  // `data` for the JSON.stringify() call.
  return {
    name,
    humanName: humanize(name),
    columns: [],
    testId: `${slug}-detail-${name}`,
    arrayExpr: `data.${name}`,
  };
}
