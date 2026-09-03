// -------------------------------------------------------------------------
// System-level UI-framework support gates: data grid, HEEx component host
// state, chart, projection-read framework, current-user-needs-auth-ui,
// realtime, flutter primitive, and the auth-ui-framework guard.  Split out
// of system-checks.ts by packet 2.6 (wave-2) — mechanical move, no logic
// change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { FLUTTER_DEFERRED_BUILDER_NAMES } from "../../../util/flutter-deferred-primitives.js";
import type { DeployableIR, ExprIR, StmtIR, SystemIR, UiIR } from "../../types/loom-ir.js";
import { exprUsesCurrentUser, stmtUsesCurrentUser } from "../../types/loom-ir.js";
import { backendServesRealtime } from "../../util/channels.js";
import { bodyUsesChart } from "../../util/chart.js";
import { dataGridHosts } from "../../util/data-grid.js";
import { heexComponentHostStateUses } from "../../util/heex-component-host-state.js";
import { readableProjectionNames } from "../../util/projection-read.js";
import { walkExprDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

// `auth: ui` (the frontend OIDC guard) is emitted by every shipped frontend
// generator: React, Vue, Svelte, Angular, Feliz (`generator/feliz/auth-gate.ts`
// — the Elmish session model + `AuthGate` view, driven end-to-end by the
// `authgate` scenario in `generated-feliz-build.yml`) and Flutter
// (`generator/flutter/auth-gate.ts` — the `sessionProvider` probe, the `AuthGate`
// wrapper around `MaterialApp`, and the `ForbiddenView` page guard).  The set is
// KEPT, not deleted: it is the seam a new frontend gates on until it ports, and
// the diagnostic below is its message — a deployable whose resolved UI framework
// is absent would otherwise silently emit no guard at all.

const AUTH_UI_FRAMEWORKS = new Set(["react", "vue", "svelte", "angular", "feliz", "flutter"]);

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

/** A page-body primitive that needs HOST-LIVEVIEW state, written inside a
 *  `component`, on a phoenixLiveView ui.
 *
 *  A HEEx function component is a pure render function with no process of its
 *  own, so its `state { … }` and named `action`s are LIFTED into the host page's
 *  LiveView (#2646).  That hoisting was never extended to the walker's form /
 *  query / upload / table-control accumulators, so these primitives emit their
 *  markup inside the component while the host gets no assign, no
 *  `allow_upload/3` and no `handle_event/3`.
 *
 *  It is a COMPILE ERROR rather than a documented degrade because the emitted
 *  project passes `mix compile --warnings-as-errors` and then dies at REQUEST
 *  time on the missing assign — a page that raises on load, or a form whose submit
 *  silently does nothing.  A gate the author reads is strictly better than a
 *  crash they meet in the running app.  The workaround is exact and local: move
 *  the primitive into the page body (components may still hold layout, display,
 *  `state` and `action`s).
 *
 *  Drains when the four accumulators hoist the way state and actions already do
 *  — the same `ComponentActionInfo` + `gather*` seam, plus the multi-instance
 *  question `componentUses` exists to answer for state. */

export function validateHeexComponentHostState(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const d of sys.deployables) {
    for (const { ui, fw } of mountedUis(sys, d)) {
      if (fw !== "phoenixLiveView") continue;
      for (const { component, primitive } of heexComponentHostStateUses(ui)) {
        diags.push({
          severity: "error",
          code: "loom.heex-component-host-state-unsupported",
          message: diagMessage("loom.heex-component-host-state-unsupported", {
            component,
            primitive,
            dName: d.name,
          }),
          source: `${ui.name}/${component}`,
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

/** Frontends that can render `Chart`.
 *
 *  react reaches a charting LIBRARY through its design pack; the other three
 *  need none — see the rollout note on the gate below. */
/** `Chart` on a target that can't render it.
 *
 *  `primitive-chart` is in `REQUIRED_PRIMITIVES.tsx.core`, so a react pack
 *  missing it is a pack-LOAD failure rather than something to re-check here.
 *  This gate is the per-FRAMEWORK rule, exactly like
 *  `validateDataGridFramework`.
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
 *  The Set names every shipping framework, so the gate fires for nothing that
 *  exists today — it is the seam a NEW frontend
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
// These ship a projections api module + the walker's
// Pattern H; the remaining frontends have no client, so a page reading a
// projection there would emit an unresolved receiver — `undefined.<Projection>`,
// a runtime TypeError and a build break.  Gate honestly until each ports, the
// same reviewed-gap discipline as the backend-side projection gates.
//
// NOTE for the sibling ports: this one-line Set is edited by every frontend's
// port PR, so it conflicts on rebase.  Resolve by keeping EVERY framework
// already present plus yours — never by taking one side wholesale.
//
// The Set names every shipping framework, so the gate fires for nothing that
// exists today — it is the seam a NEW frontend
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
      // read moved into one renders into the page all the same.
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
 *  five are walked here.)
 *
 *  `requires` is page-only (a component has no gate expression) and is the
 *  SECURITY-shaped member: `page { requires currentUser.role == "admin" }` is
 *  precisely the place a `currentUser` read is load-bearing.  Without a session
 *  binding the gate expression renders against nothing (`_frontend/gate-expr.ts`
 *  emits the read verbatim), so an unauthenticated ui would ship an access check
 *  that can never evaluate — clean validation, no guard. */

interface UiRenderHost {
  body?: ExprIR;
  requires?: ExprIR;
  state: { init?: ExprIR }[];
  derived: { expr: ExprIR }[];
  actions: { body: StmtIR[] }[];
}

function hostReadsCurrentUser(host: UiRenderHost): boolean {
  if (exprUsesCurrentUser(host.body)) return true;
  if (exprUsesCurrentUser(host.requires)) return true;
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
  // Flutter subscribes through `generator/flutter/realtime.ts` — the browser's
  // own `EventSource` on the web, a line parser over a streamed `package:http`
  // response natively, behind one conditional-import façade.
  "flutter",
  "static",
]);

// Frontends that realize realtime NATIVELY (Phoenix LiveView pushes over its
// own socket), so no separate SSE wire — a `on` handler is always honored.

const NATIVE_REALTIME_FRONTENDS = new Set<string>(["elixir", "phoenixLiveView"]);

/** Honesty gate for `on <channel>.<Event>` live-event handlers (channels.md
 *  Part I).  A handler on a ui whose serving frontend can't consume realtime
 *  — a framework with no realtime path, or an SSE-consuming frontend pointed
 *  at a serving deployable that doesn't stream the SSE wire — compiles clean
 *  today but emits nothing.  Warn so the silent drop is a reviewed decision,
 *  not a surprise.  Neither arm names a shipped pairing any more (all six
 *  frontends consume, all five backends serve); both stay as the seam the
 *  next target gates on.
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
      // Unknown / non-consuming frontend — no realtime path.  No SHIPPED
      // frontend sits here any more (flutter was the last, and joined
      // `SSE_REALTIME_FRONTENDS`); this is the seam a new one warns on until it
      // grows realtime consumption.
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
