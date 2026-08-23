// -------------------------------------------------------------------------
// System-level checks — datasource coverage / saving-shape / capability
// wiring, per-backend support gates (Dapper, MikroORM), resource config,
// auth + permission registration, inheritance + event-sourced storage.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import {
  platformFamily,
  platformOwnsBackend,
  platformSavingShapes,
} from "../../../language/validators/data/platform-rules.js";
import { descriptorFor } from "../../../platform/metadata.js";
import { FLUTTER_DEFERRED_BUILDER_NAMES } from "../../../util/flutter-deferred-primitives.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import {
  capabilitiesFor,
  configSchemaFor,
  supportsSurfaceKind,
} from "../../../util/source-types.js";
import { pagedReturn } from "../../stdlib/generics.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ConfigEntryIR,
  ConfigValueIR,
  DataSourceIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedLoomModel,
  EnrichedSystemIR,
  ExprIR,
  FunctionIR,
  OperationIR,
  Platform,
  SavingShape,
  StmtIR,
  SubdomainIR,
  SystemIR,
  TypeIR,
  UiIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import {
  exprUsesCurrentUser,
  isGroupedProjection,
  isQueryTimeProjection,
  stmtUsesCurrentUser,
} from "../../types/loom-ir.js";
import { isMacroEmitted } from "../../types/origin.js";
import { backendServesRealtime } from "../../util/channels.js";
import { bodyUsesChart } from "../../util/chart.js";
import { dataGridHosts } from "../../util/data-grid.js";
import { aggregateFileField } from "../../util/file-field.js";
import {
  firstUnlowerableForAdapter,
  isFindPredicateAdapter,
} from "../../util/find-predicate-capability.js";
import { readableProjectionNames } from "../../util/projection-read.js";
import { opHasProvSite } from "../../util/prov-id.js";
import { dapperQueryProjectionGap } from "../../util/query-projection-arm.js";
import {
  dataSourceKindForAggregate,
  effectiveSavingShape,
  isDocumentShaped,
  resolveDataSourceConfig,
} from "../../util/resolve-datasource.js";
import { isDeepScopeFilter } from "../../util/tenant-stance.js";
import { walkExprDeep, walkWorkflowStmtExprsDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { firstNonGateRef, GATE_ALLOWED_REFS } from "./query-checks.js";
import { walkExpr } from "./shared.js";
import { validateE2ETest } from "./test-checks.js";

// ---------------------------------------------------------------------------
// `X id` validation for React deployables.
//
// The React form generator renders an `X id` form field as a `<Select>`
// populated by `useAll<X>()` with the target aggregate's `display`-marked
// field as the option label.  Two preconditions must hold for the form
// to be usable:
//
//   1. The target aggregate has a `display` field (otherwise no option
//      label can be derived; the generator falls back to a `<TextInput>`
//      with a placeholder explaining the gap, but the user only sees
//      that at render time).
//   2. The target aggregate is mounted by this deployable's targeted
//      backend (otherwise `useAll<X>()` is not importable and the API
//      can't fetch the list).
//
// We check both up-front per react deployable.  Backends-only
// deployables don't trigger these checks — `X id` on the wire is
// just a string/uuid and doesn't depend on a display label.
// ---------------------------------------------------------------------------

// `auth: ui` (the frontend OIDC guard) is emitted by the React, Vue, Svelte,
// Angular and Feliz generators (`generator/feliz/auth-gate.ts` — the Elmish
// session model + `AuthGate` view, driven end-to-end by the `authgate`
// scenario in `generated-feliz-build.yml`).  A deployable whose resolved UI
// framework is none of those (flutter) would silently emit no guard — reject
// it loudly so the limitation is visible rather than a no-op.
const AUTH_UI_FRAMEWORKS = new Set(["react", "vue", "svelte", "angular", "feliz"]);

// paged-run (paged-queryHandler): a `queryHandler H(...): <Agg> paged` is
// emitted by each backend whose explicit-handler emitter has grown the paged
// branch (mirroring Hono's `emitPagedRunHandler`).  A backend NOT in
// `PAGED_QH_SUPPORTED` would crash on the `paged` generic carrier at its
// return-type render, so gate a paged queryHandler hosted on such a deployable
// with an honest diagnostic until its emitter fans out — a reviewed gap rather
// than a silent codegen crash.
const PAGED_QH_SUPPORTED = new Set(["node", "python", "java", "dotnet", "elixir"]);

// query-time projection (read-path-architecture.md rev.13): the always-current
// read model (`projection X { from … where … join … select … }`, no folds) is
// emitted by each backend whose emitter has ported the query-time read.
// A backend NOT in `PROJECTION_QT_SUPPORTED` has no emitter for it, so gate a
// query-time projection hosted on such a deployable with an honest diagnostic
// until its port lands — the same reviewed-gap discipline as the paged gate.
// All five backends have ported it: node (PR-C), python (PR-D), elixir (PR-E),
// java (PR-F), dotnet (PR-G).
const PROJECTION_QT_SUPPORTED = new Set(["node", "python", "elixir", "java", "dotnet"]);

// Whole-table aggregation in a query-time projection's `select`
// (`select orders = count`, `select revenue = sum(o.total)`) — the SINGLETON
// read model of read-path-architecture.md rev. 8, whose motivating use is a
// dashboard total / running count.  It pushes the aggregation down to SQL
// (`COUNT(*)` / `SUM(col)`) instead of loading and folding rows, so it is a
// distinct emit path from the per-row `select` every backend already renders.
// Backends in `PROJECTION_AGG_SUPPORTED` have ported it; the rest gate HONESTLY
// rather than emit the operator name as a free identifier.  Same reviewed-gap
// discipline as `validateQueryTimeProjectionBackend` above; node is first.
// All five backends now emit the SQL push-down (node #1, then python / dotnet /
// java / elixir).  The set is kept — not deleted — because it is the seam a new
// backend gates on until it ports, and the diagnostic below is its message.
const PROJECTION_AGG_SUPPORTED = new Set(["node", "python", "dotnet", "java", "elixir"]);

export function validateWholeTableAggregationBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_AGG_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        for (const s of p.query?.selects ?? []) {
          if (!s.aggregate) continue;
          diags.push({
            severity: "error",
            code: "loom.projection-whole-table-aggregation-unsupported",
            message: diagMessage("loom.projection-whole-table-aggregation-unsupported", {
              name: p.name,
              field: s.field,
              op: s.aggregate.op,
              dName: d.name,
              platform: d.platform,
            }),
            source: `${c.name}/${p.name}`,
          });
        }
      }
    }
  }
}

// GROUPED projection (`group by`, M-T4.2) — one row per distinct grouping-key
// combination, aggregates computed per group in SQL, the LIST response shape.
// A distinct emit arm from both the singleton aggregation (one row) and the
// per-row read (rows mapped in the app), so a new backend gates on it
// separately until its port lands — the same reviewed-gap discipline as
// `PROJECTION_AGG_SUPPORTED` above.  All five current backends emit it.
const PROJECTION_GROUPBY_SUPPORTED = new Set(["node", "python", "dotnet", "java", "elixir"]);

export function validateGroupedProjectionBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_GROUPBY_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (!isGroupedProjection(p)) continue;
        diags.push({
          severity: "error",
          code: "loom.projection-groupby-unsupported-backend",
          message: diagMessage("loom.projection-groupby-unsupported-backend", {
            name: p.name,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

export function validatePagedQueryHandlerBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    // Only backend platforms emit application-layer handlers; the ones in
    // `PAGED_QH_SUPPORTED` render the paged branch.  Frontends / non-backend
    // platforms are skipped (they host no handlers).
    if (!platformOwnsBackend(d.platform) || PAGED_QH_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const h of c.queryHandlers ?? []) {
        if (!pagedReturn(h.returnType)) continue;
        diags.push({
          severity: "error",
          code: "loom.paged-query-handler-unsupported-backend",
          message: diagMessage("loom.paged-query-handler-unsupported-backend", {
            name: h.name,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${h.name}`,
        });
      }
    }
  }
}

export function validateQueryTimeProjectionBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    // Only backend platforms emit read routes; the ones in
    // `PROJECTION_QT_SUPPORTED` have ported the query-time emit.  Frontends /
    // non-backend platforms host no read model and are skipped.
    if (!platformOwnsBackend(d.platform) || PROJECTION_QT_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (!isQueryTimeProjection(p)) continue;
        diags.push({
          severity: "error",
          code: "loom.projection-query-time-unsupported",
          message: diagMessage("loom.projection-query-time-unsupported", {
            name: p.name,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

// A query-time projection sourced `from <Workflow>` (its persisted instance /
// saga-state rows, `instanceWireShape`) reads the workflow store, not an
// aggregate repository — a distinct per-backend emit path.  Backends in
// `PROJECTION_WF_SOURCE_SUPPORTED` have ported it; others gate the read HONESTLY
// (rather than emit a broken reference to a non-existent workflow repository)
// until their port lands.  Mirrors `validateQueryTimeProjectionBackend`.
const PROJECTION_WF_SOURCE_SUPPORTED = new Set(["node", "python", "java", "dotnet", "elixir"]);

export function validateWorkflowSourceProjectionBackend(
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_WF_SOURCE_SUPPORTED.has(d.platform))
      continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (p.query?.sourceKind !== "workflow") continue;
        diags.push({
          severity: "error",
          code: "loom.projection-workflow-source-unsupported-backend",
          message: diagMessage("loom.projection-workflow-source-unsupported-backend", {
            name: p.name,
            source: p.query.source,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

// A query-time projection sourced `from <OtherProjection>` reads that
// projection's persisted `<Proj>Row` read-model table, not an aggregate
// repository — a distinct per-backend emit path.  Backends in
// `PROJECTION_PROJ_SOURCE_SUPPORTED` have ported it; others gate the read
// HONESTLY until their port lands.  Mirrors `validateWorkflowSourceProjectionBackend`.
const PROJECTION_PROJ_SOURCE_SUPPORTED = new Set(["node", "python", "java", "dotnet", "elixir"]);

export function validateProjectionSourceProjectionBackend(
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_PROJ_SOURCE_SUPPORTED.has(d.platform))
      continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (p.query?.sourceKind !== "projection") continue;
        diags.push({
          severity: "error",
          code: "loom.projection-source-unsupported-backend",
          message: diagMessage("loom.projection-source-unsupported-backend", {
            name: p.name,
            source: p.query.source,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

/** Frontends whose walker emits the `DataGrid` primitive.
 *
 *  The membership rule is D-DATAGRID-TARGETS: a frontend ships `DataGrid` iff
 *  it can run **TanStack Table** itself — not iff it emits JSX, and not iff its
 *  UI kit happens to have a grid widget.  `DataGrid` IS a TanStack row model
 *  behind the `renderDataGridChild` seam, so any other way of satisfying it
 *  forks the behaviour the seam exists to share.  Feliz qualifies because Fable
 *  compiles F# to JavaScript (it binds `@tanstack/table-core` directly, as the
 *  Svelte target does); Flutter never will, because its shipping target is a
 *  native build with no JS runtime.
 *
 *  Using it elsewhere is a COMPILE ERROR rather than a silently missing grid:
 *  the page would otherwise render an empty slot (or a "not supported" comment
 *  on HEEx) and the author would only find out by looking at the running app. */
const DATA_GRID_FRAMEWORKS = new Set<string>(["react", "vue", "svelte", "angular", "feliz"]);

/** `DataGrid` on a frontend that can't render it (M-T1.1 follow-on). */
export function validateDataGridFramework(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    for (const { ui, fw } of mountedUis(sys, d)) {
      if (DATA_GRID_FRAMEWORKS.has(fw)) continue;
      // Pages AND components — a grid moved into a component is just as
      // unrenderable, and `dataGridHosts` is the same scan the Feliz emitter
      // uses to decide whether to ship `@tanstack/table-core`.
      for (const what of dataGridHosts(ui)) {
        diags.push({
          severity: "error",
          code: "loom.datagrid-unsupported-target",
          message: diagMessage("loom.datagrid-unsupported-target", {
            what,
            dName: d.name,
            fw: fw || "unknown",
          }),
          source: `${ui.name}/${what}`,
        });
      }
    }
  }
}

/** Every ui a deployable actually mounts, with the framework that will render
 *  it.  `hosts: [A, B]` mounts SEVERAL (D-PHOENIX-SURFACE); `ui:` sugar/compose
 *  mounts one — a gate reading `d.uiName` alone never scans past the first, so
 *  a primitive used only in the second slipped through.  The framework is
 *  resolved per-ui (`ui.framework` wins) because `d.uiFramework` derives from
 *  the FIRST hosted ui only.  Same idiom as `validateUiRealtimeSupport` /
 *  `validateFlutterPrimitiveSupport`. */
function mountedUis(sys: SystemIR, d: DeployableIR): { ui: UiIR; fw: string }[] {
  const uiNames = d.hostedUiNames.length > 0 ? d.hostedUiNames : d.uiName ? [d.uiName] : [];
  const out: { ui: UiIR; fw: string }[] = [];
  for (const uiName of uiNames) {
    const ui = sys.uis.find((u) => u.name === uiName);
    if (ui) out.push({ ui, fw: ui.framework ?? d.uiFramework ?? "" });
  }
  return out;
}

/** Frontends that can render `Chart` (M-T1.3 Phase 4).
 *
 *  react reaches a charting LIBRARY through its design pack; the other three
 *  need none — see the rollout note on the gate below. */
/** `Chart` on a target that can't render it (M-T1.3 Phase 4).
 *
 *  The gate was per-PACK during the staged rollout (mantine v9 was the only
 *  pack shipping a `primitive-chart` template + a chart dependency).  The
 *  backfill is complete — all EIGHT tsx packs ship both — so `primitive-chart`
 *  is now in `REQUIRED_PRIMITIVES.tsx.core`, which makes a react pack missing
 *  it a pack-LOAD failure rather than something to re-check here.  What remains
 *  is the per-FRAMEWORK rule, exactly like `validateDataGridFramework`.
 *
 *  Phoenix, Feliz and Flutter join react by rendering the chart THEMSELVES —
 *  inline SVG (HEEx, Feliz) and a `CustomPainter` (Flutter), computed from rows
 *  the client (or the LiveView socket) has already decoded, with no charting
 *  library and no dependency added.  None of the three has a `.hbs` pack matrix
 *  to backfill, so unlike the tsx leg there was no per-pack library to choose —
 *  which is what made them the cheap legs.  Vue, Svelte and Angular have no
 *  chart renderer and would render an unsupported-primitive comment, so they
 *  stay honest gaps.
 *
 *  NOTE for the sibling ports: this Set is edited by every frontend's chart PR,
 *  so it conflicts on rebase.  Resolve by keeping EVERY framework already
 *  present plus yours — never by taking one side wholesale.
 *
 *  With the last frontend ported the Set names every shipping framework, so the
 *  gate no longer fires for anything that exists — it is the seam a NEW frontend
 *  gates on until it ports, not dead code.  EXPORTED so its own test can prove
 *  it still bites: with nothing left to gate, "the check works" and "the check
 *  is unreachable" are indistinguishable from the outside, and the only honest
 *  way to tell them apart is to remove a framework and watch the diagnostic
 *  come back (`ui-chart-gates.test.ts`) — the same discipline
 *  `PROJECTION_READ_FRAMEWORKS` already uses one gate over. */
export const CHART_FRAMEWORKS = new Set([
  "react",
  "phoenixLiveView",
  "feliz",
  "flutter",
  "vue",
  "svelte",
  "angular",
]);

export function validateChartSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    for (const { ui, fw } of mountedUis(sys, d)) {
      if (CHART_FRAMEWORKS.has(fw)) continue;
      // Components render into pages, so a chart moved into one must not slip
      // the gate — same body coverage as `validateUiProjectionReadFramework`.
      const bodies: Array<{ what: string; body: ExprIR | undefined }> = [
        ...ui.pages.map((p) => ({ what: `page '${p.name}'`, body: p.body })),
        ...ui.components.map((c) => ({ what: `component '${c.name}'`, body: c.body })),
      ];
      for (const { what, body } of bodies) {
        if (!bodyUsesChart(body)) continue;
        diags.push({
          severity: "error",
          code: "loom.chart-unsupported-target",
          message: diagMessage("loom.chart-unsupported-target", {
            what,
            name: d.name,
            uiFramework: fw || "unknown",
          }),
          source: `${ui.name}/${what}`,
        });
      }
    }
  }
}

// Frontends whose generated client can READ a query-time projection
// (M-T1.3 Phase 1).  These ship a projections api module + the walker's
// Pattern H; the remaining frontends have no client, so a page reading a
// projection there would emit an unresolved receiver — `undefined.<Projection>`,
// a runtime TypeError and a build break.  Gate honestly until each ports, the
// same reviewed-gap discipline as the backend-side projection gates.
//
// NOTE for the sibling ports: this one-line Set is edited by every frontend's
// port PR, so it conflicts on rebase.  Resolve by keeping EVERY framework
// already present plus yours — never by taking one side wholesale.
//
// With the last frontend ported the Set names every shipping framework, so the
// gate no longer fires for anything that exists — it is the seam a NEW frontend
// gates on until it ports, not dead code.  EXPORTED so its own test can prove
// it still bites: with nothing left to gate, "the check works" and "the check
// is unreachable" are indistinguishable from the outside, and the only honest
// way to tell them apart is to remove a framework and watch the diagnostic
// come back (`projection-select-unresolved.test.ts`).
export const PROJECTION_READ_FRAMEWORKS = new Set([
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "flutter",
  // Phoenix is the odd leg: it emits no projection CLIENT at all.  A LiveView
  // deployable hosts its contexts in the same OTP app, so the read is an
  // in-process `<Ctx>.QueryProjections.<Proj>.run/1` call — see
  // `renderProjectionLoaders` (generator/elixir/liveview-emit.ts).
  "phoenixLiveView",
]);

/** `loom.ui-projection-read-unsupported`, the FRAMEWORK half.  The FLAVOUR half
 *  (a keyed / folded projection, unreadable on every target) is F3 in
 *  ui-checks.ts; this one decides whether the page's own frontend has the
 *  client, which needs the deployable in scope. */
export function validateUiProjectionReadFramework(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const readable = readableProjectionNames(sys.subdomains.flatMap((sd) => sd.contexts));
  if (readable.size === 0) return;
  for (const d of sys.deployables) {
    for (const { ui, fw } of mountedUis(sys, d)) {
      if (PROJECTION_READ_FRAMEWORKS.has(fw)) continue;
      const handles = new Set(ui.apiParams.map((p) => p.name));
      // Components read projections too — F3 walks their bodies, so this half
      // must as well or a read simply moved into a component slips the gate.
      const bodies: Array<{ what: string; body: ExprIR | undefined }> = [
        ...ui.pages.map((p) => ({ what: `page '${p.name}'`, body: p.body })),
        ...ui.components.map((c) => ({ what: `component '${c.name}'`, body: c.body })),
      ];
      for (const { what, body } of bodies) {
        for (const name of projectionReads(body, handles, readable)) {
          diags.push({
            severity: "error",
            code: "loom.ui-projection-read-unsupported",
            message: diagMessage("loom.ui-projection-read-unsupported#frontend-has-no-client", {
              what,
              name,
              dName: d.name,
              fw: fw || "unknown",
              // Named from the gate itself, so a port that widens the set can't
              // leave the message advertising a stale list.
              frameworks: [...PROJECTION_READ_FRAMEWORKS].sort().join(", "),
            }),
            source: `${ui.name}/${what}`,
          });
        }
      }
    }
  }
}

/** Readable-projection names a page body reads through an api handle — the
 *  validator's mirror of the walker's Pattern H (`<apiHandle>.<Projection>`). */
function projectionReads(
  body: ExprIR | undefined,
  handles: ReadonlySet<string>,
  readable: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  walkExprDeep(body, (e) => {
    if (
      e.kind === "member" &&
      e.receiver.kind === "ref" &&
      handles.has(e.receiver.name) &&
      readable.has(e.member)
    ) {
      found.push(e.member);
    }
  });
  return found;
}

export function validateAuthUiFramework(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    if (!d.auth?.ui) continue;
    if (!AUTH_UI_FRAMEWORKS.has(d.uiFramework ?? "")) {
      diags.push({
        severity: "error",
        code: "loom.auth-ui-unsupported-framework",
        message: diagMessage("loom.auth-ui-unsupported-framework", {
          name: d.name,
          uiFramework: d.uiFramework ?? "unknown",
          // Named from the gate itself, so widening the Set can't leave the
          // message advertising a stale list.
          frameworks: [...AUTH_UI_FRAMEWORKS].join(", "),
        }),
        source: d.name,
      });
    }
  }
}

/** `currentUser` read from a page/component with no principal bound.
 *
 *  `currentUser` in a page body is the VERIFIED SESSION user, and the only
 *  thing that binds one is the auth guard: `auth: ui` on a frontend deployable
 *  (React's `const currentUser = useSession().user`, and its Vue/Svelte/Angular/
 *  Feliz twins) or `auth: required` on a fullstack deployable that mounts the ui
 *  itself (Phoenix `LiveAuth.on_mount` assigns `@current_user`).  Without one,
 *  every frontend emits a DANGLING reference — react `currentUser.email` against
 *  no binding, flutter invalid Dart, feliz a `CurrentUser` match on a Model that
 *  has no such field.  Nothing downstream re-checks it, so the model compiles
 *  and the claim read is garbage at runtime.
 *
 *  The missing `user { … }` block is NOT this gate's case: without it the token
 *  never resolves to a `current-user` ref at all, and `loom.auth-no-user-block`
 *  (plus the AST-level `auth`-without-`user` error) already names it. */
export function validateCurrentUserNeedsAuthUi(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    // A guard is mounted — the session user is in scope, nothing to say.
    if (d.auth?.ui || d.auth?.required) continue;
    for (const { ui } of mountedUis(sys, d)) {
      // Components are walked for the same reason charts and grids are — a
      // read moved into one renders into the page all the same.  (Today a
      // component's `currentUser` lowers to an UNRESOLVED ref, because
      // `lowerComponent` threads `user: undefined` where `lowerPage` threads
      // the system's user block; when that is threaded through, this arm
      // starts biting with no edit here.)
      const hosts: { what: string; host: UiRenderHost }[] = [
        ...ui.pages.map((p) => ({ what: `page '${p.name}'`, host: p as UiRenderHost })),
        ...ui.components.map((c) => ({ what: `component '${c.name}'`, host: c as UiRenderHost })),
      ];
      for (const { what, host } of hosts) {
        if (!hostReadsCurrentUser(host)) continue;
        diags.push({
          severity: "error",
          code: "loom.current-user-needs-auth-ui",
          message: diagMessage("loom.current-user-needs-auth-ui", {
            what,
            uiName: ui.name,
            dName: d.name,
          }),
          source: `${ui.name}/${what}`,
        });
      }
    }
  }
}

/** The render-scope members a page and a component share — every place a
 *  `currentUser` read can hide in one.  (`PageIR` carries more; only these
 *  four are walked here.) */
interface UiRenderHost {
  body?: ExprIR;
  state: { init?: ExprIR }[];
  derived: { expr: ExprIR }[];
  actions: { body: StmtIR[] }[];
}

function hostReadsCurrentUser(host: UiRenderHost): boolean {
  if (exprUsesCurrentUser(host.body)) return true;
  if (host.state.some((s) => exprUsesCurrentUser(s.init))) return true;
  if (host.derived.some((d) => exprUsesCurrentUser(d.expr))) return true;
  return host.actions.some((a) => a.body.some(stmtUsesCurrentUser));
}

// Frontends that CONSUME the realtime SSE wire (channels.md Part I) — each
// subscribes to the backend's `GET /realtime/events` stream, so a live-event
// handler is honored ONLY when the target backend serves that wire
// (`backendServesRealtime`).  `static` hosts one of these framework bundles.
const SSE_REALTIME_FRONTENDS = new Set<string>([
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "static",
]);
// Frontends that realize realtime NATIVELY (Phoenix LiveView pushes over its
// own socket), so no separate SSE wire — a `on` handler is always honored.
const NATIVE_REALTIME_FRONTENDS = new Set<string>(["elixir", "phoenixLiveView"]);

/** Honesty gate for `on <channel>.<Event>` live-event handlers (channels.md
 *  Part I).  A handler on a ui whose serving frontend can't consume realtime
 *  — a framework with no realtime path (e.g. `flutter`), or an SSE-consuming
 *  frontend pointed at a backend that doesn't serve the SSE wire (e.g. a react
 *  ui targeting the Phoenix/Elixir backend) — compiles clean today but emits
 *  nothing.  Warn so the silent drop is a reviewed decision, not a surprise.
 *
 *  Capability-driven (the two frontend sets + `backendServesRealtime`) rather
 *  than hard-coding a frontend list, so a future frontend without the wire
 *  warns until it grows realtime consumption. */
export function validateUiRealtimeSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const byName = new Map(sys.deployables.map((d) => [d.name, d]));
  for (const d of sys.deployables) {
    const uiNames = d.hostedUiNames.length > 0 ? d.hostedUiNames : d.uiName ? [d.uiName] : [];
    for (const uiName of uiNames) {
      const ui = sys.uis.find((u) => u.name === uiName);
      if (!ui || (ui.notifications?.length ?? 0) === 0) continue;
      // The serving framework: the ui's declared `framework:` wins (a `static`
      // host or a Phoenix surface states it), else the deployable's platform.
      const framework = ui.framework ?? d.uiFramework ?? d.platform;
      if (NATIVE_REALTIME_FRONTENDS.has(framework)) continue;
      if (SSE_REALTIME_FRONTENDS.has(framework)) {
        // A self-hosting backend+ui mount (dotnet/phoenix) targets itself.
        const target = d.targetName ? byName.get(d.targetName) : undefined;
        const backendPlatform = target?.platform ?? d.platform;
        if (backendServesRealtime(backendPlatform)) continue;
        diags.push({
          severity: "warning",
          code: "loom.ui-realtime-unsupported",
          message: diagMessage("loom.ui-realtime-unsupported#backend-serves-no-sse", {
            name: d.name,
            uiName,
            target: target
              ? `target backend '${target.name}' (platform '${backendPlatform}')`
              : `backend platform '${backendPlatform}'`,
          }),
          source: d.name,
        });
        continue;
      }
      // Unknown / non-consuming frontend (e.g. flutter) — no realtime path.
      diags.push({
        severity: "warning",
        code: "loom.ui-realtime-unsupported",
        message: diagMessage("loom.ui-realtime-unsupported#frontend-has-no-consumer", {
          name: d.name,
          uiName,
          framework,
        }),
        source: d.name,
      });
    }
  }
}

// Honesty gate for the Flutter-UNRENDERED page primitives
// (`loom.flutter-primitive-unsupported`).  The Flutter pack renders the display
// / layout primitives, the controlled inputs (Field / MultilineField /
// PasswordField / NumberField / Toggle / SelectField), and Tabs; the form family
// + Modal render via the walker SEAMS.  The one primitive with NO renderer yet
// is `FLUTTER_DEFERRED_BUILDER_NAMES`, derived once from the
// `FLUTTER_UNRENDERED_PRIMITIVES` set in `src/util/flutter-deferred-primitives.ts`
// (FileUpload — a standalone multipart upload needs the File-type-on-Flutter
// foundation).  Because frontends validate against the target-AGNOSTIC
// walker-stdlib, a page using it while targeting a `platform: flutter` deployable
// type-checks and validates clean — then the Flutter walker emits a `// flutter
// pack: no renderer for "X"` comment (valid Dart, so `generated-flutter-build.yml`
// stays green) where the widget should be, and the UI element silently VANISHES.
//
// This fails fast at compile time instead — the frontend-target twin of
// `loom.feliz-store-unsupported` / `loom.ui-realtime-unsupported`.  Flutter is a
// self-hosting frontend platform (`platform: flutter` only ever serves the
// `framework: flutter` bundle), so the deployable platform is the reliable
// target detector.  DERIVED from the unrendered set: when FileUpload grows a
// real Flutter renderer and leaves `FLUTTER_UNRENDERED_PRIMITIVES`, the gate
// auto-closes with no edit here (as Field / Toggle / NumberField / Tabs did).
export function validateFlutterPrimitiveSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    if (d.platform !== "flutter") continue;
    const uiNames = d.hostedUiNames.length > 0 ? d.hostedUiNames : d.uiName ? [d.uiName] : [];
    for (const uiName of uiNames) {
      const ui = sys.uis.find((u) => u.name === uiName);
      if (!ui) continue;
      const hosts: { where: string; body?: ExprIR }[] = [
        ...ui.pages.map((p) => ({ where: `page '${p.name}'`, body: p.body })),
        ...ui.components.map((c) => ({ where: `component '${c.name}'`, body: c.body })),
      ];
      for (const host of hosts) {
        // One diagnostic per (host, primitive-name) — a page repeating the same
        // unrendered primitive shouldn't spam the report.
        const flagged = new Set<string>();
        walkExpr(host.body, (e) => {
          if (e.kind !== "call" || !FLUTTER_DEFERRED_BUILDER_NAMES.has(e.name)) return;
          if (flagged.has(e.name)) return;
          flagged.add(e.name);
          const where = `${host.where} on ui '${uiName}'`;
          diags.push({
            severity: "error",
            code: "loom.flutter-primitive-unsupported",
            message: diagMessage("loom.flutter-primitive-unsupported", {
              where,
              name: e.name,
              dName: d.name,
            }),
            source: where,
          });
        });
      }
    }
  }
}

// Page/component `derived name: T = expr` bindings are supported on every
// frontend now — React/Vue/Svelte/Angular hoist a reactive computed
// (`useMemo` / `computed` / `$derived` / `computed`); Phoenix/HEEx
// inline-recomputes the expr at each use.  No framework gate is needed.

// Default-deny enforcement (auth.md / quickstart §4.3).  When the system's
// `auth { enforcement: denyByDefault }` is set, every reachable *command* on
// an `auth: required` backend must declare a `requires` gate — otherwise it
// serves ungated.  `enforcement: opt` (the default) preserves the existing
// per-`requires` opt-in.  Escape hatch: `requires true` marks a command
// intentionally public.
//
// Scope: every client-reachable command (mutation) endpoint —
//   - public aggregate actions: operations, **creates**, destroys (each
//     carries `requires` in its body);
//   - **workflows**: every command-triggered starter (`create … {}`) and named
//     `handle …(){}` continuation command (POST endpoints; their bodies carry
//     `requires`).  Event-triggered creates / `on(...)` reactors are not
//     client-reachable, so they are excluded.
//
// Read endpoints — **views** and repository **finds** — are in scope too: each
// is a GET endpoint, and both now carry an optional `requires <expr>` gate (the
// read-side twin of an operation's in-handler 403).  An ungated read under
// denyByDefault serves to any caller; `requires true` is the explicit
// intentionally-public escape.
export function validateDefaultDeny(sys: SystemIR, diags: LoomDiagnostic[]): void {
  if (sys.auth?.enforcement !== "denyByDefault") return;
  // Contexts hosted by any `auth: required` backend deployable.  A frontend
  // (auth: ui) has `auth.required === false`, so it's excluded here.
  const guarded = new Set<string>();
  for (const d of sys.deployables) {
    if (!d.auth?.required) continue;
    for (const cn of d.contextNames) guarded.add(cn);
  }
  if (guarded.size === 0) return;
  const isGated = (statements: { kind: string }[]): boolean =>
    statements.some((s) => s.kind === "requires");
  for (const sd of sys.subdomains) {
    for (const c of sd.contexts) {
      if (!guarded.has(c.name)) continue;
      // Aggregate command actions: operations + creates + destroys (all
      // OperationIR with a `requires`-bearing body).
      for (const a of c.aggregates) {
        for (const op of [...a.operations, ...(a.creates ?? []), ...(a.destroys ?? [])]) {
          if (op.visibility !== "public") continue;
          if (!isGated(op.statements)) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: diagMessage("loom.default-deny-ungated#denybydefault-is-reachable", {
                name: a.name,
                opName: op.name,
              }),
              source: `${a.name}/${op.name}`,
            });
          }
        }
      }
      // Workflow command endpoints: command-triggered starters + named
      // handlers.  Each is a POST route a client can reach.
      for (const wf of c.workflows) {
        for (const entry of workflowCommandEntries(wf)) {
          if (!isGated(entry.statements)) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: diagMessage("loom.default-deny-ungated#denybydefault-workflow", {
                label: entry.label,
              }),
              source: `${wf.name}/${entry.key}`,
            });
          }
        }
      }
      // Repository finds: each author-declared named find is its own GET route
      // and now carries the same optional `requires <expr>` gate.  The aggregate
      // list-all endpoint (the auto-injected `find all`) is out of scope — it is
      // compiler-synthesized and has no author source line to attach a gate to;
      // gating it needs an aggregate-level default-read surface (follow-up).
      // Internal synthesized finds (paged-run helpers) are never their own route.
      for (const repo of c.repositories) {
        for (const find of repo.finds) {
          if (find.synthesized || find.name === "all") continue;
          if (!find.requires) {
            diags.push({
              severity: "error",
              code: "loom.default-deny-ungated",
              message: diagMessage("loom.default-deny-ungated#denybydefault-find-is-reachable", {
                name: repo.name,
                findName: find.name,
              }),
              source: `find/${repo.name}.${find.name}`,
            });
          }
        }
        // Entity history (docs/audit.md): `GET /<agg>/{id}/history` replays the
        // `before`/`after` snapshots of every successful command on a row.  It
        // is compiler-synthesized like `find all` — but unlike `find all` the
        // author HAS a surface to gate it from, because history copies the list
        // read's gate at enrichment.  So an ungated one is actionable, and
        // under denyByDefault an ungated CHANGE HISTORY is a worse default than
        // an ungated current-state read: it discloses who changed what and
        // when, over the row's whole lifetime, in one request.
        if (repo.historyFind && !repo.historyFind.requires) {
          diags.push({
            severity: "error",
            code: "loom.audit-history-ungated",
            message: diagMessage("loom.audit-history-ungated", {
              aggregateName: repo.aggregateName,
              aggregateName2: snake(plural(repo.aggregateName)),
              name: repo.name,
            }),
            source: `find/${repo.name}.history`,
          });
        }
      }
      // Projections.  Every projection — folded or query-time — is served as a
      // GET endpoint (`/projections/<name>`, plus `/{key}` for a keyed folded
      // one), so under denyByDefault an ungated one publishes its rows to any
      // caller exactly as an ungated find publishes an aggregate's.
      //
      // This was the last read surface default-deny walked past.  It could not
      // have been enforced before: a folded projection was unable to SPELL a
      // gate (the keyword lived in the query-clause fragment) and no backend
      // emitted one, so demanding a gate would have been demanding the
      // impossible.  Both halves are fixed, so the requirement is now
      // satisfiable and the exemption has no reason left.
      for (const proj of c.projections) {
        if (proj.query?.requires) continue;
        // A MACRO-emitted projection has no declaration header, so the
        // diagnostic's "add a `requires` after its declaration header" names a
        // line the author cannot open — `scaffoldDashboard` emits one singleton
        // totals projection per aggregate, which made `scaffold` and
        // `denyByDefault` an uncompilable pair.  Exempt for the same stated
        // reason the enrichment-injected `find all` is exempt one loop up: it
        // is compiler-synthesized and has no author source line
        // (`src/ir/util/read-gates.ts`).  Derived from the origin chain the
        // lowering already records — nothing new is stamped.
        if (isMacroEmitted(proj.origin)) continue;
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-projection", {
            name: proj.name,
          }),
          source: `projection/${proj.name}`,
        });
      }
      // Workflow INSTANCE reads (`/workflows/<wf>/instances[/{id}]`).  An
      // observable workflow — one with a correlation field, hence an
      // `instanceWireShape` — publishes every instance's correlation id and
      // state on two GET routes, so under denyByDefault it needs a gate for
      // the same reason an ungated find or projection does.
      //
      // It could not be required before: the routes are compiler-derived and a
      // workflow had no surface to declare a read gate on, so demanding one
      // would have demanded the impossible — the identical situation the folded
      // projection was in.  The header `requires` clause is that surface, so
      // the exemption has no reason left.
      //
      // Keyed on `instanceWireShape`: a stateless workflow (no correlation
      // field) serves no instance routes, so there is nothing to gate.
      for (const wf of c.workflows) {
        if (!wf.instanceWireShape || wf.instanceReadGate) continue;
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-workflow-instances", {
            name: wf.name,
          }),
          source: `workflow/${wf.name}`,
        });
      }
    }
  }

  // Explicit handlers (`commandHandler` / `queryHandler`) reachable through an
  // `api { route <METHOD> "<path>" -> <Ctx>.<Handler> }` binding.  These are
  // real HTTP endpoints on all five backends, and default-deny walked right
  // past them: it enumerated aggregate actions, workflow command entries,
  // finds and history, but never `ctx.commandHandlers` / `ctx.queryHandlers`.
  //
  // Scoped to ROUTE-BOUND handlers deliberately — an unrouted handler has no
  // transport surface, so demanding a gate from it would be noise.  The route
  // is the reachability proof, exactly as `visibility === "public"` is for an
  // aggregate operation.
  const ctxByName = new Map<string, (typeof sys.subdomains)[number]["contexts"][number]>();
  for (const sd of sys.subdomains) for (const c of sd.contexts) ctxByName.set(c.name, c);
  for (const api of sys.apis) {
    for (const route of api.routes) {
      const c = ctxByName.get(route.target.context);
      if (!c || !guarded.has(c.name)) continue;
      const cmd = (c.commandHandlers ?? []).find((h) => h.name === route.target.handler);
      const qry = cmd
        ? undefined
        : (c.queryHandlers ?? []).find((h) => h.name === route.target.handler);
      const handler = cmd ?? qry;
      // A workflow `handle` can also be a route target; those are already
      // covered by `workflowCommandEntries` above, so skip rather than
      // double-report.
      if (!handler) continue;
      if (isGated(handler.statements)) continue;
      const params = {
        kind: cmd ? "commandHandler" : "queryHandler",
        ctx: c.name,
        handler: handler.name,
        method: route.method,
        path: route.path,
      };
      // An `extern` handler has NO body — there is nowhere to put a gate — so
      // "add a `requires`" would be an unsatisfiable instruction.  Say what is
      // actually actionable instead (drop `extern`, or drop the route).  The
      // two arms are separate `diags.push` calls, not a ternary on `message:`,
      // because the catalog scanner (`diagnostic-catalog.test.ts`) reads the key
      // off a DIRECT `diagMessage("literal", …)` call expression — a ternary or
      // a computed key reads to it as inline wording.
      const source = `${c.name}/handler/${handler.name}`;
      if (handler.extern) {
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-handler-extern", params),
          source,
        });
      } else {
        diags.push({
          severity: "error",
          code: "loom.default-deny-ungated",
          message: diagMessage("loom.default-deny-ungated#denybydefault-handler", params),
          source,
        });
      }
    }
  }
}

/** The client-reachable command endpoints of a workflow: each command-triggered
 *  `create` starter and each named `handle` continuation.  Event-triggered
 *  creates and `on(...)` reactors fire on internal events, never a client POST,
 *  so they are excluded — the validate-layer analogue of the generator's
 *  `emitsCommandRoute`. */
function workflowCommandEntries(
  wf: WorkflowIR,
): { label: string; key: string; statements: WorkflowStmtIR[] }[] {
  const entries: { label: string; key: string; statements: WorkflowStmtIR[] }[] = [];
  for (const cr of wf.creates) {
    if (cr.triggerKind !== "command") continue;
    entries.push({
      label: cr.name ? `${wf.name}.${cr.name}` : wf.name,
      key: cr.name ?? "create",
      statements: cr.statements,
    });
  }
  for (const h of wf.handlers ?? []) {
    entries.push({ label: `${wf.name}.${h.name}`, key: h.name, statements: h.statements });
  }
  return entries;
}

export function validateReactIdReferences(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Build an aggregate registry across the whole system so we can
  // look up display fields regardless of which module declares the
  // target aggregate.
  const allAggregates = new Map<string, AggregateIR>();
  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) allAggregates.set(a.name, a);
    }
  }

  for (const d of sys.deployables) {
    // UI-mounting deployables emit per-aggregate forms whose `X id`
    // inputs need the target aggregate to be reachable from the
    // deployable's mounted set.  Backend-only deployables (hono)
    // skip — no UI.  `dotnet` is dual-mode now (`mountsUi: true` to
    // admit the fullstack `ui:` branch); when no `ui:` is declared
    // it stays backend-only and skips too — without this guard a
    // backend-only dotnet deployable would trigger spurious
    // Id-reachability errors against the (then irrelevant) UI.
    if (!descriptorFor(d.platform).mountsUi) continue;
    // Dual-mode platforms (dotnet) with no `ui:` are backend-only —
    // skip the UI-reachability walk.  `mountsUi && !isFrontend` is the
    // dual-mode shape today (frontend-only platforms always declare ui).
    if (!d.uiName && !descriptorFor(d.platform).isFrontend) continue;
    // Aggregates mounted by this deployable's `contextNames` set —
    // UI generators only emit per-aggregate hooks/queries for
    // these; anything outside is unreachable.
    const mounted = new Set<string>();
    const wantedContexts = new Set(d.contextNames);
    for (const sd of sys.subdomains) {
      for (const c of sd.contexts) {
        if (wantedContexts.has(c.name)) {
          for (const a of c.aggregates) mounted.add(a.name);
        }
      }
    }

    // Walk every operation param + every aggregate field that lowers to
    // an `X id` and check both invariants against the system-wide
    // registry + this deployable's mounted set.
    for (const aggName of mounted) {
      const agg = allAggregates.get(aggName);
      if (!agg) continue;
      // Aggregate root fields.
      for (const f of agg.fields) {
        checkIdReference(f.type, `${aggName}.${f.name}`, d.name, allAggregates, mounted, diags);
      }
      // Operation parameters.
      for (const op of agg.operations) {
        for (const p of op.params) {
          checkIdReference(
            p.type,
            `${aggName}.${op.name}(${p.name})`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
      // Part fields too — entity-parts on the wire surface as nested
      // shapes, but their `X id` properties show up as foreign
      // references in the part's row.  Forms for parts go through
      // the same Select picker pattern.
      for (const part of agg.parts) {
        for (const f of part.fields) {
          checkIdReference(
            f.type,
            `${aggName}.${part.name}.${f.name}`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
    }
  }
}

function checkIdReference(
  t: TypeIR,
  source: string,
  deployableName: string,
  allAggregates: Map<string, AggregateIR>,
  mounted: Set<string>,
  diags: LoomDiagnostic[],
): void {
  const inner = unwrap(t);
  if (inner.kind !== "id") {
    if (inner.kind === "array") {
      checkIdReference(inner.element, source, deployableName, allAggregates, mounted, diags);
    }
    return;
  }
  const target = inner.targetName;
  // 1. Target aggregate must exist somewhere in the system.
  const agg = allAggregates.get(target);
  if (!agg) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unknown-aggregate",
      message: diagMessage("loom.ui-id-ref-unknown-aggregate", { deployableName, source, target }),
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 2. Target aggregate must be mounted by this deployable's modules
  //    so `useAll<Target>()` is importable + the backend can serve
  //    the list.
  if (!mounted.has(target)) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unmounted",
      message: diagMessage("loom.ui-id-ref-unmounted", { deployableName, source, target }),
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 3. Target aggregate must declare a `derived display: string` (so the
  //    Select picker has a sensible option label).
  if (!agg.displayDerived) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-no-display",
      message: diagMessage("loom.ui-id-ref-no-display", { deployableName, source, target }),
      source: `${deployableName}/${source}`,
    });
  }
}

function unwrap(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

export function validateSystem(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const modulesByName = new Map<string, SubdomainIR>();
  for (const m of sys.subdomains) modulesByName.set(m.name, m);
  for (const t of sys.e2eTests) {
    validateE2ETest(t, sys, modulesByName, diags);
  }
}

// ---------------------------------------------------------------------------
// Compose uniqueness — the generated `docker-compose.yml` publishes each
// deployable's `port` on the host and keys every service by its
// `serviceSlug(name)` (= `naming.snake`).  Two deployables sharing a host
// port (e.g. both defaulted to 3000) make
// `docker compose up` abort with a port-in-use error; two deployables whose
// names slug to the same key (`SalesApi2` / `salesApi2` → `sales_api2`)
// silently merge into one output directory + one compose service.  Both are
// deploy-time breakage the IR can catch here (finding 20 / B24).
// ---------------------------------------------------------------------------

export function validateComposeUniqueness(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Host-port collisions across deployables (plus the bundled Keycloak port).
  const ownersByPort = new Map<number, string[]>();
  const addOwner = (port: number, owner: string): void => {
    const list = ownersByPort.get(port);
    if (list) list.push(owner);
    else ownersByPort.set(port, [owner]);
  };
  for (const d of sys.deployables) addOwner(d.port, `deployable '${d.name}'`);
  // The bundled Keycloak never collides: the emitter (`keycloakHostPort` in
  // src/system/index.ts) publishes it on the first free port >= 8081,
  // stepping past any port a deployable claims.
  for (const [port, owners] of ownersByPort) {
    if (owners.length < 2) continue;
    diags.push({
      severity: "error",
      code: "loom.duplicate-host-port",
      message: diagMessage("loom.duplicate-host-port", { port, owners: owners.join(", ") }),
      source: sys.name,
    });
  }

  // Service-slug collisions across deployables (case-variant names merge dirs).
  const namesBySlug = new Map<string, string[]>();
  for (const d of sys.deployables) {
    const slug = snake(d.name);
    const list = namesBySlug.get(slug);
    if (list) list.push(d.name);
    else namesBySlug.set(slug, [d.name]);
  }
  for (const [slug, names] of namesBySlug) {
    if (names.length < 2) continue;
    diags.push({
      severity: "error",
      code: "loom.duplicate-service-slug",
      message: diagMessage("loom.duplicate-service-slug", {
        names: names.map((n) => `'${n}'`).join(", "),
        slug,
      }),
      source: sys.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Channel wiring (channels.md §"Surface — transport binding", M-T4.4 slice 1).
// Cross-file/system-level twins of the AST-level channelSource matrix checks:
//
//   - `loom.channelsource-unbound` (warning) — a channelSource no deployable
//     lists in `channels:`.  Declared but inert: no broker is provisioned and
//     no client emitted for it.  Only fires when the system declares
//     deployables at all (legacy single-project generation has nowhere to
//     wire a binding).
//   - `loom.deployable-channel-unrelated` (warning) — a deployable lists a
//     channelSource but neither hosts the channel's owning context (producer
//     side) nor consumes any carried event via a reactor / event-triggered
//     create / projection fold in a hosted context.  Dead wiring.
//   - `loom.channel-consumer-unwired` (error) — a deployable consumes a
//     channel's events, some deployable binds that channel to a broker, but
//     this consumer doesn't list the binding: once the channel's traffic
//     rides the broker, this consumer would silently never receive it.
//     (The producer side stays a local re-entry fallback, so only the
//     consumer gap is a delivery hole — M-T4.4 design §5.)
// ---------------------------------------------------------------------------
export function validateChannelWiring(sys: SystemIR, diags: LoomDiagnostic[]): void {
  if ((sys.channelSources ?? []).length === 0) return;
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  // channel name -> owning context (channels are context members; bare names
  // are system-unique per the channelSource resolution rule).
  const channelOwner = new Map<string, { ctxName: string; carries: string[] }>();
  for (const m of sys.subdomains)
    for (const c of m.contexts)
      for (const ch of c.channels ?? [])
        channelOwner.set(ch.name, { ctxName: c.name, carries: ch.carries });
  const csByName = new Map(sys.channelSources.map((cs) => [cs.name, cs]));

  // The event names a deployable's hosted contexts consume (reactor `on`,
  // event-triggered `create … by`, projection folds) — the same trigger set
  // `deriveEventSubscriptions` wires for in-process dispatch.
  const consumedEventsOf = (dep: DeployableIR): Set<string> => {
    const consumed = new Set<string>();
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const wf of ctx.workflows ?? []) {
        for (const on of wf.subscriptions ?? []) consumed.add(on.event);
        for (const create of wf.creates ?? []) {
          if (create.triggerKind === "event" && create.eventRef) consumed.add(create.eventRef);
        }
      }
      for (const proj of ctx.projections ?? [])
        for (const on of proj.handlers) consumed.add(on.event);
    }
    return consumed;
  };

  // 1. Unbound channelSource.
  if (sys.deployables.length > 0) {
    const wired = new Set(sys.deployables.flatMap((d) => d.channelSourceNames ?? []));
    for (const cs of sys.channelSources) {
      if (wired.has(cs.name)) continue;
      diags.push({
        severity: "warning",
        code: "loom.channelsource-unbound",
        message: diagMessage("loom.channelsource-unbound", {
          name: cs.name,
          channelName: cs.channelName,
        }),
        source: `${sys.name}/${cs.name}`,
      });
    }
  }

  // channel name -> the channelSource names some deployable actually wires.
  const activeBindings = new Map<string, string[]>();
  for (const dep of sys.deployables) {
    for (const csName of dep.channelSourceNames ?? []) {
      const cs = csByName.get(csName);
      if (!cs) continue;
      const list = activeBindings.get(cs.channelName) ?? [];
      if (!list.includes(cs.name)) list.push(cs.name);
      activeBindings.set(cs.channelName, list);
    }
  }

  for (const dep of sys.deployables) {
    const consumed = consumedEventsOf(dep);
    const hosted = new Set(dep.contextNames);
    const listed = new Set(dep.channelSourceNames ?? []);

    // 2. Unrelated listing.
    for (const csName of dep.channelSourceNames ?? []) {
      const cs = csByName.get(csName);
      if (!cs) continue;
      const owner = channelOwner.get(cs.channelName);
      if (!owner) continue; // unresolved channel name — AST/linker reports it
      const produces = hosted.has(owner.ctxName);
      const consumes = owner.carries.some((e) => consumed.has(e));
      if (!produces && !consumes) {
        diags.push({
          severity: "warning",
          code: "loom.deployable-channel-unrelated",
          message: diagMessage("loom.deployable-channel-unrelated", {
            name: dep.name,
            csName: cs.name,
            channelName: cs.channelName,
            ctxName: owner.ctxName,
            carries: owner.carries.join(", ") || "none",
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }

    // 3. Consumer unwired while the channel is broker-bound elsewhere.
    if (!platformOwnsBackend(dep.platform)) continue; // frontends consume via M-T1.10 realtime
    for (const [chName, csNames] of activeBindings) {
      const owner = channelOwner.get(chName);
      if (!owner) continue;
      if (!owner.carries.some((e) => consumed.has(e))) continue;
      if (csNames.some((n) => listed.has(n))) continue;
      diags.push({
        severity: "error",
        code: "loom.channel-consumer-unwired",
        message: diagMessage("loom.channel-consumer-unwired", {
          name: dep.name,
          chName,
          carries: owner.carries.filter((e) => consumed.has(e)).join(", "),
          csNames: csNames[0],
        }),
        source: `${sys.name}/${dep.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Realtime relay obligation (channels.md — "the edge relay").  A browser
// speaks SSE only to the backend its frontend `targets:`, so for that backend
// to relay a channel to the UI it must itself SUBSCRIBE the channel — either
// by hosting the channel's owning context (today's single-hop wire) or by
// wiring a `channelSource` binding for it (the broker relay, M-T4.4 redis
// bindings).  A UI whose target does neither can't legally be served the
// events, so the `on <channel>.<Event>` handlers would silently receive
// nothing — error rather than drop.
//
// This is the frontend-relay half `validateChannelWiring` explicitly defers
// (its `loom.channel-consumer-unwired` skips frontends "consume via M-T1.10
// realtime").
export function validateRelayTargetNotSubscribed(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const byName = new Map(sys.deployables.map((d) => [d.name, d]));
  // channel name -> owning context (channels are context members; bare names
  // are system-unique per the channelSource resolution rule).
  const channelOwner = new Map<string, string>();
  for (const m of sys.subdomains)
    for (const c of m.contexts)
      for (const ch of c.channels ?? []) channelOwner.set(ch.name, c.name);
  const csByName = new Map((sys.channelSources ?? []).map((cs) => [cs.name, cs]));

  for (const d of sys.deployables) {
    const uiNames = d.hostedUiNames.length > 0 ? d.hostedUiNames : d.uiName ? [d.uiName] : [];
    for (const uiName of uiNames) {
      const ui = sys.uis.find((u) => u.name === uiName);
      if (!ui) continue;
      // Only channels the ui actually consumes via an `on <chan>.<Event>`
      // handler impose the relay obligation — a bare `channel` param that no
      // handler reads routes nothing.
      const consumed = new Set((ui.notifications ?? []).map((n) => n.paramName));
      const subscribed = (ui.channelParams ?? []).filter((p) => consumed.has(p.name));
      if (subscribed.length === 0) continue;
      // The relay is the target backend (a `static` frontend), or the
      // deployable itself when a backend hosts its own ui (dotnet/phoenix).
      const relay = (d.targetName ? byName.get(d.targetName) : undefined) ?? d;
      const relayHosts = new Set(relay.contextNames);
      const relayBinds = new Set<string>();
      for (const csName of relay.channelSourceNames ?? []) {
        const cs = csByName.get(csName);
        if (cs) relayBinds.add(cs.channelName);
      }
      for (const p of subscribed) {
        const owner = channelOwner.get(p.channelName) ?? p.contextName;
        if (relayHosts.has(owner) || relayBinds.has(p.channelName)) continue;
        diags.push({
          severity: "error",
          code: "loom.relay-target-not-subscribed",
          message: diagMessage("loom.relay-target-not-subscribed", {
            name: d.name,
            uiName,
            channelName: p.channelName,
            owner,
            pName: p.name,
            relayName: relay.name,
          }),
          source: d.name,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DataSource coverage — every backend deployable must declare a
// matching `dataSource` for every (context, persistence-kind) pair it
// hosts.  A stateBased aggregate needs `kind: state`; an eventSourced
// aggregate needs `kind: eventLog`.  Without a binding, the emitter
// has no schema / connection routing config to emit — so the omission
// is an authoring mistake, not a meaningful default.
//
// Only fires for backend deployables (dotnet, node, phoenix).
// Frontend-only platforms (react, static) own no database and can't
// have a dataSource to point at.
// ---------------------------------------------------------------------------
export function validateDataSourceCoverage(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const dsByName = new Map<string, DataSourceIR>();
  for (const d of sys.dataSources) dsByName.set(d.name, d);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    // Resolve the listed dataSources to their (ctx, kind) coverage set.
    const covered = new Set<string>();
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      covered.add(`${ds.contextName}:${ds.kind}`);
    }
    // For every hosted aggregate, demand a matching dataSource entry.
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const kind = dataSourceKindForAggregate(agg as EnrichedAggregateIR);
        const key = `${ctxName}:${kind}`;
        if (covered.has(key)) continue;
        diags.push({
          severity: "error",
          code: "loom.persistence-mode-unsupported",
          message: diagMessage("loom.persistence-mode-unsupported", {
            name: dep.name,
            ctxName,
            aggName: agg.name,
            persistedAs: agg.persistedAs ?? "state",
            kind,
            ctxName2: lowerFirst(ctxName),
            kind2: kind === "state" ? "State" : "EventLog",
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }

    // Inverse direction: a dataSource listed on a deployable but
    // covering nothing in the hosted contexts is dead config.  An
    // `eventLog` binding against a context that has only stateBased
    // aggregates routes no data; a `state` binding when every
    // aggregate is eventSourced is similarly inert.  This catches
    // edits-in-progress (renamed a strategy and forgot to drop the
    // old binding) and copy-paste from another deployable.  Warning
    // (not error) because the user may be staging a binding for an
    // aggregate they're about to add — but we still want it on the
    // Problems panel.
    const hostedContexts = new Set(dep.contextNames);
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      if (!hostedContexts.has(ds.contextName)) continue;
      // The 'for: <ctx> not in contexts:' error is already raised by
      // the AST validator (checkDeployableDataSources); skip here so
      // the user gets one diagnostic per mistake, not two.
      const ctx = ctxByName.get(ds.contextName);
      if (!ctx) continue;
      const reason = coverageGapReason(ds.kind, ctx);
      if (!reason) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-unused",
        message: diagMessage("loom.datasource-unused", {
          name: dep.name,
          dsName: ds.name,
          kind: ds.kind,
          contextName: ds.contextName,
          reason,
        }),
        source: `${sys.name}/${dep.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// File-field object-storage coverage.  A `File` primitive is passive/
// wire-only: it stores a `FileRef` reference in the row (JSONB), while the
// bytes live in an object store.  A backend deployable that hosts a
// File-bearing aggregate must therefore bind at least one `objectStore`
// dataSource (an `s3` / `localDisk` storage), or the upload/download
// endpoints have nowhere to put the bytes.  Frontend-only platforms own no
// storage and can't bind one, so they're skipped (a react frontend serves
// the wire shape, not the object).
// ---------------------------------------------------------------------------
export function validateFileFieldObjectStorage(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const dsByName = new Map<string, DataSourceIR>();
  for (const d of sys.dataSources) dsByName.set(d.name, d);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const hasObjectStore = (dep.dataSourceNames ?? []).some(
      (n) => dsByName.get(n)?.kind === "objectStore",
    );
    if (hasObjectStore) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const fileField = aggregateFileField(agg as AggregateIR);
        if (!fileField) continue;
        diags.push({
          severity: "error",
          code: "loom.file-field-needs-object-storage",
          message: diagMessage("loom.file-field-needs-object-storage", {
            name: dep.name,
            ctxName,
            aggName: agg.name,
            fileField,
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Saving-shape capability (D-DOCUMENT-AXIS).  An aggregate's effective
// `shape: …` must be one the hosting backend can actually emit.  Today
// the matrix is partial — .NET / Hono emit all three (relational /
// embedded / document); Phoenix emits only relational — so a
// `shape: document` aggregate on a Phoenix deployable would otherwise
// emit *relationally*, silently mismatching the per-shape migration.
// This turns that footgun into a clear error (the capability tier).
//
// Per-projection: the effective shape is resolved binding-aware (a
// `resource { shape: … }` override wins over the aggregate header), the
// same way the migration + backend emitters resolve it, so the check
// matches what would actually be produced.  Frontend platforms own no
// persistence (platformSavingShapes → undefined) and are skipped.
// ---------------------------------------------------------------------------
export function validateSavingShapeSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const base = platformSavingShapes(dep.platform);
    if (!base) continue;
    // elixir (plain Ecto) emits the opaque `(id, data, version)` document table
    // + a schemaless-changeset validated fold, so it supports `document` on top
    // of the platform's relational / embedded set.
    const supported =
      dep.platform === "elixir" ? ([...base, "document"] as readonly SavingShape[]) : base;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        if (supported.includes(shape)) continue;
        diags.push({
          severity: "error",
          code: "loom.saving-shape-unsupported",
          message: diagMessage("loom.saving-shape-unsupported", {
            name: dep.name,
            platform: dep.platform,
            ctxName,
            aggName: agg.name,
            shape,
            supported: supported.join(", "),
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Vanilla `shape: document` scope (DEBT-07).  The vanilla document path emits the
// CRUD surface (list / get / create / update / delete) over the `(id, data,
// version)` jsonb row, PLUS — since DEBT-07 — SCALAR custom finds (in-memory
// filter over the loaded rows) and SCALAR named operations (the body runs over
// the normalised `data` map, then persists through the document repository's
// `update/2`).  A document blob has no flattened struct columns, so a handful of
// op/find shapes still need machinery the document path deliberately omits, and
// those stay gated (an honest error rather than a mis-emit):
//
//   - a RETURNING op (`: A or B`), an AUDITED op, a PROVENANCED op — all persist
//     a pre-built changeset over struct columns inside a forced transaction;
//   - COLLECTION mutation (`items += …`).  This clause used to lean on "a
//     document's contained parts are gated separately
//     (`loom.vanilla-containment-unsupported`) anyway" — that gate is RETIRED
//     (M-T6.2 Drain C landed relational part-in-part; the code has zero raise
//     sites in `src/`), so the clause now stands on its own: the document path
//     itself has no emitter for a containment mutation;
//   - a body/filter that reads a VALUE-OBJECT sub-field, a DERIVED, or calls a
//     `function` / value-object constructor — these need the loaded struct / list
//     the jsonb map can't reconstruct in-place;
//   - a PAGED or UNION-returning custom find (the wire-envelope / tagged-result
//     shapes the document find path doesn't build).
//
// Everything else — scalar `assign` / `+=` / `-=` / `precondition` / `requires`
// / `let` / `emit`, and scalar/convention/`where`-clause finds — is emitted.
// ---------------------------------------------------------------------------
const VANILLA_DOC_CRUD_OPS = new Set(["create", "update", "delete", "destroy", "list", "get"]);

/** Does an expression reach a shape the vanilla document scalar path can't emit?
 *  A derived read, a *dereferenced-entity* member (cross-aggregate `X id` join),
 *  a collection METHOD (`.sum`/`.filter`/`.contains` — lambdas over jsonb maps),
 *  a constructor / match / lambda — anything beyond scalar arithmetic,
 *  whole-field / value-object-subfield / `.count` reads over the `data` map, and
 *  (when `allowFnCall`) calls to the aggregate's own pure `function`s.
 *
 *  `allowFnCall` is true when the aggregate's `function` members are all
 *  themselves doc-safe (verified once per aggregate) — then a `callKind:
 *  "function"` is emittable (the function is rendered in the same `docMap` mode).
 *  It is also passed `true` while verifying each function body, so a function
 *  that calls a sibling function stays admissible (the sibling is verified too —
 *  the whole call graph is checked, no recursion needed here). */
function docExprUnsupported(e: ExprIR, allowFnCall: boolean): boolean {
  const bad = (x: ExprIR): boolean => docExprUnsupported(x, allowFnCall);
  switch (e.kind) {
    case "ref":
      // A `this-derived` read has no stored `data` key (derived aren't
      // persisted); every other ref (this-prop / this-vo-prop whole read / param
      // / let / enum-value / current-user) is a plain scalar/map read.
      return e.refKind === "this-derived";
    case "member":
      // Supported: `this.<scalar>` (receiver `this`, entity type → `data[k]`), a
      // value-object SUB-field (`this.money.amount` → `data["money"]["amount"]`),
      // an array `.count`/`.length` (→ `Enum.count`).  NOT supported: a member off
      // a *dereferenced* entity (a cross-aggregate ref → needs a join the document
      // path can't do) — an entity receiver that isn't the aggregate's own `this`.
      if (e.receiverType.kind === "entity" && e.receiver.kind !== "this") return true;
      return bad(e.receiver);
    case "method-call":
      // A collection op (`.sum`/`.filter`/`.contains`) runs a lambda over the
      // jsonb list of string-keyed maps — the loaded-struct machinery the scalar
      // path lacks; a value-object method is the same story.  A scalar-receiver
      // method (string/number) is fine.
      return (
        e.isCollectionOp ||
        e.receiverType.kind === "valueobject" ||
        e.receiverType.kind === "array" ||
        bad(e.receiver) ||
        e.args.some(bad)
      );
    case "call":
      // A pure aggregate `function` call is emittable when the aggregate's
      // functions are doc-safe; every other call kind (value-object ctor, private
      // operation, domain service, resource op) still needs machinery the scalar
      // path omits.
      if (e.callKind === "function" && allowFnCall) return e.args.some(bad);
      return true;
    case "object":
      // A bare object literal — the data map a returning op's error-variant
      // `return TooMany { … }` ships — is a plain map on the document path.
      return e.fields.some((f) => bad(f.value));
    case "binary":
      return bad(e.left) || bad(e.right);
    case "unary":
      return bad(e.operand);
    case "paren":
      return bad(e.inner);
    case "ternary":
      return bad(e.cond) || bad(e.then) || bad(e.otherwise);
    case "convert":
      return bad(e.value);
    case "literal":
    case "id":
    case "this":
      return false;
    default:
      // new / object / match / lambda / list / *-call — all need the struct /
      // list / tuple machinery the document scalar path omits.
      return true;
  }
}

/** Does a pure `function` body reach a non-doc-safe shape?  Sibling-function
 *  calls are admitted (`allowFnCall` true) because every function is checked, so
 *  the whole graph is verified without recursing here. */
function docFunctionUnsupported(fn: FunctionIR): boolean {
  const body = fn.body;
  const exprs: ExprIR[] = "expr" in body ? [body.expr] : [];
  if ("stmts" in body) {
    for (const s of body.stmts) {
      switch (s.kind) {
        case "precondition":
        case "requires":
        case "let":
        case "expression":
          exprs.push(s.expr);
          break;
        case "return":
          exprs.push(s.value);
          break;
        case "call":
          exprs.push(...s.args);
          break;
      }
    }
  }
  return exprs.some((e) => docExprUnsupported(e, /* allowFnCall */ true));
}

/** Is the value of a containment `+=`/`-=` a doc-safe part constructor?  Route A:
 *  `lines += OrderLine { sku: …, qty: … }` appends a part struct to the embed's
 *  `embeds_many` list, so the value must be a part ctor (`new`/`object`) whose
 *  field values are themselves doc-safe scalars/VOs. */
function docContainmentValueUnsupported(e: ExprIR, allowFnCall: boolean): boolean {
  if (e.kind === "new" || e.kind === "object") {
    return e.fields.some((f) => docExprUnsupported(f.value, allowFnCall));
  }
  // A `-=` may pass a bare element/predicate — fall back to the scalar check.
  return docExprUnsupported(e, allowFnCall);
}

/** Does an operation statement fall outside the vanilla document op surface?
 *  `allowFnCall` mirrors {@link docExprUnsupported}; `agg` distinguishes a
 *  CONTAINMENT collection (embeds_many — mutable on document, Route A) from a
 *  reference/value collection (still gated). */
function docStmtUnsupported(s: StmtIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  const bad = (e: ExprIR): boolean => docExprUnsupported(e, allowFnCall);
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return bad(s.expr);
    case "assign":
      // A nested write target (`money.amount := …`, `segments.length > 1`) has no
      // single field to struct-update — the path only writes top-level fields.  A
      // whole-field write (incl. replacing a value object) is fine.
      return s.target.segments.length > 1 || bad(s.value);
    case "add":
    case "remove": {
      // Scalar compound arithmetic (`total += n`) is fine.  A COLLECTION mutation
      // is supported ONLY for a CONTAINMENT (`lines += Item{…}`): the relational
      // add/remove arm appends/removes a part struct and the op re-embeds the
      // mutated list via `put_embed` (Route A slice 4b — boot-verified).  A
      // reference collection (`X id[]` → many_to_many) and a scalar value
      // collection stay gated (no join table / not-yet-wired on a document blob).
      if (s.collection) {
        const field = snake(s.target.segments[0] ?? "");
        const isContainment = agg.contains.some((c) => snake(c.name) === field);
        if (!isContainment) return true;
        return s.target.segments.length > 1 || docContainmentValueUnsupported(s.value, allowFnCall);
      }
      return s.target.segments.length > 1 || bad(s.value);
    }
    case "emit":
      return s.fields.some((f) => bad(f.value));
    case "return":
      // A returning op's `return <value>` — an error-variant object literal is a
      // plain response map.  A private-operation self-call in tail position stays
      // gated (`docExprUnsupported` rejects the non-function call).
      return bad(s.value);
    default:
      // call / variant-match — need the self-call / frontend machinery the
      // document op path doesn't carry.
      return true;
  }
}

/** A user-defined document operation the path can't emit.  `allowFnCall` is set
 *  once per aggregate from whether its `function`s are all doc-safe.  A RETURNING
 *  op is admitted (persisting tagged tuple, #1774) and CONTAINMENT mutation is
 *  admitted (Route A); an AUDITED op — named (slice 4e) or returning (slice 4f) —
 *  is admitted (the persist tail records an audit row in a `Repo.transaction`).  A
 *  PROVENANCED op stays gated (a jsonb blob has no co-located `<field>_provenance`
 *  columns to drain a history buffer into). */
function docOpUnsupported(op: OperationIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  return opHasProvSite(op) || op.statements.some((s) => docStmtUnsupported(s, allowFnCall, agg));
}

export function validateVanillaDocumentScope(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.platform !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        if (!isDocumentShaped(enriched, resolveDataSourceConfig(enriched, ctx, sys))) continue;
        // A pure `function` call is emittable only when every function on the
        // aggregate is itself doc-safe (they render in the same `docMap` mode —
        // reading the jsonb `data` map); if any is not, a body that calls one is
        // gated.  Computed once here and threaded into the op/find checks.
        const allowFnCall = (agg.functions ?? []).every((fn) => !docFunctionUnsupported(fn));
        // A custom find is unsupported only when its predicate reads a non-scalar
        // shape.  PAGED finds (Route A slice 4c) and UNION finds (Route A slice 4d)
        // are now supported: `renderDocFindFn` returns the single-get `{:ok, nil}`/
        // `{:ok, record}` tuple the shared find controller translates to the tagged
        // union wire (found → 200 body, absent → 404 / RFC-7807 via `problem_variant`).
        const badFinds = (
          (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name)?.finds ?? []
        )
          .filter((f) => f.name !== "all")
          .filter((f) => f.filter != null && docExprUnsupported(f.filter, allowFnCall));
        const badOps = agg.operations
          .filter((op) => !VANILLA_DOC_CRUD_OPS.has(op.name))
          .filter((op) => docOpUnsupported(op, allowFnCall, agg));
        if (badFinds.length === 0 && badOps.length === 0) continue;
        const bits: string[] = [];
        if (badOps.length > 0)
          bits.push(`named operation(s) ${badOps.map((o) => o.name).join(", ")}`);
        if (badFinds.length > 0)
          bits.push(`custom find(s) ${badFinds.map((f) => f.name).join(", ")}`);
        diags.push({
          severity: "error",
          code: "loom.vanilla-document-unsupported",
          message: diagMessage("loom.vanilla-document-unsupported", {
            ctxName,
            name: agg.name,
            bits: bits.join(" and "),
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-class operation→operation self-call position on elixir (vanilla).
//
// An aggregate operation compiles to a context function `<op>_<agg>(record,
// params)` that returns a tagged `{:ok,_} | {:error,_}` tuple (exception-less.md
// — the same carrier the controller `case`s on).  A sibling-operation self-call
// can therefore only be PASSED THROUGH as the whole `return` value (the enclosing
// op returns the same tagged shape) — it cannot be composed into a larger
// expression or bound with `let`, because a tuple has no implicit unwrap in
// Elixir.  The other backends model an operation as a plain method returning its
// value directly, so they compose freely; on vanilla the non-tail case would
// silently emit a tuple into arithmetic / a struct field, so reject it up front.
// (A `function` self-call is unrestricted — functions are pure, arity-1, and
// return their value directly.)  Mirrors `loom.vanilla-document-unsupported`.
// ---------------------------------------------------------------------------

/** Is this expression a sibling-operation self-call (vs a pure `function` /
 *  value-object ctor / repo read)?  Operations — public and private — lower to
 *  the `private-operation` callKind. */
function isOperationSelfCall(e: ExprIR): e is ExprIR & { kind: "call" } {
  return e.kind === "call" && e.callKind === "private-operation";
}

/** Visit every expression a statement roots — the value-bearing arms only
 *  (mirrors the lowering's statement shapes); a bare `call` statement is itself
 *  a no-op op-call on vanilla and is handled there, so its receiver is not an
 *  expression to flag. */
function eachStmtExpr(s: StmtIR, visit: (e: ExprIR) => void): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      walkExpr(s.expr, visit);
      break;
    case "return":
    case "assign":
    case "add":
    case "remove":
      walkExpr(s.value, visit);
      break;
    case "emit":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
  }
}

export function validateElixirOpSelfCallPosition(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.platform !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        for (const op of agg.operations as OperationIR[]) {
          for (const s of op.statements) {
            // The single allowed site: an op-call that IS the whole value of a
            // `return` (tail passthrough).  Every other occurrence is rejected.
            const allowed =
              s.kind === "return" && isOperationSelfCall(s.value) ? s.value : undefined;
            eachStmtExpr(s, (e) => {
              if (e === allowed || !isOperationSelfCall(e)) return;
              diags.push({
                severity: "error",
                code: "loom.vanilla-op-call-position",
                message: diagMessage("loom.vanilla-op-call-position", {
                  ctxName,
                  name: agg.name,
                  opName: op.name,
                  eName: e.name,
                }),
                source: `${sys.name}/${dep.name}`,
              });
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capability-filter support on the Hono and Phoenix backends (partial
// today).  A `filter <expr>` capability installs at the query layer on
// every read.  On .NET it rides EF Core's `HasQueryFilter` (global,
// DI-resolved) — no restriction.  Hono AND-s the predicate into each
// Drizzle read site; Phoenix AND-s it into each Ecto read.  Two cases are
// not yet wired on either and would otherwise emit silently-wrong query
// behaviour (a soft-delete / tenancy-isolation footgun), so reject them
// with a clear error instead:
//
//   1. Principal-referencing filters (`this.tenantId ==
//      currentUser.tenantId`).  Binding the request principal into the
//      always-on read path is deferred (Hono: thread through findById +
//      callers; Phoenix: an actor-bound Ecto `where:`) — see
//      docs/old/proposals/criterion-everywhere.md.
//   2. Non-relational shapes (`shape: document` / `shape: embedded`).
//      Fields live inside a jsonb column, so `this.isDeleted` is not a
//      top-level column the predicate can reference without JSON-path
//      lowering — deferred.  (Phoenix only emits relational anyway, so
//      the saving-shape validator usually blocks this upstream.)
//
// Non-principal capability filters on a relational aggregate
// (`filter !this.isDeleted`) ARE emitted on both backends.
// ---------------------------------------------------------------------------
// Java/JPA gate: a SINGLE (non-collection) containment has no clean
// unidirectional JPA mapping with the FK on the part table (the shared
// schema's shape) — @OneToOne + @JoinColumn puts the FK on the owner,
// and mappedBy needs an entity-typed back-reference the domain model
// doesn't carry.  Fail fast (the parity contract: never silently
// downgrade) until the shadow-parent mapping lands.  Collection
// containments (the overwhelmingly common case) are fully supported via
// unidirectional @OneToMany.

// ---------------------------------------------------------------------------
// Lifecycle-stamp rejections (M-T6.33).
//
// This check USED to carry five codes — `loom.{node,dotnet,java,python,elixir}
// -stamp-unsupported` — one per backend, over a shared body.  The M-T9.27
// re-verify killed that framing on two counts:
//
//   1. NEITHER ARM IS BACKEND-SPECIFIC.  The body below reads only `dep.auth`,
//      `sys.user` and `agg.persistedAs` — facts about the MODEL.  It never
//      consults a backend capability.  The per-backend stamp MECHANISMS do
//      differ (Java `_stampOnCreate` entity methods; .NET EF
//      `AuditableInterceptor`; node Hono `_stampOnCreate`; python pre-persist;
//      Elixir Ecto `put_change`) — but none of them is what these two arms are
//      about, so the family only ever selected a message noun.
//   2. NEITHER ARM IS A GAP.  A backend-named `-unsupported` code promises
//      "not yet, on this target".  Both arms are permanent:
//
//        * a principal stamp on a deployable with no auth has NO PRINCIPAL TO
//          READ.  No backend can implement that; it is a misuse, and the
//          message says how to fix it (add `auth: required`, or use a
//          non-principal stamp).  A plain language rule.
//        * a stamp on an event-sourced aggregate contradicts the storage model
//          — stamps mutate state fields, and an event-sourced aggregate's state
//          is FOLDED FROM ITS EVENT STREAM.  Semantically impossible, on every
//          backend, forever.
//
// So the five collapse to TWO codes named for what they mean, not for who
// rejected them — and they leave the `*-unsupported` register entirely (that
// register holds work; these are not work).  Splitting by meaning rather than
// merging to one `loom.stamp-unsupported` is deliberate: the two arms are
// different failures with different fixes, and a caller matching on identity
// should be able to tell them apart.
//
// Naming follows M-T9.27 slice 2 (`-invalid` = impossible or refused) and
// M-T5.21 §Symptom 1 (a target name never belongs in a code identity — it
// becomes a lie the day that target supports it).
// ---------------------------------------------------------------------------

/** The noun for the missing request principal.  Elixir says "principal
 *  (request actor)"; every other family says "principal".  A message detail —
 *  deliberately NOT part of any code identity. */
const PRINCIPAL_NOUN: Readonly<Record<string, string>> = {
  elixir: "principal (request actor)",
};

/** Backend families whose deployables carry lifecycle stamps at all. */
const STAMP_FAMILIES: readonly string[] = ["java", "dotnet", "node", "python", "elixir"];

export function validateStampSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    const family = platformFamily(dep.platform);
    if (family === undefined || !STAMP_FAMILIES.includes(family)) continue;
    const principalNoun = PRINCIPAL_NOUN[family] ?? "principal";
    const authed = !!(dep.auth?.required && sys.user);
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const stamps = enriched.contextStamps ?? [];
        if (stamps.length === 0) continue;
        const usesPrincipal = stamps.some((r) =>
          r.assignments.some((a) => exprUsesCurrentUser(a.value)),
        );
        if (usesPrincipal && !authed) {
          diags.push({
            severity: "error",
            message: diagMessage("loom.stamp-principal-without-auth", {
              dep: dep.name,
              family,
              ctxName,
              name: agg.name,
              principalNoun,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.stamp-principal-without-auth",
          });
        }
        if (enriched.persistedAs === "eventLog") {
          diags.push({
            severity: "error",
            message: diagMessage("loom.stamp-on-event-sourced-invalid", {
              dep: dep.name,
              family,
              ctxName,
              name: agg.name,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.stamp-on-event-sourced-invalid",
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A `requires` that reads `currentUser`, on a deployable with NO AUTH.
//
// The third sibling of a rule that already exists twice: a principal-reading
// `filter` is refused (`loom.context-filter-unsupported#no-auth-user`) and so
// is a principal-reading `stamp` (`loom.stamp-principal-without-auth`), for the
// same reason — with no auth there is no request-scoped principal, so the
// clause is not unimplemented, it is unimplementable.  The GUARD was missed,
// and it is the one that EMITS.
//
// Measured on `main` before adding this, from ordinary Loom (an `operation`
// carrying `requires currentUser.role == "editor"`, on a deployable with no
// `auth:` and no system `user {}`):
//
//   node    if (!(currentUser.role === "editor")) throw new ForbiddenError(…)
//           → tsc: error TS2304: Cannot find name 'currentUser'
//   python  if not (currentUser.role == "editor"):        ← `publish_doc` binds no such name
//   .NET    if (!(currentUser.Role == "editor"))          ← the handler holds only `_repo`
//   java    if (!(Objects.equals(currentUser.role(), …))) ← likewise in the service
//
// i.e. a FREE IDENTIFIER in the emitted source: the generated project does not
// compile.  `ddd parse` reported `0 error(s), 0 warning(s)`.
//
// WHY it comes out unbound is the part that also decides how to detect it.
// With no auth there is nothing for lowering to resolve `currentUser` against,
// so the ref lands as `refKind: "unknown"` carrying the source name — and each
// backend's renderer prints an unknown ref verbatim.  So the principal test
// here CANNOT be `exprUsesCurrentUser` alone: that asks for
// `refKind === "current-user"`, which is exactly the shape this case fails to
// produce.  Both spellings must count — the resolved one (a system that
// declares `user {}` while this deployable opts out of `auth:`) and the
// unresolved one (no auth anywhere).  Testing only the resolved kind reports
// the harmless half and misses the half that does not compile.
//
// Every principal-reading gate site is covered rather than just the one that
// was found: operation / create / destroy bodies, `find … requires`, and a
// query-time projection's `requires`.  Covering one site would repeat the
// original mistake — the filter and stamp rules were each written for the site
// in front of whoever wrote them, which is why the guard went missing.
// ---------------------------------------------------------------------------

/** Backend families that render a `requires` gate at all (the frontends
 *  consume the wire shape and run no domain guard). */
const GUARD_FAMILIES: readonly string[] = ["java", "dotnet", "node", "python", "elixir"];

/** True when this gate reads the request principal — under EITHER lowering.
 *  See the note above: with no auth the ref never resolves, so the
 *  `refKind`-only test is blind to precisely the failing case. */
function guardReadsPrincipal(e: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(e, (node) => {
    if (node.kind === "ref" && (node.refKind === "current-user" || node.name === "currentUser")) {
      found = true;
    }
  });
  return found;
}

export function validateGuardPrincipalWithoutAuth(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    const family = platformFamily(dep.platform);
    if (family === undefined || !GUARD_FAMILIES.includes(family)) continue;
    // The same `authed` test the stamp and filter rules use: a deployable is
    // principal-bearing only when it opts in AND the system declares the
    // identity shape the claim is read off.
    if (dep.auth?.required && sys.user) continue;
    const principalNoun = PRINCIPAL_NOUN[family] ?? "principal";

    const report = (ctxName: string, site: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.guard-principal-without-auth", {
          dep: dep.name,
          family,
          ctxName,
          site,
          principalNoun,
        }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.guard-principal-without-auth",
      });
    };

    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        for (const [kind, actions] of [
          ["operation", agg.operations],
          ["create", agg.creates ?? []],
          ["destroy", agg.destroys ?? []],
        ] as const) {
          for (const op of actions) {
            const guarded = (op.statements ?? []).some(
              (s) => s.kind === "requires" && guardReadsPrincipal(s.expr),
            );
            // A canonical lifecycle action's synthesised `name` IS its keyword,
            // so this reads `create Doc.create` / `destroy Doc.archive` /
            // `operation Doc.publish` without a special case.
            if (guarded) report(ctxName, `${kind} ${agg.name}.${op.name}`);
          }
        }
      }
      for (const repo of ctx.repositories) {
        for (const f of repo.finds) {
          if (guardReadsPrincipal(f.requires)) report(ctxName, `find ${repo.name}.${f.name}`);
        }
      }
      // A query-time projection's gate is the twin of `FindIR.requires`, and
      // lives on its comprehension rather than on the projection itself.
      for (const p of ctx.projections ?? []) {
        if (guardReadsPrincipal(p.query?.requires)) report(ctxName, `projection ${p.name}`);
      }
    }
  }
}

// M-T6.19: `shape: embedded` reference collections (`X id[]`) now map on
// java.  The jsonb id-array column rides a per-target `AttributeConverter`
// (`<Target>IdJsonListConverter`, emitted in domain.ids) that unwraps the
// `List<XId>` to its bare `value`s so the Jackson FormatMapper serialises
// `["v1","v2"]` — the same physical jsonb shape .NET / node / elixir produce
// — instead of the structured-JSON aggregate path that bypassed it.  Nested
// part-in-part containments (single AND collection) likewise map
// (`directParentOf`).
//
// The gate this replaced was `loom.java-embedded-refcoll-unsupported`.  It is
// RETIRED — the code has zero raise sites in `src/`; the only surviving
// mention is the negative pin in
// `test/generator/java/generator-java-shapes.test.ts`, which asserts it is NOT
// raised.  Named here only so a reader grepping the old code finds this note
// instead of concluding the grep failed.

// ---------------------------------------------------------------------------
// Java read-model backstop gates.  Cross-aggregate `follows` and VO-typed
// read-model fields (workflow-instance / projection) are now emitted
// (the read-model VO records in java/emit/dto.ts).  What
// remains here is a defensive gate for an ENTITY (containment-part) read-model
// field: it would need a `<Part>Response` DTO the emitter doesn't build, but a
// part type never resolves in workflow / projection scope, so the gate is an
// unreachable backstop mirroring the emitters' `guardInstanceField` /
// `guardProjectionField` throws — kept so the shape fails honestly rather than
// crashing if that scope rule ever changes.
// ---------------------------------------------------------------------------

/** Peel optional / array wrappers to the leaf type kind — the emitters' own
 *  guard shape: `T?` → `T`, `T[]` → element, `T?[]` element-optional → `T`. */
function wireLeafKind(t: TypeIR): TypeIR["kind"] {
  const inner = t.kind === "optional" ? t.inner : t;
  const leaf =
    inner.kind === "array"
      ? inner.element.kind === "optional"
        ? inner.element.inner
        : inner.element
      : inner;
  return leaf.kind;
}

export function validateJavaReadModelShapes(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  for (const dep of sys.deployables) {
    if (platformFamily(dep.platform) !== "java") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;

      // (1) Entity-typed saga instance read-model field.  VO-typed fields now emit
      // (their `<Vo>Response` is co-located in application.workflows); an entity
      // (containment part) field would need a `<Part>Response` DTO — but a part
      // type never resolves in workflow scope, so this is a defensive backstop
      // for a shape the grammar/scope already forbids.  Only observable
      // workflows (those with an `instanceWireShape`) reach the instance emitter.
      for (const wf of ctx.workflows) {
        for (const f of wf.instanceWireShape ?? []) {
          if (wireLeafKind(f.type) !== "entity") continue;
          diags.push({
            severity: "error",
            message: diagMessage("loom.java-workflow-instance-field-unsupported", {
              name: dep.name,
              ctxName,
              wfName: wf.name,
              fName: f.name,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.java-workflow-instance-field-unsupported",
          });
        }
      }

      // (2) Entity-typed projection row field — same defensive backstop as (1).
      for (const proj of ctx.projections) {
        for (const f of proj.wireShape ?? []) {
          if (wireLeafKind(f.type) !== "entity") continue;
          diags.push({
            severity: "error",
            message: diagMessage("loom.java-projection-field-unsupported", {
              name: dep.name,
              ctxName,
              projName: proj.name,
              fName: f.name,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.java-projection-field-unsupported",
          });
        }
      }
    }
  }
}

export function validateContextFilterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  // Backends that gate one or both of the deferred capability-filter cases.
  // .NET supports BOTH (EF `HasQueryFilter` on the mapped-column shapes, an
  // in-app predicate on `document`), so it gates neither.
  // Canonical families (D-NODE-PLATFORM / D-ELIXIR-PLATFORM): `node` (was
  // `hono`), `elixir` (was `phoenix` / `phoenixLiveView`).
  // `python` is included because it now emits the non-principal relational case
  // (W1a), the PRINCIPAL relational case (DEBT-02), AND both `embedded` cases
  // (DEBT-02 tail): `contextFilterPredicate` in
  // `src/generator/python/find-predicate.ts` AND-s them into every root read
  // (principal predicates render `current_user.<claim>` against the ambient
  // `require_current_user()` accessor).  Only the `document` shape stays gated —
  // `supportsNonRelationalFilter`/`supportsPrincipalNonRelationalFilter` admit
  // python for `embedded` but not `document` — so it must be in this set for the
  // per-case logic below to reject that one shape (and accept the relational +
  // embedded cases, principal or not).
  // .NET is included NOT because it has an unwired shape (EF `HasQueryFilter`
  // supports every case — the `supports*` predicates below all return true for
  // it) but so the PRINCIPAL-filter-needs-auth gate reaches it: a `currentUser`
  // filter compiles to `HasQueryFilter(... RequestContext.Current!.CurrentUser!
  // ...)`, which NREs on every read when the deployable has no auth.  Excluding
  // .NET here skipped that gate entirely (finding 20 / B16).
  const LIMITED_FAMILIES = new Set(["node", "elixir", "java", "python", "dotnet"]);
  // Backends that now wire PRINCIPAL-referencing filters (`currentUser.x`) on
  // relational aggregates — node/elixir/java/python all do.  python renders the
  // predicate against the ambient `require_current_user()` accessor (a
  // module-level `ContextVar[User | None]` set in the auth middleware) inside
  // every root read (the SQLAlchemy analogue of node's `requireCurrentUser()`).
  // node renders the
  // predicate against the ambient `requireCurrentUser()` accessor inside every
  // root read (the Drizzle analogue of .NET's `HasQueryFilter`).  elixir (plain
  // Ecto) AND-s the predicate into each read as `^(current_user &&
  // current_user.f)`.  **java** AND-s a SpEL-principal JPQL clause
  // (`:#{@currentUserAccessor.user()?.f()}`) into every find/retrieval +
  // the scoped `findAll`/`findById` overrides (the static `@SQLRestriction`
  // still carries the non-principal filters).
  const supportsPrincipalFilter = (family: string): boolean => {
    if (family === "node") return true;
    if (family === "elixir") return true;
    if (family === "java") return true;
    // .NET wires a principal relational filter via EF `HasQueryFilter`
    // (`RequestContext.Current!.CurrentUser!.<claim>`); it's in LIMITED_FAMILIES
    // only for the auth gate, so it must report as fully supported here.
    if (family === "dotnet") return true;
    // python (DEBT-02 last-backend parity): a principal capability filter on a
    // RELATIONAL aggregate renders `current_user.<claim>` against an ambient
    // ContextVar accessor (`require_current_user()`) AND-ed into every root read
    // — the SQLAlchemy analogue of node's `requireCurrentUser()` weave / .NET's
    // `HasQueryFilter`.  (The non-relational principal case has since landed
    // too — `supportsPrincipalNonRelationalFilter` below lists python for BOTH
    // `embedded` and `document`; it is no longer gated.)
    if (family === "python") return true;
    return false;
  };
  // Backends that wire a NON-principal capability filter into a NON-relational
  // (document/embedded) aggregate.  node handles both shapes: a `document`
  // aggregate filters in-app over the rehydrated doc; an `embedded` aggregate's
  // root scalars are real columns, so the predicate AND-s into the SQL read like
  // the relational path.  java handles BOTH too: a `document` aggregate's store
  // filters every read in-app via `findAll().stream()`; an `embedded`
  // aggregate's root entity is a real JPA table whose root scalars are columns,
  // so the static non-principal predicate rides Hibernate's `@SQLRestriction`
  // exactly like the relational path (`emit/entity.ts`).  elixir handles
  // `embedded` (its only non-relational shape — `document` is unsupported there,
  // gated by `validateSavingShapeSupport`): an embedded aggregate's root
  // scalars are real columns, so the predicate AND-s into the Ecto read exactly
  // like the relational path.  **python** handles `embedded` too (DEBT-02 tail):
  // an embedded aggregate's root scalars are real columns, so
  // `contextFilterPredicate` AND-s into the embedded SQL reads exactly like the
  // relational path (`repository-embedded-builder.ts`).  **python also handles
  // `document`** now (DEBT-02 tail complete): the blob is one JSONB column, not
  // per-field queryable, so the predicate is evaluated IN-APP over the rehydrated
  // instance (`documentCapabilityBody` → a list-comprehension filter in
  // `repository-document-builder.ts`), mirroring node.  **.NET** handles all
  // shapes too, but NOT all of them through EF: `relational`/`embedded` ride the
  // EF `HasQueryFilter` (real mapped columns), while `document` — whose fields
  // live inside one jsonb blob, so EF has no column to hang a filter on — is
  // filtered IN-APP over the rehydrated aggregate (`_CapabilityVisible` in
  // `emit/repository.ts`'s `renderDocumentRepositoryImpl`), exactly like
  // node/java/python.  That document arm did NOT exist until #2530: this
  // function asserted .NET filtered every shape while the emitter emitted no
  // document filter at all — a SILENT cross-tenant read (#2527's follow-up 1).
  // A PRINCIPAL filter on a `document` shape is wired on node/Java/python
  // **and dotnet** (DEBT-02 Slice B — the actor binds into the in-app
  // predicate; see `supportsPrincipalNonRelationalFilter` below and the
  // `document-tenancy.ddd` ts-/java-/python-build fixtures); it stays gated
  // only for elixir (no `document` shape there).
  //
  // NET RESIDUE of this whole function, as of the two tables below: exactly
  // ONE (family, shape) cell is unwired — **elixir + `document`**.  Every
  // other pair is supported, so any wording here that generalises to
  // "relational only" is wrong.
  const supportsNonRelationalFilter = (family: string, shp: string): boolean =>
    (family === "node" && (shp === "document" || shp === "embedded")) ||
    (family === "java" && (shp === "document" || shp === "embedded")) ||
    (family === "elixir" && shp === "embedded") ||
    (family === "python" && (shp === "document" || shp === "embedded")) ||
    // .NET filters every shape — `embedded` via the EF query filter (its root
    // scalars are real columns), `document` in-app over the rehydrated
    // aggregate (its fields are inside the jsonb blob).  It is in
    // LIMITED_FAMILIES for the auth gate, not because a shape is unwired.
    (family === "dotnet" && (shp === "document" || shp === "embedded"));
  // PRINCIPAL (`currentUser.x`) filter on a NON-relational shape (DEBT-02, the
  // actor + non-relational intersection).  An `embedded` aggregate's root
  // scalars are real columns, so node/elixir/java reuse their relational
  // principal path (node weaves `requireCurrentUser()` into the embedded SQL
  // read; elixir AND-s the `current_user` predicate into the embedded Ecto
  // read; java AND-s the SpEL-principal clause into the embedded scoped reads).
  // A `document` aggregate filters IN-APP over the rehydrated
  // doc, so a principal predicate there evaluates the actor in-app (Slice B):
  // node binds `requireCurrentUser()` into the in-app predicate; java injects
  // the `CurrentUserAccessor` bean and binds it before the `.stream().filter`;
  // **python** binds `current_user = require_current_user()` before its
  // list-comprehension filter (DEBT-02 tail complete).
  // **python** also wires the embedded principal case: the embedded
  // root scalars are real columns, so the `currentUser.<claim>` predicate renders
  // against the ambient `require_current_user()` accessor and AND-s into the
  // embedded SQL read like the relational principal path.  `document` stays off
  // only for elixir (no `document` shape).
  const supportsPrincipalNonRelationalFilter = (family: string, shp: string): boolean =>
    (shp === "embedded" &&
      (family === "node" ||
        family === "elixir" ||
        family === "java" ||
        family === "python" ||
        family === "dotnet")) ||
    (shp === "document" &&
      (family === "node" || family === "java" || family === "python" || family === "dotnet"));

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    if (!fam || !LIMITED_FAMILIES.has(fam)) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const filters = enriched.contextFilters ?? [];
        if (filters.length === 0) continue;
        const usesPrincipal = filters.some((p) => exprUsesCurrentUser(p));
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        const nonRelational = shape !== "relational";
        // Does THIS family wire a principal filter on THIS shape?  Relational →
        // `supportsPrincipalFilter`; non-relational → the `embedded`-only
        // `supportsPrincipalNonRelationalFilter`.
        const principalSupportedHere = nonRelational
          ? supportsPrincipalNonRelationalFilter(fam, shape)
          : supportsPrincipalFilter(fam);
        // The shape itself must be wired (any filter); then, if the filter is
        // principal-referencing, that intersection must be wired too.
        const nonRelationalUnsupported = nonRelational && !supportsNonRelationalFilter(fam, shape);
        const principalUnsupported = usesPrincipal && !principalSupportedHere;
        // A principal filter on a backend that DOES wire it (incl. embedded on
        // node/elixir/java) still needs a request principal to scope by — so the
        // deployable must enforce auth (and the system must declare a `user {}`
        // block).  Without it the ambient `requireCurrentUser()` accessor isn't
        // even emitted.  Mirror the `validateStampSupport` precedent with a
        // clear, actionable error.
        if (
          usesPrincipal &&
          principalSupportedHere &&
          !nonRelationalUnsupported &&
          !(dep.auth?.required && sys.user)
        ) {
          diags.push({
            severity: "error",
            code: "loom.context-filter-unsupported",
            message: diagMessage("loom.context-filter-unsupported#no-auth-user", {
              name: dep.name,
              platform: dep.platform,
              ctxName,
              aggName: agg.name,
            }),
            source: `${sys.name}/${dep.name}`,
          });
          continue;
        }
        // A non-relational shape gates on the families that don't yet wire it
        // (DEBT-02); a principal filter gates where the actor intersection isn't
        // wired (relational: python; non-relational: document everywhere).
        if (!principalUnsupported && !nonRelationalUnsupported) continue;
        // The unwired shape is the harder limitation — report it first when both
        // apply.  Otherwise it's a principal filter on a shape whose actor
        // intersection isn't wired (a `document` aggregate filters in-app, so a
        // principal predicate there needs in-app actor evaluation — Slice B).
        // The ONLY unwired cell left in this whole function is elixir +
        // `document` — every other (family, shape) pair is covered by
        // `supportsNonRelationalFilter` / `supportsPrincipalNonRelationalFilter`
        // above.  So the reason must name the SHAPE as the residue, not
        // "relational only": elixir does wire `embedded`, and saying otherwise
        // sends the reader to a workaround they do not need.
        const reason = nonRelationalUnsupported
          ? `is persisted as shape(${shape}); the ${fam} backend wires capability filters on ` +
            `relational and shape(embedded) aggregates, but not yet on shape(${shape}) ones`
          : nonRelational
            ? `references currentUser (e.g. a tenancy filter) on a shape(${shape}) aggregate; ` +
              `principal-referencing filters on ${shape} aggregates are not yet wired on the ` +
              `${fam} backend (they evaluate in-app, not as a column predicate)`
            : `references currentUser (e.g. a tenancy filter); principal-referencing capability ` +
              `filters are not yet wired on the ${fam} backend`;
        diags.push({
          severity: "error",
          message: diagMessage("loom.context-filter-unsupported#unsupported-predicate", {
            name: dep.name,
            platform: dep.platform,
            ctxName,
            aggName: agg.name,
            reason,
            hosts: nonRelationalUnsupported
              ? `a node / dotnet / java / python deployable (all four wire capability filters ` +
                `on shape(${shape}) aggregates), or change this aggregate's shape to ` +
                `relational or embedded`
              : `a backend that wires principal-referencing filters on shape(${shape}) ` +
                `aggregates (node / dotnet / java / python)`,
          }),
          source: `${sys.name}/${dep.name}`,
          code: "loom.context-filter-unsupported",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `ignoring` filter-bypass support gate (named-filter-bypass.md §11).
//
// A read (repository `find`, or inline `Repo.findAll(...)`/`Repo.run`)
// may carry an `ignoring *` / `ignoring <Cap>, …` clause that bypasses a
// capability's query-filter(s).  Three fail-fast gates run over the FULLY-
// RESOLVED IR (the capability provenance lives on `agg.contextFilterOrigins`,
// Slice 0):
//
//   loom.filter-bypass-unknown-capability — `ignoring X` where the target
//       aggregate does NOT implement capability X (X ∉ agg.capabilities).
//   loom.filter-bypass-no-filter — X is implemented but contributes NO filter
//       (X ∉ agg.contextFilterOrigins), e.g. `ignoring auditable` (stamps-only).
//       `ignoring *` is a harmless no-op when the aggregate has zero capability
//       filters (only an EXPLICIT named cap errors) — bypassing "all of nothing"
//       is intent-neutral, whereas naming a specific cap that contributes no
//       filter is a likely authoring mistake.
//   loom.filter-bypass-unsupported — the read is served by a deployable whose
//       backend family is NOT in the supported set.  Honored by dotnet (EF
//       `IgnoreQueryFilters`), node (Drizzle), elixir (plain Ecto omits the
//       bypassed `where:`), java (§11.6 @SQLRestriction→bypassable @Filter triage,
//       disabled per-read via the Hibernate Session), and python (SQLAlchemy
//       has no global filter, so each read AND-s its predicates explicitly —
//       a bypassing find/inline-run simply OMITS the named conjunct).
//       Every honoring family is now in the set; the diagnostic only fires for
//       a backend with no DB read path (which never carries `ignoring`).
// ---------------------------------------------------------------------------

/** Backend families that honor an `ignoring` filter-bypass clause.  `dotnet`
 *  (EF `IgnoreQueryFilters`, Slice 1), `node` (Drizzle — omits the bypassed
 *  conjunct from the `and(...)` chain, Slice 2), `elixir` (plain Ecto omits the
 *  bypassed `where:`), and `java` (§11.6 hybrid — a bypassed capability leaves the
 *  always-on `@SQLRestriction` for a bypassable Hibernate named `@Filter`, which
 *  a bypassing read disables via `session.disableFilter`/`enableFilter`;
 *  principal filters omit the JPQL conjunct; document repos re-apply promoted
 *  caps per-find), and `python` (SQLAlchemy has no global filter, so each read
 *  AND-s its capability predicates explicitly via `contextFilterPredicate`; a
 *  bypassing find omits the named conjunct statically, and a shared
 *  `run_<retrieval>` omits the union of its inline call-sites' bypasses) all
 *  honor it. */
const FILTER_BYPASS_FAMILIES = new Set(["dotnet", "node", "elixir", "java", "python"]);

/** Whether `dep`'s backend honors `ignoring` filter-bypass.  A backend must
 *  not pass this gate while still silently filtering — a family is supported
 *  only once its emitter actually OMITS the bypassed predicate.  Elixir (plain
 *  Ecto) omits the bypassed `where:` on the reads that `ignoring` it. */
function bypassSupported(dep: { platform: string }): boolean {
  const fam = platformFamily(dep.platform);
  if (!fam) return false;
  return FILTER_BYPASS_FAMILIES.has(fam);
}

/** A read carrying an `ignoring` clause, plus the aggregate it targets and a
 *  human-readable site label for diagnostics. */
interface BypassRead {
  bypassAll?: boolean;
  bypassCaps?: string[];
  aggName: string;
  site: string;
}

/** Recursively collect inline `Repo.findAll(...)`/`Repo.run(...)` reads that
 *  carry an `ignoring` clause from a workflow-statement body (descends into
 *  `for-each` + `if-let` bodies). */
function collectBypassRepoRuns(
  stmts: readonly WorkflowStmtIR[],
  wfName: string,
  out: BypassRead[],
): void {
  for (const s of stmts) {
    if (s.kind === "repo-run" && (s.bypassAll || (s.bypassCaps?.length ?? 0) > 0)) {
      out.push({
        bypassAll: s.bypassAll,
        bypassCaps: s.bypassCaps,
        aggName: s.aggName,
        site: `workflow '${wfName}' inline read '${s.name}'`,
      });
    }
    if (s.kind === "for-each") collectBypassRepoRuns(s.body, wfName, out);
    if (s.kind === "if-let") {
      collectBypassRepoRuns(s.thenBody, wfName, out);
      collectBypassRepoRuns(s.elseBody ?? [], wfName, out);
    }
  }
}

/** Every `ignoring`-bearing read in a context, paired with its target
 *  aggregate: repository finds, views over an aggregate source, and inline
 *  repo-runs in workflow bodies. */
function bypassReadsInContext(ctx: BoundedContextIR): BypassRead[] {
  const out: BypassRead[] = [];
  for (const repo of ctx.repositories) {
    for (const f of repo.finds) {
      if (f.bypassAll || (f.bypassCaps?.length ?? 0) > 0) {
        out.push({
          bypassAll: f.bypassAll,
          bypassCaps: f.bypassCaps,
          aggName: repo.aggregateName,
          site: `find '${repo.name}.${f.name}'`,
        });
      }
    }
  }
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) collectBypassRepoRuns(c.statements, wf.name, out);
    for (const h of wf.handlers ?? []) collectBypassRepoRuns(h.statements, wf.name, out);
    for (const on of wf.subscriptions ?? []) collectBypassRepoRuns(on.statements, wf.name, out);
  }
  // A query-time projection's `ignoring` clause bypasses its `from` source
  // aggregate's capability filters — same triage as a repository find.
  for (const p of ctx.projections ?? []) {
    const q = p.query;
    if (!q?.source) continue;
    if (q.bypassAll || (q.bypassCaps?.length ?? 0) > 0) {
      out.push({
        bypassAll: q.bypassAll,
        bypassCaps: q.bypassCaps,
        aggName: q.source,
        site: `query-time projection '${p.name}'`,
      });
    }
  }
  return out;
}

/** Capitalize the first letter of a diagnostic site label (sentence-start). */
function capitalizeSite(s: string): string {
  return s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

export function validateFilterBypassSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    // Only backend deployables serve reads; a frontend (react/static/vue/…)
    // owns no repository read path, so it can't bypass a filter.
    if (!fam || !platformOwnsBackend(dep.platform)) continue;
    const supported = bypassSupported(dep);
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      const aggByName = new Map<string, AggregateIR>();
      for (const a of ctx.aggregates) aggByName.set(a.name, a);
      for (const read of bypassReadsInContext(ctx)) {
        const agg = aggByName.get(read.aggName);
        const caps = new Set(agg?.capabilities ?? []);
        const filterOrigins = new Set(
          (agg?.contextFilterOrigins ?? []).filter((o): o is string => o != null),
        );
        // 1. Unsupported backend — gate FIRST so an `ignoring` read on a
        //    non-dotnet backend always fails (regardless of cap validity).
        if (!supported) {
          diags.push({
            severity: "error",
            code: "loom.filter-bypass-unsupported",
            message: diagMessage("loom.filter-bypass-unsupported", {
              name: dep.name,
              platform: dep.platform,
              site: read.site,
              ctxName,
              aggName: read.aggName,
            }),
            source: `${sys.name}/${dep.name}`,
          });
          continue;
        }
        // 2. Per named capability: must be implemented AND contribute a filter.
        //    `ignoring *` skips both checks (it's keyed on nothing specific).
        for (const cap of read.bypassCaps ?? []) {
          if (!caps.has(cap)) {
            diags.push({
              severity: "error",
              code: "loom.filter-bypass-unknown-capability",
              message: diagMessage("loom.filter-bypass-unknown-capability", {
                site: capitalizeSite(read.site),
                ctxName,
                aggName: read.aggName,
                cap,
              }),
              source: `${sys.name}/${dep.name}`,
            });
            continue;
          }
          if (!filterOrigins.has(cap)) {
            diags.push({
              severity: "error",
              code: "loom.filter-bypass-no-filter",
              message: diagMessage("loom.filter-bypass-no-filter", {
                site: capitalizeSite(read.site),
                ctxName,
                aggName: read.aggName,
                cap,
              }),
              source: `${sys.name}/${dep.name}`,
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: dapper` capability gate (D-REALIZATION-AXES Phase 5c).
//
// The .NET Dapper adapter is now at FULL PARITY with EF Core (M-T6.9, drained
// across 7 waves): every relational/document/embedded/ES/inheritance shape,
// containment (incl. recursive part-in-part), associations, audit/provenance,
// managed fields, retrievals, seeds, and the workflow outbox all emit.  This
// check now fires ONLY for a genuinely-impossible shape (an un-owned by-value
// entity-array part field — no relational storage form on any adapter), a
// fail-fast guard like the category-A stamp guard.
// ---------------------------------------------------------------------------
// Element kinds a Dapper part collection field can round-trip as one `jsonb`
// column (System.Text.Json list serialisation) — kept in lockstep with
// `arrayElemCs` in `src/generator/dotnet/emit/dapper.ts` (ir/validate may not
// import generator/, so the two lists are mirrored, not shared).
export function validateDapperSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "dapper") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.dapper-unsupported", { name: dep.name, subject, reason }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.dapper-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      // QUERY-TIME PROJECTIONS used to be refused WHOLESALE here:
      // `query-projection-emit.ts` had no dapper branch at all, so it emitted
      // the EF shape unconditionally — `using Microsoft.EntityFrameworkCore;` +
      // `private readonly AppDbContext _db;`, neither of which exists on this
      // adapter — and the generated project did not COMPILE (CS0234 / CS0246).
      // M-T6.25 ported the four direct-table arms to raw Npgsql (the same
      // `NpgsqlDataSource` + private row DTO + `Map` shape the FOLDED read
      // controller already used), so the feature EMITS here now and the blanket
      // refusal is gone.
      //
      // What survives is the ONE thing raw SQL genuinely cannot reach: the two
      // arms that AGGREGATE (`select total = count()` / `group by`) name
      // COLUMNS on the source aggregate's table, and an aggregate whose fields
      // are not columns — a `shape: document` jsonb blob, an event-sourced
      // stream with no state table — has nothing for `sum(total)` to name.  EF
      // Core hides that behind its own JSON translation; Dapper cannot.  The
      // condition is computed by `dapperQueryProjectionGap`, which the emitter
      // reads too, so the gate and the emission arm cannot drift.
      for (const p of ctx.projections ?? []) {
        if (!isQueryTimeProjection(p)) continue;
        const gap = dapperQueryProjectionGap(p, ctx, sys);
        if (gap) {
          diags.push({
            severity: "error",
            message: diagMessage("loom.dapper-unsupported#feature", {
              name: dep.name,
              ctxName,
              projection: p.name,
              reason: gap,
            }),
            source: `${sys.name}/${dep.name}`,
            code: "loom.dapper-unsupported",
          });
        }
      }
      // `retrieval` bundles are now supported on Dapper — `Run<Name>Async`
      // renders as parameterised SQL (where + sort + offset/limit paging); a
      // predicate outside the Dapper subset stubs (NotImplementedException),
      // mirroring the find path.  No gate.
      // `seed` data is now supported — the Dapper seeder (Seed.cs) frames the
      // marker table / raw inserts on Npgsql+Dapper while reusing the
      // persistence-agnostic domain-`Create` path (I<Agg>Repository.SaveAsync).
      // Workflow event subscriptions (and therefore channels/outbox) are now
      // wired on the Dapper adapter (M-T6.9): the saga handlers depend on the
      // persistence-neutral Domain.Common ports, whose raw-Npgsql adapters
      // (DapperPersistencePorts.cs) replace the EF AppDbContext ones; the outbox
      // dispatcher/relay + workflow-instances read controller + saga / outbox /
      // event tables are all emitted through NpgsqlDataSource + DbSchema.  No
      // gate.
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // Event sourcing IS supported on this adapter (appliers): the
        // `<agg>_events` stream + fold reuse the persistence-agnostic
        // domain/CQRS layer.  An event-sourced aggregate has no state table,
        // so the `shape: ...` axis is moot — skip that check for it.
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        // shape: document IS supported now (D-DOCUMENT-AXIS, Dapper edition): the
        // whole aggregate persists as one JSONB `data` blob (a `(id, data,
        // version)` table), reusing the persistence-agnostic ToSnapshot/
        // FromSnapshot round-trip.  Contained parts + `X id[]` references fold
        // INTO the blob, so the relational-only containment/association gates
        // below are moot for it — skip them.  shape: embedded is still gated.
        // shape: embedded IS supported too (Dapper edition): flat root columns
        // PLUS one JSONB column per containment (the part sub-graph folds into
        // it via the ToSnapshot/FromSnapshot round-trip), no child tables.  A
        // part-in-part folds through the same snapshot recursion (the nested
        // `<Part>Snapshot` records + FromSnapshot loop), so it is supported —
        // only a part-collection field whose element kind is outside the
        // jsonb-serialisable set stays gated by the shared containment block.
        const isDocShape = a.persistedAs !== "eventLog" && shape === "document";
        if (
          a.persistedAs !== "eventLog" &&
          shape !== "relational" &&
          shape !== "document" &&
          shape !== "embedded"
        )
          reject(where, `is persisted as shape(${shape})`);
        // Aggregate inheritance: TPC (`ownTable`) IS supported — each concrete
        // is a standalone table with the merged base fields (a normal Dapper
        // repository), and the polymorphic `find all <Base>` base reader is
        // persistence-agnostic (it delegates to each concrete's `All()`).  TPH
        // (`sharedTable`) IS supported too — one shared table named for the base
        // (id + `kind` discriminator + base columns + the nullable union of
        // every concrete's own columns), each concrete repo targeting that table
        // with a spliced `kind = '<Concrete>'` read filter + discriminator-literal
        // INSERT, threading the shared `<Base>Id`.  A TPH member carrying
        // `contains` (nested parts) or an `X id[]` reference collection NOW
        // composes with the containment child-table + association join-table
        // passes: those child / join tables FK the SHARED BASE row's id (EF's
        // TPT-via-contains under a TPH root), so no gate.
        if (isDocShape) continue;
        // Reference-collection associations (`X id[]`) are supported: one
        // ordinal-ordered join table each (DbSchema), bulk-loaded on every
        // read and full-list-replaced on save by the Dapper repository.
        //
        // Nested entity parts (`contains lineItems: LineItem[]`) are supported
        // for STATE aggregates whose parts are FLAT: one child table per
        // containment (`id` PK + `<agg>_id` FK + the part's scalar/enum/vo/id
        // columns), bulk-loaded on every read and hydrated through the root's
        // `_Create(State)` seam, full-list-replaced on save, and cascade-deleted.
        //
        // Event-sourced (`persistedAs: eventLog`) aggregates persist to the
        // `<ctx>_events` stream, NOT a state table — their contained parts fold
        // in-memory from the event stream (the `apply(...)` bodies), so the
        // relational containment emitters (child tables, HydrateAsync, the
        // array-throwing `fieldColumn`) never run for them.  The Dapper event
        // store reuses the persistence-agnostic domain fold unchanged, so
        // `contains` (in any shape) needs no gate on an event-sourced aggregate.
        //
        // Nested entity parts + reference-collection associations (`X id[]`)
        // NOW COMPOSE (wave 4): every read hydrates the child tables through
        // `_Create(State)` first, then `LoadRefsAsync` post-sets the writable
        // ref-collection list on the reconstructed roots — the two hydrate
        // paths run in sequence, not exclusively.
        //
        // Part-in-part (a contained part with its OWN `contains`) is now drained
        // for BOTH shapes.  RELATIONAL child-table shape: `partChildrenOf` builds
        // the containment TREE, each grandchild a table FK'd to its DIRECT parent
        // part; hydration recurses bottom-up (children grouped by parent-part id,
        // slotted into the parent's `Map`), save recurses the object graph, and
        // delete relies on the FK cascade.  The `shape: embedded` fold (one JSONB
        // column per root containment) folds a part-in-part too — the containment
        // column serialises `part.ToSnapshot()`, whose `<Part>Snapshot` recurses
        // into the part's own `contains` (nested snapshot records + the
        // FromSnapshot rehydrate loop), so the whole subtree round-trips through
        // the one column.  No gate.
        //
        // A scalar / enum / value-object / id COLLECTION field on a part IS
        // supported — it stores as one `jsonb` column holding the serialised
        // list (System.Text.Json round-trip, the raw-Npgsql mirror of EF's
        // primitive-collection JSON mapping).  A part FIELD typed as an array of
        // a sibling ENTITY used to be gated here as an "impossible storage
        // shape", but since `contains` became optional (#2161) such a field
        // lowers to a containment (its own grandchild table, part-in-part above),
        // never a by-value column — and a cross-aggregate entity is a structural
        // error — so no un-owned entity collection can reach this check.  The
        // gate (and its `DAPPER_ARRAY_ELEM_KINDS` set) was therefore unreachable
        // dead code and has been removed.
        // Lifecycle stamping is supported (onUpdate mutates the aggregate
        // pre-save; onCreate binds INSERT-only parameters excluded from the
        // upsert SET), INCLUDING principal-referencing stamp values — the
        // Dapper repository reaches the request principal through the ambient
        // `RequestContext.Current!.CurrentUser!` accessor (a bare `currentUser`
        // → the principal id, `currentUser.<claim>` → the claim), exactly as
        // the EF AuditableInterceptor.  A principal stamp on a no-auth
        // deployable stays rejected by the category-A loom.stamp-principal-without-auth.
        //
        // HIERARCHICAL TENANCY (M-T6.29).  The `deep`/`global` read level lowers
        // to the materialized-path `authz-filter` sentinel, whose
        // `currentUser.<claim>` sub-expressions the Dapper principal-param
        // collector does not descend into — so it cannot bind the `@__cu_*`
        // params the fragment would need.  This USED to escape the gate entirely
        // and crash codegen (`capability filter … is outside the Dapper SQL
        // subset`) — the corpus map claimed the validator rejected it, and it did
        // not.  Now it is what that map always said: an honest boundary.  The
        // `deny` sentinel is principal-free and DOES render (`1 = 0`), so it is
        // deliberately not gated here.
        for (const f of [...(a.contextFilters ?? []), a.writeScopeFilter].filter(
          (x): x is ExprIR => x != null,
        )) {
          if (isDeepScopeFilter(f)) {
            diags.push({
              severity: "error",
              message: diagMessage("loom.dapper-unsupported#deep-scope", {
                name: dep.name,
                subject: where,
                reason: "carries a hierarchical (deep/global) tenancy scope filter",
              }),
              source: `${sys.name}/${dep.name}`,
              code: "loom.dapper-unsupported",
            });
            break;
          }
        }
        // Capability filters are supported too (spliced into every SELECT's
        // WHERE); a principal-referencing one lowers `currentUser.<claim>` to a
        // `@__cu_<claim>` Dapper param bound from the same ambient principal.
        // Access modifiers (`managed` / `token` / `internal` / `secret`) are
        // wire-projection concerns handled by the shared Domain/CQRS layers
        // (create-input shaping, `forApiRead` response stripping) — the Dapper
        // column round-trips like any other field, so no gate.  Provenanced
        // fields are supported too: the co-located `<field>_provenance` jsonb
        // column round-trips the ProvLineage (ProvJson.Options) and the Dapper
        // SaveAsync flushes the drained lineage into the `provenance_records`
        // history table (DbSchema owns its DDL) — the raw-Npgsql mirror of the
        // EF value-converter + ProvenanceRecord flush.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: mikroorm` capability gate (D-REALIZATION-AXES Phase 5d).
//
// The node/hono MikroORM adapter is the SECOND node persistence backend
// (alongside the default `drizzle`), at full parity with drizzle on the
// PERSISTENCE axis (M-T6.9, drained across 7 waves): every shape/inheritance/
// containment/association/audit/provenance/managed-field/seed/ES intersection
// emits.  Two distinct families of reject live here:
//
//  (a) SHAPE rejects (`reject`) — a genuinely-impossible mapping, drizzle
//      included.  Only one survives M-T6.9: an abstract inheritance base that
//      owns its own `contains` (the base has no repository and concretes do not
//      inherit its parts, so its tables would have no reader/writer).
//  (b) FEATURE rejects (M-T6.23) — GONE, all five.  Parity is persistence-only,
//      but five NON-persistence features were once gated `&& !usingMikro` in the
//      Hono emitter and emitted NOTHING: query-time projections, realtime SSE,
//      the transactional outbox, timers (`scheduler.ts`) and broker channel
//      drivers.  Each was first made an honest error here, then closed by its
//      emitter — the gate was always the interim, never the answer
//      (`docs/old/proposals/integrity-audit-2026-07-residue.md` R1 named the
//      projection case; the other four were unrecorded).  Nothing about a
//      non-persistence feature is gated on this adapter any more; if a new one
//      is ever `!usingMikro`-gated, gate it HERE rather than dropping it
//      silently, and delete the clause with the emitter that closes it.
//
// Persist-time audit stamping IS supported (node-persist-time-auditing): the
// MikroORM `save()` injects the audit columns into `em.upsert(...)` from the
// ambient request principal (`stampInsert`, db/audit-stamp.ts), keeping
// createdAt/createdBy immutable on conflict via `onConflictExcludeFields`.
//
// Server-managed access (`managed` / `token` / `internal` / `secret`) is NO
// LONGER gated either: the data-mapper stores such a field as an ordinary
// column that round-trips through the shared save/hydrate seams (the access
// modifier shapes only the API wire surface).  Provenanced fields stay gated.
// ---------------------------------------------------------------------------
export function validateMikroOrmSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "mikroorm") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.mikroorm-unsupported", { name: dep.name, subject, reason }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.mikroorm-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      // --- Feature gates (M-T6.23) -----------------------------------------
      // (1) Query-time projections: CLOSED by M-T6.23 slice 4 — the routes emit
      // on this adapter.  The aggregation shapes (whole-table and grouped) push
      // down through the mikro QueryBuilder with `raw()` SQL fragments and a
      // `whereToMikroFilter` WHERE; the raw-table (`from <Workflow>` /
      // `from <Projection>`) shape reads its Row entity the same way; and the
      // repository-sourced shape was adapter-neutral already, since the mikro
      // repository synthesises the same `repo.<projName>()` find.  A `where`
      // outside the FilterQuery subset is refused by
      // `validateFindPredicateAdapterSupport` (which now walks projection
      // filters), so an aggregation can never silently drop its filter.
      // (2) Realtime SSE: CLOSED by M-T6.23 slice 5, the last of the five —
      // `http/realtime.ts` and the boot tee emit on this adapter, so a
      // `delivery: broadcast` channel keeps its browser-observable wire and a
      // frontend's EventSource has a route to subscribe to.  The
      // consumer-dependent severity split that used to live here (error when a
      // frontend targeted the backend, warning otherwise) goes with the gap it
      // described: the module reads no `db`, so there is nothing left to gate.
      // (3) Transactional outbox: CLOSED by M-T6.23 slice 1 — the adapter emits
      // the `__loom_outbox` Row entity + `createOutboxDispatcher` /
      // `startOutboxRelay` over the EntityManager, so a durable channel
      // (`retention: log | work`) is at-least-once here exactly as on drizzle
      // (dispatch-delivery-semantics.md).  Nothing to gate.
      // Context `retrieval` query bundles ARE supported (DEBT-17): emitted as
      // `run<Name>` methods, the MikroORM analogue of the drizzle `runMethod`.
      // A retrieval whose `where` falls outside the MikroORM FilterQuery subset
      // emits a runtime-throwing stub at codegen (same as a find predicate), so
      // there's no validate-time gate here — mirrors the .NET Dapper v1 path.
      // `seed` data IS supported: `emitMikroSeeds` threads the same dataset
      // functions (domain `create` → `<Agg>Repository.save`) through the
      // EntityManager, with raw INSERTs + the `__loom_seed` marker via
      // `em.getConnection().execute`.  The mikro seed CLI inits the ORM +
      // `updateSchema()` before running; the boot path runs it after schema
      // update — so no gate here.
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // (4) HIERARCHICAL tenancy scope.  `emitMikroContextFilters` lowers each
        // capability filter through `whereToMikroFilter`, whose FilterQuery
        // subset cannot express the descendant-or-self subtree predicate — and
        // it CATCHES that failure and leaves the filter unapplied rather than
        // throwing.  For a `deep`/`global` scope that is not a degraded read:
        // it is NO tenant predicate at all, so every tenant's rows become
        // readable on every read of this aggregate.  The adapter's own comment
        // assumed the shape was unreachable here ("not generated on the mikro
        // adapter today") — a belief, not a gate.  A `tenancy … of <Registry>`
        // system with `persistence: mikroorm` validates, generates and compiles
        // clean today and silently serves cross-tenant rows.  Refuse it until
        // the subtree predicate is expressible (M-T6.23's remaining half).
        //
        // `writeScopeFilter` is scanned alongside the read filters (as dapper's
        // gate already does): a `deep` WRITE ladder derives the same subtree
        // sentinel, and the write-scope pre-guard lowers it through the very
        // same `whereToMikroFilter` — so an ungated one throws at codegen
        // instead of being an honest refusal.
        if (
          [...(a.contextFilters ?? []), a.writeScopeFilter]
            .filter((x): x is ExprIR => x != null)
            .some((f) => isDeepScopeFilter(f))
        ) {
          reject(
            `${where} carries a hierarchical tenancy scope (a 'deep'/'global' subtree read)`,
            `the descendant-or-self predicate that scopes it (the FilterQuery subset ` +
              `cannot express it, and an unlowerable principal filter is dropped ` +
              `silently) — leaving every tenant's rows readable`,
          );
        }
        // Event sourcing IS supported on this adapter (appliers): the
        // `<agg>_events` stream + fold reuse the persistence-agnostic
        // domain/CQRS layer.  An event-sourced aggregate has no state table,
        // so the `shape: ...` axis is moot for it — every saving shape is now
        // supported (no per-shape reject remains), so the shape need not be
        // resolved here.
        // `shape: embedded` IS supported (wave 2): the root stays queryable
        // columns and each containment folds into a jsonb column, (de)serialised
        // through the shared `<part>ToDoc`/`<part>FromDoc` helpers (the MikroORM
        // analogue of the drizzle embedded repository).  An `Id[]` reference
        // collection FOLDS onto the root as one jsonb id-string array (no pivot
        // table — `embeddedColumnsOf` + the embedded repo's hydrate/save fold),
        // the embedded analogue of the relational pivot and the mirror of the
        // drizzle `emitEmbeddedTable` ref-collection column.  `shape: document`
        // IS supported (wave 3): the whole aggregate tree collapses to one `(id,
        // data, version)` jsonb blob round-tripped through the shared doc
        // (de)serialisers — no per-field / containment / pivot columns, so
        // reference collections + parts ride inside the blob (unbounded).
        // Aggregate inheritance IS supported (aggregate-inheritance.md): TPH
        // (`sharedTable`) maps the hierarchy to one shared Row discriminated by
        // `kind` — concrete repos read/write it scoped to their `kind`, a
        // polymorphic `<Base>Repository` dispatches on it; TPC (`ownTable`)
        // gives each concrete its own table with a delegating base reader.
        // Both mirror the drizzle inheritance slice.
        // `Id[]` reference-collection associations ARE supported on a state
        // aggregate: each persists as a composite-PK pivot Row entity, bulk-
        // loaded on read and full-list-replaced on save (the MikroORM analogue
        // of the drizzle join table).  On an EVENT-SOURCED aggregate they need
        // no pivot table at all — an ES aggregate has no state table (its truth
        // is the `<ctx>_events` stream), so the reference collection folds
        // IN-MEMORY from the stream via the `apply(...)` bodies (`_fromEvents`),
        // exactly as on drizzle.  The relational pivot emitters never run for an
        // ES aggregate (the entities loop skips it), so there is nothing to gate.
        // Contained entity parts ARE supported (relational child tables): each
        // part persists as a parent-scoped `<Part>Row` child table, bulk-loaded
        // on read and diff-synced on save (the MikroORM analogue of the drizzle
        // containment path).  NESTED parts (part-in-part) are supported — a
        // nested part FKs to its DIRECT parent part's row (`directParentName`,
        // shared with migrations-builder), recursively loaded (deepest-first
        // `<nc>ByParent` maps) / saved (tree-position-stamped FK) / cascade-
        // deleted (no DB FK, so descendants cleared explicitly).  A COLLECTION
        // field on a part (array of scalar / enum / VO / id) folds into one jsonb
        // column (shared serialise/deserialise), the mirror of the Dapper
        // part-collection path.  An EVENT-SOURCED aggregate's parts fold
        // IN-MEMORY from the event stream (the `apply(...)` bodies rebuild the
        // containment tree through `_fromEvents`) — an ES aggregate has no state
        // table, so the relational child-table emitters never run for it; the
        // parts ride in the folded aggregate exactly as on the .NET Dapper ES
        // path, so there is nothing to gate.  A CONCRETE aggregate-inheritance
        // participant (`extends` a base) composes the inheritance repo with the
        // containment hydrate pass: its part child tables FK the row that owns
        // the concrete (the shared TPH row / the concrete's own TPC table), so
        // the containment tree round-trips like any state aggregate's parts (the
        // relational repo already emits both).  Only an ABSTRACT inheritance base
        // with its OWN parts stays gated — an abstract base owns no repository
        // (validator-forbidden) and concretes do not inherit its `contains`, so
        // its part tables would have no reader/writer: genuinely unmappable.
        if ((a.parts ?? []).length > 0 || (a.contains ?? []).length > 0) {
          if (a.isAbstract)
            reject(
              where,
              "contains nested entity parts on an abstract aggregate-inheritance base " +
                "(the base owns no repository, and concretes do not inherit its parts)",
            );
        }
        // `filter` capability predicates ARE supported: the repository ANDs each
        // non-principal predicate (a MikroORM FilterQuery) into every root read
        // via `$and`, honoring a read's `ignoring` bypass (the FilterQuery
        // analogue of drizzle's per-read predicate).  A predicate outside the
        // FilterQuery subset is caught by `validateFindPredicateAdapterSupport`
        // (which already iterates contextFilters), and principal-referencing
        // filters are rejected on Hono by `validatePrincipalContextFilterSupport`
        // — so only closed, lowerable predicates reach codegen.
        // Server-managed access (`managed` / `token` / `internal` / `secret`)
        // is NO LONGER gated: like drizzle, the MikroORM data-mapper stores such
        // a field as an ordinary column that round-trips through the shared
        // save-projection / hydrate seams (the access modifier only shapes the
        // API wire surface, not persistence).  Audit-stamp targets are filled by
        // the persist-time stamp (`stampInsert` in `em.upsert`) and the default-
        // on `version` token by the guarded version-CAS `nativeUpdate` — both
        // already supported.
        // Provenanced fields ARE supported (wave 3): each `<field>_provenance`
        // co-located lineage jsonb column rides the mikro Row + save projection
        // (the shared `provColumnEntries`/`hydrateRootExpr` seams), and the
        // per-write history flush runs on the EntityManager — see below.
        //
        // Per-operation / lifecycle `audited` writes ARE supported (wave 3): the
        // history row that the SHARED (drizzle-shaped) routes-builder writes in
        // the save transaction is now ported to the EntityManager API behind a
        // `usingMikro` branch — `db.transactional(...em.insert(AuditRecordRow /
        // ProvenanceRecordRow, {...}))` over the mikro history-Row entities, with
        // the save joining the same transaction via the repos' fork
        // `keepTransactionContext`.  Persist-time audit STAMPING (`auditable` /
        // `with audit` → `stampInsert` in `em.upsert`) stays supported too.
      }
    }
    // (4) Timers: CLOSED by M-T6.23 slice 3 — `scheduler.ts` emits on this
    // adapter (pg-boss for `cron:`, setInterval + a transaction-scoped advisory
    // lock for `every:`), with the `loom_timer_runs` watermark and the lock query
    // running through the EntityManager (`TimerStore` in scheduler-builder.ts).
    // Nothing to gate.
    // (5) Broker-bound channels: CLOSED by M-T6.23 slice 2 — `channelBindings` is
    // no longer emptied for a mikroorm deployable, so `http/channels.ts` (the
    // driver, producer tee and consumer loop) and the boot-time transport /
    // consumer wiring emit here exactly as on drizzle.  The module reads no
    // `db`, and the outbox relay it publishes drained rows through landed in
    // slice 1 — nothing left to gate.
  }
}

// ---------------------------------------------------------------------------
// Per-persistence-adapter find-predicate capability gate (Bucket V / P0).
//
// Every relational adapter lowers a `find` / `filter` / retrieval
// predicate to SQL, but each lowers a DIFFERENT subset of the queryable
// expression sublanguage.  A predicate that passes the general queryable
// check (`firstNonQueryableNode`) can still fall outside the SELECTED
// adapter's narrower subset, and the generator then throws at codegen
// (MikroORM `whereToMikroFilter`, Dapper `whereToSql`) or emits a runtime-
// broken TODO stub (Drizzle's null fallback).  This gate fails fast instead,
// keyed off the deployable's explicit `persistence:` selector.
//
// EF Core / Drizzle lower the full queryable subset, so only an explicit
// `persistence: dapper` / `persistence: mikroorm` narrows anything — the
// gate is silent for the (full-subset) defaults, matching the Dapper /
// MikroORM capability gates above.  The per-adapter narrowing lives in the
// platform-neutral descriptor `src/ir/util/find-predicate-capability.ts`
// (ir/validate may not import generator/, so the subset table lives here).
// ---------------------------------------------------------------------------
export function validateFindPredicateAdapterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    const adapter = dep.persistence;
    if (!adapter || !isFindPredicateAdapter(adapter)) continue;
    const report = (subject: string, label: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.find-predicate-unsupported", {
          name: dep.name,
          adapter,
          subject,
          label,
        }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.find-predicate-unsupported",
      });
    };
    const check = (predicate: ExprIR | undefined, subject: string): void => {
      if (!predicate) return;
      const label = firstUnlowerableForAdapter(predicate, adapter);
      if (label) report(subject, label);
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const repo of ctx.repositories) {
        for (const find of repo.finds) {
          check(find.filter, `repository '${repo.name}' find '${find.name}'`);
        }
      }
      for (const r of ctx.retrievals) {
        check(r.where, `retrieval '${r.name}'`);
      }
      // A QUERY-TIME projection's `where` lowers into a relational SELECT too —
      // through the synthesised `repo.<projName>()` find for the row-sourced
      // shape, and directly into the aggregation query for the pushed-down ones.
      // It was the one predicate position this gate did not walk, which mattered
      // as of M-T6.23 slice 4: on the MikroORM adapter an aggregation whose
      // filter fell outside the FilterQuery subset would otherwise answer a
      // plausible WRONG NUMBER (the filter silently dropped) instead of being
      // refused. Adapter-generic, like every other position here.
      for (const proj of ctx.projections ?? []) {
        if (!isQueryTimeProjection(proj)) continue;
        check(proj.query?.filter, `query-time projection '${proj.name}'`);
      }
      // Capability `filter` predicates also lower into every SELECT.  The
      // Dapper / MikroORM capability gates already handle principal-
      // referencing ones (and MikroORM rejects ALL capability filters), so
      // only the non-principal predicates can reach a relational SELECT here.
      for (const agg of ctx.aggregates) {
        const filters = (agg as EnrichedAggregateIR).contextFilters ?? [];
        for (const predicate of filters) {
          if (exprUsesCurrentUser(predicate)) continue;
          check(predicate, `a 'filter' capability predicate on aggregate '${agg.name}'`);
        }
      }
    }
  }
}

/** Returns a human-readable reason a dataSource of `kind` covers
 *  nothing in `ctx`, or undefined when the binding is exercised by
 *  at least one aggregate.  Encodes the dataSource-kind → aggregate-
 *  predicate matrix:
 *    - state    → needs at least one stateBased aggregate
 *    - eventLog → needs at least one eventSourced aggregate
 *    - snapshot → needs at least one eventSourced aggregate
 *      (snapshot policy applies to ES streams)
 *    - cache    → needs at least one aggregate of any strategy
 *    - replica  → needs at least one aggregate of any strategy
 */
// ---------------------------------------------------------------------------
// Need ⊆ sourceType capability check (RFC §5.3).  For each derived need
// bound to a resource, the resource's sourceType must offer every
// capability the need requires.  This is the IR-level invariant the
// implicit need layer enables; the AST validator already owns the
// coarser "kind supported by sourceType" check (with editor squiggles),
// so this only reports a *capability* gap on a kind the sourceType DOES
// support — avoiding a duplicate diagnostic for a plain kind/type
// mismatch.  In Phase 1 every supported kind offers all its
// capabilities, so this is silent for valid models; it becomes load-
// bearing once kinds carry capabilities a sourceType may partially
// support.
// ---------------------------------------------------------------------------

export function validateNeedCapabilities(sys: EnrichedSystemIR, diags: LoomDiagnostic[]): void {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const need of sys.needs) {
    const resource = sys.dataSources.find(
      (d) => d.contextName === need.contextName && d.kind === need.kind,
    );
    if (!resource) continue; // coverage gaps are reported elsewhere
    const sourceType = storageType.get(resource.storageName);
    if (!sourceType) continue; // unresolved `use:` reported elsewhere
    // Defer to the AST validator for the kind/type mismatch itself.
    if (!supportsSurfaceKind(sourceType, need.kind)) continue;
    const offered = capabilitiesFor(sourceType, need.kind);
    const missing = need.capabilities.filter((c) => !offered.has(c));
    if (missing.length > 0) {
      diags.push({
        severity: "error",
        code: "loom.resource-missing-capability",
        message: diagMessage("loom.resource-missing-capability", {
          name: resource.name,
          sourceType,
          missing: missing.map((c) => `'${c}'`).join(", "),
          contextName: need.contextName,
          kind: need.kind,
        }),
        source: `${sys.name}/${resource.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Typed remote-call backend support (M-T4.8).  Slice 2 lands the LOWERING —
// `orders.getOrderById(id)` resolves against the callee's derived operation set
// and types its result — but no backend emits the typed client yet (slices
// 3-5).  Without this gate, such a model reaches the renderer and dies on a
// stack trace.  This is the repo's HONEST-gap stance: a `loom.*` code the user
// can read, not a silent mis-emit.
//
// The set is now EMPTY — every backend (node, python, dotnet, java, elixir)
// emits a typed client, which is what "M-T4.8 is done" means.
//
// The check is deliberately KEPT rather than deleted with the last entry.  It
// costs one `.some()` early-exit on models with no api binding, and it is the
// honest-gap net for the NEXT backend: a sixth platform added without a client
// would otherwise reach a `render-expr.ts` arm that has no idea what to emit.
// Adding the new platform key here turns that into a readable `loom.*` error at
// validation time, which is the whole stance this check exists to hold.
// ---------------------------------------------------------------------------

/** Backends with no typed in-system api client.  Empty as of slice 4d — add a
 *  key here when introducing a backend before its client exists. */
export const REMOTE_API_OP_UNSUPPORTED: ReadonlySet<Platform> = new Set<Platform>([]);

export function validateRemoteApiOpSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Cheap exit: no api-bound resource ⇒ no typed call can exist.
  if (!sys.dataSources.some((r) => r.apiName)) return;
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const dep of sys.deployables) {
    if (!REMOTE_API_OP_UNSUPPORTED.has(dep.platform)) continue;
    for (const cn of dep.contextNames) {
      const ctx = ctxByName.get(cn);
      if (!ctx) continue;
      for (const wf of ctx.workflows) {
        for (const st of wf.statements) {
          walkWorkflowStmtExprsDeep(st, (e) => {
            if (e.kind !== "call" || e.callKind !== "remote-api-op") return;
            const op = e.remoteApiOp;
            if (!op) return;
            diags.push({
              severity: "error",
              code: "loom.remote-api-op-unsupported",
              message: diagMessage("loom.remote-api-op-unsupported", {
                name: wf.name,
                resourceName: op.resourceName,
                operationId: op.operationId,
                apiName: op.apiName,
                depName: dep.name,
                platform: dep.platform,
              }),
              source: `${sys.name}/${ctx.name}/${wf.name}`,
            });
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-system typed api bindings (M-T4.8).  `resource { kind: api, use: <Api> }`
// derives its address from the deployable that `serves:` that api — so the
// binding is only well-formed when exactly ONE backend deployable serves it.
// These are IR-level (not AST) checks because they need the whole system's
// deployable set, which the AST validator does not have resolved.
// ---------------------------------------------------------------------------

export function validateApiResourceBindings(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const apiBound = sys.dataSources.filter((r) => r.apiName);
  if (apiBound.length === 0) return;
  for (const r of apiBound) {
    const apiName = r.apiName as string;
    // Frontends `consumes:` an api; they never serve its routes, so a
    // frontend in `serves:` can't supply an address for a backend caller.
    const servers = sys.deployables.filter(
      (d) => d.serves.includes(apiName) && !descriptorFor(d.platform).isFrontend,
    );
    if (servers.length === 0) {
      diags.push({
        severity: "error",
        code: "loom.resource-api-unserved",
        message: diagMessage("loom.resource-api-unserved", { name: r.name, apiName }),
        source: `${sys.name}/${r.name}`,
      });
      continue;
    }
    if (servers.length > 1) {
      diags.push({
        severity: "error",
        code: "loom.resource-api-ambiguous-server",
        message: diagMessage("loom.resource-api-ambiguous-server", {
          name: r.name,
          apiName,
          length: servers.length,
          servers: servers.map((d) => `'${d.name}'`).join(", "),
        }),
        source: `${sys.name}/${r.name}`,
      });
      continue;
    }
    // Self-call: the deployable wiring this resource is the one serving the
    // api.  That is always a mistake — the context is already in-process, so
    // the call would leave the process only to re-enter it, paying a network
    // hop and losing the ambient transaction.
    const server = servers[0] as (typeof servers)[number];
    for (const dep of sys.deployables) {
      if (!dep.dataSourceNames.includes(r.name)) continue;
      if (dep.name !== server.name) continue;
      diags.push({
        severity: "error",
        code: "loom.resource-api-self-call",
        message: diagMessage("loom.resource-api-self-call", {
          name: dep.name,
          rName: r.name,
          apiName,
        }),
        source: `${sys.name}/${r.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Generic `config` map validation (RFC §8).  Keys are checked against
// the sourceType's registry config schema: unknown keys warn (forward-
// compatible), wrong-typed values error, and required keys missing from
// a physical `storage` error.  Resource-level config is supplemental, so
// the required-key check applies only to the storage declaration.
// ---------------------------------------------------------------------------

export function validateResourceConfig(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const s of sys.storages) {
    checkConfigBlock(s.config, s.type, `storage '${s.name}'`, true, sys.name, diags);
  }
  for (const r of sys.dataSources) {
    const sourceType = storageType.get(r.storageName);
    if (sourceType) {
      checkConfigBlock(r.config, sourceType, `resource '${r.name}'`, false, sys.name, diags);
    }
    validateManualIndexes(r, sys, diags);
  }
}

/** `resource index: [...]` checks (uniqueness-and-indexes.md §3.2): a manual
 *  index needs a relational table to sit on (so it is gated to `kind: state`),
 *  and each column must resolve to a field on some aggregate in the binding's
 *  `for:` context. */
function validateManualIndexes(
  r: SystemIR["dataSources"][number],
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  if (!r.manualIndexes || r.manualIndexes.length === 0) return;
  const label = `resource '${r.name}'`;
  if (r.kind !== "state") {
    diags.push({
      severity: "error",
      code: "loom.resource-index-non-state",
      message: diagMessage("loom.resource-index-non-state", { label, kind: r.kind }),
      source: `${sys.name}/${label}`,
    });
    return;
  }
  // Entity (aggregate or contained part) → its field names, for every entity in
  // the binding's context.  `index: Project.name` names the entity explicitly,
  // so the column resolves against THAT entity, not any table that has the name.
  const fieldsByEntity = new Map<string, Set<string>>();
  for (const sub of sys.subdomains) {
    for (const ctx of sub.contexts) {
      if (ctx.name !== r.contextName) continue;
      for (const agg of ctx.aggregates) {
        fieldsByEntity.set(agg.name, new Set(agg.fields.map((f) => f.name)));
        for (const part of agg.parts) {
          fieldsByEntity.set(part.name, new Set(part.fields.map((f) => f.name)));
        }
      }
    }
  }
  for (const spec of r.manualIndexes) {
    const fields = fieldsByEntity.get(spec.entity);
    if (!fields) {
      diags.push({
        severity: "error",
        code: "loom.resource-index-unknown-entity",
        message: diagMessage("loom.resource-index-unknown-entity", {
          label,
          entity: spec.entity,
          contextName: r.contextName,
        }),
        source: `${sys.name}/${label}`,
      });
      continue;
    }
    for (const col of spec.columns) {
      if (!fields.has(col)) {
        diags.push({
          severity: "error",
          code: "loom.resource-index-unknown-column",
          message: diagMessage("loom.resource-index-unknown-column", {
            label,
            entity: spec.entity,
            col,
          }),
          source: `${sys.name}/${label}`,
        });
      }
    }
  }
}

function checkConfigBlock(
  config: readonly ConfigEntryIR[] | undefined,
  sourceType: string,
  label: string,
  checkRequired: boolean,
  sysName: string,
  diags: LoomDiagnostic[],
): void {
  const schema = configSchemaFor(sourceType);
  const byName = new Map(schema.map((k) => [k.name, k] as const));
  const present = new Set<string>();
  for (const entry of config ?? []) {
    present.add(entry.key);
    const spec = byName.get(entry.key);
    if (!spec) {
      diags.push({
        severity: "warning",
        code: "loom.config-key-unknown",
        message: diagMessage("loom.config-key-unknown", { label, key: entry.key, sourceType }),
        source: `${sysName}/${label}`,
      });
      continue;
    }
    if (!configValueMatchesType(entry.value, spec)) {
      const expected =
        spec.type === "enum" && spec.values ? `one of ${spec.values.join(", ")}` : spec.type;
      diags.push({
        severity: "error",
        code: "loom.config-key-type",
        message: diagMessage("loom.config-key-type", { label, key: entry.key, expected }),
        source: `${sysName}/${label}`,
      });
    }
  }
  if (checkRequired) {
    for (const spec of schema) {
      if (spec.required && !present.has(spec.name)) {
        diags.push({
          severity: "error",
          code: "loom.config-key-required",
          message: diagMessage("loom.config-key-required", { label, name: spec.name, sourceType }),
          source: `${sysName}/${label}`,
        });
      }
    }
  }
}

function configValueMatchesType(
  value: ConfigValueIR,
  spec: { type: string; values?: readonly string[] },
): boolean {
  switch (spec.type) {
    case "number":
      return value.kind === "int";
    case "boolean":
      return value.kind === "bool";
    case "enum":
      return value.kind === "string" && (spec.values?.includes(value.value) ?? false);
    default: // string | secret
      return value.kind === "string";
  }
}

function coverageGapReason(kind: string, ctx: BoundedContextIR): string | undefined {
  const aggs = ctx.aggregates;
  if (aggs.length === 0) return "the context declares no aggregates";
  const hasState = aggs.some((a) => (a.persistedAs ?? "state") === "state");
  const hasES = aggs.some((a) => a.persistedAs === "eventLog");
  if (kind === "state" && !hasState) {
    return "every aggregate is persistedAs: eventLog (none need kind: state persistence)";
  }
  if ((kind === "eventLog" || kind === "snapshot") && !hasES) {
    return "no aggregate is persistedAs: eventLog (kind: " + kind + " has no event stream to back)";
  }
  // cache / replica only require at least one aggregate, already
  // checked above.
  return undefined;
}

// ---------------------------------------------------------------------------
// Honest-note pass: warn on dataSource knobs the AST validator accepts
// but no current emitter consumes.
//
// At time of writing, three knobs route through to generated code:
//   - `schema`       — EF Core ToTable, Drizzle pgSchema, Ecto schema prefix
//   - `tablePrefix`  — same three emitters (table-name prefix)
//
// The other six knobs validate against the kind/storage compatibility
// matrix in `src/language/validators/datasource.ts` but no emitter
// reads them.  Setting one is a no-op at runtime:
//
//   - `ttl`            — would gate a Redis-backed cache adapter that
//                        doesn't exist yet
//   - `every` / `retain` — would gate snapshot policy on an event-
//                        sourced persister (Marten / hono-ES adapter)
//                        that doesn't exist yet
//   - `readonly`       — would gate a replica-aware DbContext that
//                        doesn't exist yet
//   - `keyPrefix`      — would gate the same Redis cache adapter
//                        gated by `ttl`
//
// `isolationLevel` used to be on this list; it now flows through
// `resolveWorkflowIsolation` into the .NET BeginTransactionAsync and
// Phoenix `Repo.transaction` opts when a workflow in the context is
// transactional and doesn't carry its own per-workflow isolation.
//
// We surface this as a warning at IR-validate time so the author sees
// "validation accepts this but it's a no-op" instead of believing the
// knob has effect.  When an adapter lands that consumes one of these,
// the corresponding entry comes off the list — the truth-telling is
// in code, not in a doc that goes stale.
// ---------------------------------------------------------------------------

interface UnwiredKnob {
  property: keyof DataSourceIR;
  description: string;
}

const UNWIRED_KNOBS: readonly UnwiredKnob[] = [
  { property: "ttl", description: "no Redis-backed cache adapter is implemented yet" },
  {
    property: "every",
    description: "no event-sourced persister with snapshot policy is implemented yet",
  },
  {
    property: "retain",
    description: "no event-sourced persister with snapshot policy is implemented yet",
  },
  { property: "readonly", description: "no replica-aware persister is implemented yet" },
  { property: "keyPrefix", description: "no Redis-backed cache adapter is implemented yet" },
  // Note: the `shape:` knob (D-DOCUMENT-AXIS) is NOT listed here — it is
  // consumed by the backend emitters (relational / embedded / document),
  // and an unsupported shape for a given backend is rejected by the
  // per-PLATFORM saving-shape capability check, not warned as inert.
];

// Aggregate-inheritance storage gate (aggregate-inheritance.md, I2/I3).
//
// `ownTable` (TPC) emission is wired on every backend: the abstract base is
// dropped from the generation view (system/index.ts `collectContextsFor`) and
// each concrete emits as a standalone table carrying the merged base + own
// fields (the `wireShape` merge in enrichContext).
//
// `sharedTable` (TPH) is implemented on all three DB backends: Hono/Drizzle
// (hand-rolled shared table + `kind` discriminator, per-concrete columns
// nullable, repos filter/stamp `kind`), .NET/EF Core (native
// `HasDiscriminator`), and Phoenix (plain Ecto shared table + a `kind`
// discriminator column). So a TPH hierarchy is allowed iff its context is
// hosted by at least one of those backends; otherwise it's an error (not a
// warning) — there is no implemented emission target.
// `sharedTable` is the omitted-modifier
// default, so an inheritance hierarchy with no `inheritanceUsing: …` is TPH
// too. Polymorphic `Party id` refs and `find all Party` remain deferred (the
// language validator rejects the former); document / TPT shapes are later.
const DEFAULT_INHERITANCE_LAYOUT = "sharedTable" as const;

/** Map each context name to the set of backend (needsDb) platforms that host
 *  it — a context is TPH-capable iff that set intersects TPH_CAPABLE. */
export function backendPlatformsHostingEachContext(
  loom: EnrichedLoomModel,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sys of loom.systems) {
    for (const d of sys.deployables) {
      if (!descriptorFor(d.platform).needsDb) continue;
      for (const cn of d.contextNames) {
        const set = out.get(cn) ?? new Set<string>();
        set.add(d.platform);
        out.set(cn, set);
      }
    }
  }
  return out;
}

export function validateInheritanceStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const byName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  // TPH storage emission ships on Hono (Drizzle shared table + `kind`), .NET
  // (EF Core native `HasDiscriminator`), Phoenix (plain Ecto shared table + a
  // `kind` discriminator column), Python (SQLAlchemy) and Java (Hibernate).
  const TPH_CAPABLE = new Set(["node", "dotnet", "elixir", "python", "java"]);
  const tphList = [...TPH_CAPABLE].sort().join(", ");
  const hostedByCapable = [...backendPlatforms].some((p) => TPH_CAPABLE.has(p));
  for (const agg of ctx.aggregates) {
    if (!agg.isAbstract && !agg.extendsAggregate) continue;
    // A concrete's layout defaults to its base's (resolved within the
    // context); a per-concrete `inheritanceUsing: …` override wins. The
    // abstract base uses its own declared layout. Either way an omitted
    // modifier means `sharedTable` (TPH), the documented default.
    const base = agg.extendsAggregate ? byName.get(agg.extendsAggregate) : undefined;
    const effective = agg.inheritanceUsing ?? base?.inheritanceUsing ?? DEFAULT_INHERITANCE_LAYOUT;
    if (effective !== "sharedTable") continue;
    // Implemented when a TPH-capable backend (Hono / .NET / Phoenix) hosts the context.
    if (hostedByCapable) continue;
    const role = agg.isAbstract ? "abstract base" : `extends ${agg.extendsAggregate}`;
    const how = agg.inheritanceUsing
      ? "inheritanceUsing: sharedTable"
      : "the omitted-modifier default (sharedTable)";
    const others = [...backendPlatforms].filter((p) => !TPH_CAPABLE.has(p));
    const hostNote =
      others.length > 0
        ? `it is hosted by ${others.join(", ")}, where TPH is not implemented`
        : `no TPH-capable (${tphList}) backend deployable hosts this context`;
    diags.push({
      severity: "error",
      code: "loom.tph-backend-unsupported",
      message: diagMessage("loom.tph-backend-unsupported", {
        name: agg.name,
        role,
        how,
        tphList,
        hostNote,
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced storage emission (`persistedAs: eventLog`, appliers A2) is
// implemented for the Hono (`node`) and .NET (`dotnet`, EF Core) backends:
// the `<agg>_events` stream table + fold-on-load repository. So an
// event-sourced aggregate is allowed iff every backend deployable hosting
// its context implements it. On a backend that doesn't (Phoenix today) the
// aggregate would silently fall back to state persistence, losing the event
// log — an error, not a silent downgrade. Mirrors the TPH storage gate.
//
// Phoenix (plain Ecto/Phoenix) hosts pure ES via the per-aggregate stream +
// fold-on-load data layer (D-VANILLA-ES-HOME), so elixir is ES-capable.
const EVENT_SOURCING_BACKENDS = new Set(["node", "dotnet", "python", "java", "elixir"]);

export function validateEventSourcedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Every hosting backend must implement event sourcing; flag any that don't.
  const unsupported = [...backendPlatforms].filter((p) => !EVENT_SOURCING_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    if (anyBackend && unsupported.length === 0) continue;
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where event-sourced persistence is not implemented`
        : "no event-sourcing-capable (node / dotnet / java / python / elixir) backend deployable hosts this context";
    diags.push({
      severity: "error",
      code: "loom.event-sourcing-backend-unsupported",
      message: diagMessage("loom.event-sourcing-backend-unsupported", { name: agg.name, hostNote }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced *workflow* storage gate (workflow-and-applier.md A2-S5b).  A
// `workflow X eventSourced { … apply(…) }` folds its own emitted events into
// state via appliers — the saga analogue of a `persistedAs: eventLog`
// aggregate (emit-only handlers + pure `apply` folds, no mutable state table).
// The surface (grammar → `WorkflowIR.eventSourced` / `.appliers`) and the
// emit-only / pure-fold discipline (A1) have landed, and the **node, .NET,
// Python, Java, and elixir backends all emit the event-sourced workflow
// runtime** (per-correlation `<wf>_events` stream, fold-on-load,
// emit→append-own-event dispatch).  A backend that doesn't keeps an
// `eventSourced` workflow gated — otherwise it silently misgenerates as a
// state-based saga (the saga emitters key off `correlationField` alone, emit a
// mutable `<Wf>State` row + dispatcher, and drop the appliers entirely).  A
// parsed-but-unemitted feature is a footgun, so it fails fast — exactly like the
// event-sourced *aggregate* storage gate.
const EVENT_SOURCING_WORKFLOW_BACKENDS = new Set(["node", "dotnet", "python", "java", "elixir"]);
export function validateEventSourcedWorkflowStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !EVENT_SOURCING_WORKFLOW_BACKENDS.has(p));
  if (unsupported.length === 0) return;
  const hosts = unsupported.sort().join(", ");
  for (const wf of ctx.workflows) {
    if (!wf.eventSourced) continue;
    diags.push({
      severity: "error",
      code: "loom.event-sourced-workflow-unsupported",
      message: diagMessage("loom.event-sourced-workflow-unsupported", { name: wf.name, hosts }),
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// the Hono (`node`), .NET (`dotnet`), Java (`java`), Python (`python`) and
// elixir backends — the lineage SDK + co-located `<field>_provenance` column +
// the `provenance_records` flush.  On a backend that doesn't (e.g. react) a
// `provenanced` field silently behaves like a plain field, dropping the audit
// trail it promises — an error, not a silent no-op.  Mirrors the event-sourcing
// storage gate (a parsed-but-unemitted feature is a footgun, so it fails fast).
const PROVENANCE_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);
export function validateProvenancedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !PROVENANCE_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    const provFields = agg.fields.filter((f) => f.provenanced);
    if (provFields.length === 0) continue;
    if (anyBackend && unsupported.length === 0) continue;
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where the provenance runtime is not emitted`
        : "no provenance-capable (node / dotnet / java / python / elixir) backend deployable hosts this context";
    const names = provFields.map((f) => f.name).join(", ");
    diags.push({
      severity: "error",
      code: "loom.provenanced-backend-unsupported",
      message: diagMessage("loom.provenanced-backend-unsupported", {
        name: agg.name,
        names,
        hostNote,
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// `mask unless <expr>` read mask (authorization.md §5) — the aggregate-field
// baseline that redacts a field on the wire unless a `currentUser`-only
// predicate holds.  Two gates:
//   - loom.field-mask-not-current-user — the predicate references something
//     other than `currentUser` (+ constants): the mask is evaluated at DTO
//     projection as a param-free CALLER predicate, so a row/param reference is
//     illegal (mirrors the find gate's currentUser-only rule).
//   - loom.field-mask-unsupported — the field is hosted by a backend whose DTO
//     projection doesn't yet emit the redaction.  A parsed-but-unredacted mask
//     is a SECURITY footgun (the sensitive value ships in the clear), so it
//     fails fast rather than silently no-op'ing.  The supported set is EMPTY in
//     this foundation slice (grammar + IR + validation + wire-spec landed; the
//     per-backend read redaction is the stacked follow-on), so a `mask unless`
//     field is currently a compile error on every backend rather than an
//     unenforced no-op.  Each backend redaction slice adds its platform here.
//     `node` emits response-boundary read redaction (`toWireMasked`) across its
//     read routes + explicit handlers (M-T3.2 item 6, slice 2); `dotnet` redacts
//     each masked field's DTO-projection arg via the ambient principal; `python`
//     routes response boundaries through `to_wire_masked` (reads the ambient
//     `current_user()` and redacts fail-closed); `java` adds a `<Agg>Response
//     .fromMasked` mapper (static `CurrentUserAccessor.currentOrNull()` guard) the
//     read services + explicit handlers project through (audit keeps `from`);
//     `elixir` (vanilla Phoenix) makes `serialize/1` redact (reading the principal
//     from the process dictionary the Auth plug stashes), moving the raw map to
//     `serialize_unmasked/1` for audit snapshots.
const FIELD_MASK_BACKENDS = new Set<string>(["node", "dotnet", "python", "java", "elixir"]);
export function validateFieldMask(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !FIELD_MASK_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    const masked = agg.fields.filter((f) => f.maskUnless);
    if (masked.length === 0) continue;
    for (const f of masked) {
      const offending = firstNonGateRef(f.maskUnless!, GATE_ALLOWED_REFS);
      if (offending !== null) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-not-current-user",
          message: diagMessage("loom.field-mask-not-current-user", {
            name: agg.name,
            fName: f.name,
            offending,
          }),
          source: `${ctx.name}/${agg.name}.${f.name}`,
        });
      }
    }
    if (anyBackend && unsupported.length === 0) continue;
    const names = masked.map((f) => f.name).join(", ");
    diags.push({
      severity: "error",
      code: "loom.field-mask-unsupported",
      message: diagMessage("loom.field-mask-unsupported", {
        name: agg.name,
        names,
        unsupported: unsupported.join("/"),
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
  // Query-time projection responses are NOT yet mask-redacted — the shorthand
  // (no `select`) serialises the source aggregate's full wire, and a `select`
  // may read any field — so a masked aggregate can't be a query-time projection
  // source (it would leak the field past the mask).  An honest bound until
  // projection read-masking lands; the field surface itself stays supported.
  const maskedAggNames = new Set(
    ctx.aggregates.filter((a) => a.fields.some((f) => f.maskUnless)).map((a) => a.name),
  );
  if (maskedAggNames.size > 0) {
    for (const proj of ctx.projections) {
      // `maskedAggNames` holds only aggregate names, so a `source` match is an
      // aggregate source (a workflow / projection source can't collide).
      const src = proj.query?.source;
      if (src && maskedAggNames.has(src)) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-projection-source",
          message: diagMessage("loom.field-mask-projection-source", { name: proj.name, src }),
          source: `${ctx.name}/projection/${proj.name}`,
        });
        continue;
      }
      // A `join` reaches the masked aggregate just as directly as `from` does —
      // `select leaked = c.ssn` off a join alias emitted the raw column on all
      // five backends while the identical read through `from` was rejected.
      // Checking only the source made the bound bypassable by adding a join,
      // which is the opposite of a bound.  Same rule, same diagnostic.
      const joined = (proj.query?.joins ?? []).find((j) => maskedAggNames.has(j.aggregate));
      if (joined) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-projection-source",
          message: diagMessage("loom.field-mask-projection-source", {
            name: proj.name,
            src: joined.aggregate,
            via: "join",
          }),
          source: `${ctx.name}/projection/${proj.name}`,
        });
      }
    }
  }
}

// Per-operation audit-record emission (`operation … audited`) is implemented for
// the Hono (`node`), .NET (`dotnet`), Java (`java`), Python (`python`) and
// elixir-VANILLA backends — an audited public route / command handler / service
// method appends a who/what/when + before/after snapshot to the audit sink in
// the operation's save transaction.  Audited LIFECYCLE actions
// (`audited create` / `destroy`) ship on the same set — the create/destroy
// handlers stage the audit row (before:null/after=wire on create;
// before=wire/after:null on destroy) in the lifecycle transaction.  Hosting an
// `audited` action on a backend that doesn't emit the runtime would silently
// record nothing — that mismatch is an error, not a silent no-op.  (This gates
// the per-operation `audited` flag only; the `with audit` capability macro emits
// stamping rules via `contextStamps`, a separate concern.)
const AUDIT_OP_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);
const AUDIT_LIFECYCLE_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);
export function validateAuditedOperationSupport(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const anyBackend = backendPlatforms.size > 0;
  const opUnsupported = [...backendPlatforms].filter((p) => !AUDIT_OP_BACKENDS.has(p));
  const lifecycleUnsupported = [...backendPlatforms].filter(
    (p) => !AUDIT_LIFECYCLE_BACKENDS.has(p),
  );
  const push = (
    agg: BoundedContextIR["aggregates"][number],
    kind: "operation" | "lifecycle action",
    names: string[],
    unsupported: string[],
    capable: string,
  ): void => {
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where audit-record emission is not implemented`
        : `no audit-capable (${capable}) backend deployable hosts this context`;
    diags.push({
      severity: "error",
      code: "loom.audited-backend-unsupported",
      message: diagMessage("loom.audited-backend-unsupported", {
        name: agg.name,
        kind,
        names: names.join(", "),
        capable,
        hostNote,
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  };
  const capableLabel = "Hono (node) / .NET (dotnet) / Java (java) / Python (python) / elixir";
  for (const agg of ctx.aggregates) {
    const auditedOps = agg.operations.filter((o) => o.audited);
    if (auditedOps.length > 0 && (!anyBackend || opUnsupported.length > 0)) {
      push(
        agg,
        "operation",
        auditedOps.map((o) => o.name),
        opUnsupported,
        capableLabel,
      );
    }
    const auditedLifecycle = [...(agg.creates ?? []), ...(agg.destroys ?? [])].filter(
      (o) => o.audited,
    );
    if (auditedLifecycle.length > 0 && (!anyBackend || lifecycleUnsupported.length > 0)) {
      push(
        agg,
        "lifecycle action",
        auditedLifecycle.map((o) => o.name || "<create>"),
        lifecycleUnsupported,
        capableLabel,
      );
    }
  }
}

export function validateDataSourceUnwiredKnobs(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const ds of sys.dataSources) {
    for (const knob of UNWIRED_KNOBS) {
      const value = ds[knob.property];
      if (value === undefined) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-knob-unwired",
        message: diagMessage("loom.datasource-knob-unwired", {
          name: ds.name,
          property: knob.property,
          description: knob.description,
        }),
        source: `${sys.name}/${ds.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Auth validation.
//
// Two responsibilities:
//
//   1. System-wide shape: a deployable opting in via `auth: required`
//      needs the system to declare a `user { ... }` block (otherwise
//      there's no shape for the verifier hook to decode tokens into).
//      Duplicate user-field names rejected here too, defensively —
//      the parser doesn't structurally enforce uniqueness.
//
//   2. `currentUser` scope: the magic identifier resolves to a typed
//      ref via `lower-expr.ts:resolveNameRef` whenever the system
//      declares a user block.  Bodies may USE `currentUser` in
//      operations / workflows / aggregate test bodies,
//      plus repository find where filters; everywhere else
//      (invariants, derived properties, function bodies) the reference
//      is rejected with a friendly message pointing at where it is
//      allowed.
// ---------------------------------------------------------------------------

export function validateAuth(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // (1) Duplicate user-field names — Property doesn't structurally
  // enforce uniqueness, so a hand-rolled `user { id: string, id: int }`
  // would silently lower to two fields with the same name.
  if (sys.user) {
    const seen = new Set<string>();
    for (const f of sys.user.fields) {
      if (seen.has(f.name)) {
        diags.push({
          severity: "error",
          code: "loom.user-duplicate-field",
          message: diagMessage("loom.user-duplicate-field", { name: sys.name, fName: f.name }),
          source: `${sys.name}/user`,
        });
      }
      seen.add(f.name);
    }
  }
  // (2) `auth: required` deployables MUST have a user block.  Without
  // one, the verifier hook has no shape to populate, and `currentUser`
  // references in any body would resolve to an unknown ref.
  for (const d of sys.deployables) {
    if (d.auth?.required && !sys.user) {
      diags.push({
        severity: "error",
        code: "loom.auth-no-user-block",
        message: diagMessage("loom.auth-no-user-block", { name: d.name, sysName: sys.name }),
        source: `${sys.name}/${d.name}`,
      });
    }
  }
}

// `validateScaffoldDoubles` deleted.  Cross-directive
// double-scaffold detection now happens at the AST level: two
// scaffold directives producing the same generated page name surface
// either as a duplicate-symbol error from Langium's linker (when both
// pages reach the AST) or as a no-op in the expander (the second
// synthesis is suppressed by the per-ui name set).  Keeping the IR-
// level fallback would either duplicate the error or produce a
// confusing second diagnostic; better to let the AST layer own it.

export function validatePermissions(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const mod of sys.subdomains) {
    if (mod.permissions.length === 0) continue;
    const seen = new Set<string>();
    for (const p of mod.permissions) {
      if (seen.has(p.name)) {
        diags.push({
          severity: "error",
          code: "loom.duplicate-permission",
          message: diagMessage("loom.duplicate-permission", { name: mod.name, pName: p.name }),
          source: `${sys.name}/${mod.name}/permissions.${p.name}`,
        });
      }
      seen.add(p.name);
    }
  }
}
