// Chart primitive — a kind-discriminated (line | bar) chart over a GROUPED
// query-time projection (M-T1.3 Phase 4).
//
// WHY EXACTLY ONE PRIMITIVE
// -------------------------
// `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r =>
// r.revenue }` — kind-discriminated rather than separate `LineChart`/
// `BarChart`, so there is one registry entry, one pack template per pack, and
// one a11y contract (the mission's §3.5 call).  v1 is line + bar; anything
// outside the closed set is an `extern component`.
//
// WHY IT RENDERS INLINE, NOT AS A HOISTED COMPONENT
// -------------------------------------------------
// `DataGrid` hoists a child component because it owns framework-reactive
// row-model STATE that cannot live in the page function.  A chart owns none:
// it is a pure render of the projection's rows, so the call site IS the emit
// — same shape as `Table`/`Stat`, through the active pack's `primitive-chart`
// template.
//
// WHAT BINDS THE DATA
// -------------------
// `of:` is a bare projection member (`Sales.SalesByStatus`).  Rendering it
// through `emitExpr` triggers the detector's Pattern H, which hoists the
// query hook (`useSalesByStatus()`) and returns the hook variable; the chart
// reads `<hookVar>.data ?? []` — the parsed LIST response (`z.array` of the
// row schema), an empty chart rather than a crash mid-load.  The `x:`/`y:`
// lambdas unwrap to accessor field STRINGS (the `Column`-accessor unwrap,
// shared from data-grid.ts), which is what the chart library keys on.
//
// Unsupported targets are a COMPILE ERROR, not a blank slot:
// `loom.chart-unsupported-target` (system-checks.ts) rejects `Chart` off
// react + mantine@v9, and the arg gates in ui-checks.ts
// (`loom.chart-of-not-grouped` / `-kind-invalid` / `-accessor-not-field`)
// make the fallbacks below unreachable from valid input.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { addImport } from "../render-primitive.js";
import { lambdaArg, namedArgValue, stringNamed } from "../shared/args.js";
import type { WalkContext } from "../walker-core.js";
import { emitExpr, testidAttr } from "../walker-core.js";
// Shared ctx-free accessor-shape helper — `Chart`'s `x:`/`y:` lambdas unwrap to
// a field string exactly the way a `DataGrid` `Column` accessor does, so both
// read the one leaf rather than each re-deriving it.
import { simpleAccessorField } from "./data-grid-shape.js";

/** Component names only a LINE chart renders, and only a BAR chart renders.
 *  Every OTHER name a pack declares for `primitive-chart` is shared by both
 *  kinds and always imported.  Naming the kind-specific ones (rather than
 *  deriving "everything but the container") keeps a pack free to add shared
 *  recharts pieces — axes, grid, tooltip, `ResponsiveContainer` — without
 *  teaching this filter about each one. */
const LINE_ONLY_COMPONENTS: ReadonlySet<string> = new Set(["LineChart", "Line"]);
const BAR_ONLY_COMPONENTS: ReadonlySet<string> = new Set(["BarChart", "Bar"]);

export function emitChart(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  _depth: number,
): string {
  // `loom.chart-kind-invalid` pins the kind to "line" | "bar"; the bar default
  // only keeps the walker total under programmatic IR that skipped validation.
  const isLine = stringNamed(call, "kind") === "line";

  // Render `of:` through the normal expression path so Pattern H hoists the
  // projection hook and the expression becomes the hook variable.  `.data`
  // mirrors how `QueryView` reaches hook data (`renderQueryDataAccess`'s JSX
  // fallback); `?? []` because the chart renders unconditionally — no
  // loading/empty arms — and the LIST response is undefined until the read
  // resolves.
  const ofArg = namedArgValue(call, "of");
  const queryExpr = ofArg ? emitExpr(ofArg, ctx) : "undefined";

  // `x:`/`y:` unwrap to accessor field strings (`r => r.status` → "status") —
  // the same simple-accessor rule as a DataGrid `Column`, and the shape the
  // chart library keys its category axis (`dataKey`) and series on.  The
  // accessor gate makes an unresolvable lambda unreachable from valid input.
  const dataKey = simpleAccessorField(lambdaArg(call, "x")) ?? "";
  const seriesField = simpleAccessorField(lambdaArg(call, "y")) ?? "";

  // The series is coerced to a NUMBER on the way in, and this is load-bearing
  // rather than defensive: a `money` (or `decimal`) projection field parses
  // client-side into a `Decimal` (`moneySchema` in lib/schemas), and no chart
  // library can plot an object.  `revenue = sum(o.total)` is the single most
  // likely series there is, and left alone it fails DIFFERENTLY per pack —
  // `@mui/x-charts` v7 rejects it at compile time (`Decimal` is not assignable
  // to `DatasetElementType`), while recharts and `@mantine/charts` accept it
  // and then plot NOTHING at runtime.  Coercing here fixes every pack at once,
  // and keeps `dataKey`/`series` a plain string on libraries that require one.
  //
  // `Number()` is right for every series type a chart can carry: `Decimal`
  // stringifies through `valueOf`, and an `int`/`decimal` field is already a
  // number, so this is the identity on them.
  //
  // The row is PROJECTED to just the two plotted columns rather than spread
  // (`...r`).  Spreading carries every OTHER field along, and a sibling money
  // column is still a `Decimal` — enough on its own to fail `@mui/x-charts`'s
  // `dataset` element type even when the plotted series is clean (the second
  // chart on a page hit exactly that).  Projecting also keeps the emitted data
  // to what the chart actually reads.
  const seriesCoerced = `${seriesField}: Number(r.${seriesField})`;
  // A chart keyed and seriesed on the SAME field would repeat the key in the
  // object literal — a duplicate-key lint failure in the generated project —
  // so the coerced one stands alone.
  const rowLiteral =
    dataKey === seriesField ? seriesCoerced : `${dataKey}: r.${dataKey}, ${seriesCoerced}`;
  const dataExpr = `(${queryExpr}.data ?? []).map((r) => ({ ${rowLiteral} }))`;

  // A chart is an image of data (a11y contract `role="img"` + `needsName`), so
  // the wrapper carries a derived accessible name — the projection + series,
  // mirroring DataGrid's hand-authored aria-labels.
  const projName = ofArg?.kind === "member" ? ofArg.member : "projection";
  const ariaLabel = `${isLine ? "Line" : "Bar"} chart of ${projName}: ${seriesField} by ${dataKey}`;

  // The pack manifest declares BOTH kinds' components for `primitive-chart`
  // (the template is kind-discriminated), but only one renders per call site —
  // importing the other would trip the generated-code `noUnusedImports` lint.
  // So the imports merge here is renderPrimitive's, minus the unused kind.
  //
  // Which names are kind-specific depends on the pack's charting library, not
  // just on the container component: a `@mantine/charts` / `@mui/x-charts` pack
  // names only `LineChart`/`BarChart`, but a recharts pack (shadcn, chakra)
  // also imports the per-kind MARK — `Line` / `Bar` — alongside shared pieces
  // (`ResponsiveContainer`, axes, grid, tooltip) that both kinds render.  So
  // the filter is a per-kind NAME SET, not one component.
  const unusedComponents = isLine ? BAR_ONLY_COMPONENTS : LINE_ONLY_COMPONENTS;
  for (const spec of ctx.pack.manifest.imports?.["primitive-chart"] ?? []) {
    const named = spec.named.filter((n) => !unusedComponents.has(n));
    if (named.length > 0) addImport(ctx, spec.from, ...named);
  }
  return ctx.pack.render("primitive-chart", {
    isLine,
    dataExpr,
    dataKey,
    seriesField,
    ariaLabel,
    testidAttr: testidAttr(call, ctx),
  });
}
