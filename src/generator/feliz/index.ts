// Feliz frontend generator — projects a Loom `ui` into a Fable/Feliz/Elmish
// (MVU) F# app (fable-elmish-frontend.md).  Model/Msg/init/update are a direct
// PROJECTION off `state {}` + named `action`s (§2/§3b); the `view` rides the
// shared `walkBody` with `felizTarget` + the procedural Feliz pack (§4).
//
// v1 scope: a single-page app (the first example is Counter-class).  Routing
// across multiple pages is a follow-up; a >1-page ui emits every page's view
// but wires only the first into `Program` (with a visible TODO).

import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  FieldIR,
  PageIR,
  SystemIR,
  UiIR,
  UserIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { type PageNameCtx, pageEmitName } from "../../ir/util/page-kind.js";
import { DAISYUI_THEMES } from "../../util/builtin-formats.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../util/naming.js";
import {
  E2E_FIXTURES_TS,
  E2E_PACKAGE_JSON,
  E2E_TSCONFIG_JSON,
  PLAYWRIGHT_CONFIG_TS,
} from "../_frontend/e2e-harness.js";
import { smokeSpec } from "../_frontend/smoke-spec.js";
import { storeMemberLocal } from "../_walker/js-target-helpers.js";
import { walkBody } from "../_walker/walker-core.js";
import { emitPageObjectsForUi } from "../react/pages-emitter.js";
import {
  AUTH_MODULE_CLAIMS,
  FORBIDDEN_VIEW,
  opActionGate,
  renderCurrentUserDecoder,
  renderCurrentUserType,
  renderFelizGate,
  uiHasPageGate,
} from "./auth-gate.js";
import { felizTarget } from "./feliz-target.js";
import { type FsExprCtx, renderFsExpr, storeModelField, storeMsgCase } from "./fs-expr.js";
import { felizPack } from "./pack.js";
import {
  msgCase,
  renderInit,
  renderModel,
  renderMsg,
  renderPageCmd,
  renderUpdate,
} from "./update-emit.js";
import {
  collectPageActions,
  collectPageAsyncEffects,
  collectPageBoundState,
  collectPageForms,
  collectPageMutations,
  collectPageOperationForms,
  collectPageReads,
  collectPageWorkflowForms,
  type FelizAction,
  type FelizAsyncEffect,
  type FelizBoundState,
  type FelizForm,
  type FelizMutation,
  type FelizOperationForm,
  type FelizRead,
  type FelizWorkflowForm,
  felizAllRead,
  formHasFieldErrors,
  idLabelsFrom,
  renderApiModule,
  renderAsyncOutcomeTypes,
  renderEncoders,
  renderFormTypes,
  renderValidation,
  renderViewModule,
  renderWireTypes,
} from "./wire.js";

/** The `Remote<'T>` envelope every read's Model field carries — the MVU
 *  analogue of TanStack's `{ isLoading, isError, data }` (§2.3). */
const REMOTE_TYPE = `type Remote<'T> =
  | Loading
  | LoadError of string
  | Loaded of 'T`;

/** The auth session gate (D-AUTH-OIDC).  `SessionState` gates the whole app;
 *  the `Auth` module probes `/api/auth/me` (status-only) and redirects to the
 *  backend's `/auth/login`/`/auth/logout` handshake (Loom owns no auth runtime).
 *  Emitted only when the target backend is `auth: required` + this ui `auth: ui`. */
const SESSION_TYPE = `type SessionState =
  | Checking
  | Authed
  | Anon`;
const AUTH_MODULE = `module Auth =
  let checkSession () : Async<bool> =
    async {
      let! (status, _) = Http.get "/api/auth/me"
      return status = 200
    }
  let signIn () : unit = window.location.href <- "/api/auth/login"
  let signOut () : unit = window.location.href <- "/api/auth/logout"`;

/** The gate `view` — matches `Session`: a probe-in-flight spinner, an
 *  unauthenticated sign-in prompt, or the real `appView` once authed. */
function renderAuthGate(): string {
  return [
    "let view (model: Model) (dispatch: Msg -> unit) =",
    "  match model.Session with",
    '  | Checking -> Html.div [ prop.className "flex min-h-screen items-center justify-center"; prop.children [ Html.span [ prop.className "loading loading-spinner loading-lg" ] ] ]',
    "  | Anon ->",
    '      Html.div [ prop.className "flex min-h-screen flex-col items-center justify-center gap-4"; prop.children [',
    '        Html.p [ Html.text "Please sign in." ]',
    '        Html.button [ prop.className "btn btn-primary"; prop.onClick (fun _ -> Auth.signIn ()); prop.text "Sign in" ]',
    "      ] ]",
    "  | Authed -> appView model dispatch",
  ].join("\n");
}

export interface GenerateFelizOptions {
  apiBaseUrl?: string;
}

/** Indent every line of `block` by `n` spaces. */
function indentBlock(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

/** Emit the dispatch wrappers a page's view needs — one `let <action> … =
 *  dispatch <Msg>` per action USED by the body.  The effect body is projected
 *  into `update`; the view handler only dispatches. */
function dispatchWrappers(
  page: PageIR,
  used: ReadonlySet<string>,
  asyncEffectActions: ReadonlyMap<string, FelizAsyncEffect> = new Map(),
): string[] {
  const stateNames = new Set(page.state.map((s) => s.name));
  // Args are rendered in the VIEW's scope — a state read resolves to
  // `model.<Field>`; the route `id` is a bound local of the detail-page view fn.
  const argCtx: FsExprCtx = { stateNames, locals: new Set(["id"]) };
  return page.actions
    .filter((a) => used.has(a.name))
    .map((a) => {
      // An async-effect action's body is a `match await` — its trigger Msg
      // carries the route `id` (the detail-page view fn's `id` param) plus any op
      // args, so the wrapper dispatches `<Trigger> id` / `<Trigger> (id, …args)`.
      const effect = asyncEffectActions.get(a.name);
      if (effect) {
        if (effect.params.length === 0) {
          return `    let ${a.name} () = dispatch (${msgCase(a.name)} id)`;
        }
        const args = effect.params.map((p) => renderFsExpr(p.argExpr, argCtx)).join(", ");
        return `    let ${a.name} () = dispatch (${msgCase(a.name)} (id, ${args}))`;
      }
      const p = a.params[0]?.name;
      return p
        ? `    let ${a.name} ${p} = dispatch (${msgCase(a.name)} ${p})`
        : `    let ${a.name} () = dispatch ${msgCase(a.name)}`;
    });
}

/** Emit the store-member local bindings a page's body references (Stage 5).
 *  Stores fold into the single Elmish Model, so a used store FIELD binds to its
 *  namespaced Model read (`let count = model.CartCount`) and a used store ACTION
 *  binds to a dispatcher (`let clear () = dispatch CartClear`) — the same local
 *  name the body walk computed (`storeMemberLocal`, keyed off the page's
 *  binding names), so binding and use-site always agree. */
function storeWrappers(
  page: PageIR,
  ui: UiIR,
  usedStores: ReadonlyMap<string, Set<string>>,
): string[] {
  const reserved = new Set(page.state.map((s) => s.name));
  const storesByName = new Map(ui.stores.map((s) => [s.name, s] as const));
  const lines: string[] = [];
  for (const [storeName, members] of usedStores) {
    const store = storesByName.get(storeName);
    if (!store) continue;
    const fieldNames = new Set(store.state.map((f) => f.name));
    const actionsByName = new Map(store.actions.map((a) => [a.name, a] as const));
    for (const member of members) {
      const local = storeMemberLocal(storeName, member, reserved);
      if (fieldNames.has(member)) {
        lines.push(`    let ${local} = model.${storeModelField(storeName, member)}`);
      } else {
        const p = actionsByName.get(member)?.params[0]?.name;
        lines.push(
          p
            ? `    let ${local} ${p} = dispatch (${storeMsgCase(storeName, member)} ${p})`
            : `    let ${local} () = dispatch ${storeMsgCase(storeName, member)}`,
        );
      }
    }
  }
  return lines;
}

/** Render one page's view function under `fnName` (`view` for a single-page
 *  ui, `<pageCamel>View` under routing).  Threads the ui's api params +
 *  reachable aggregates so the shared walker's api-hook detection fires on
 *  `<param>.<agg>.all` reads (the Feliz seams project them to Model reads). */
function renderPageView(
  page: PageIR,
  ui: UiIR,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  workflowsByName: ReadonlyMap<string, WorkflowIR>,
  fnName: string,
  takesRouteId = false,
  /** Aggregate/workflow → owning bounded context, so a form seam can resolve an
   *  enum-typed field's values (→ a `<select>`). */
  bcByAggregate: ReadonlyMap<string, EnrichedBoundedContextIR> = new Map(),
  bcByWorkflow: ReadonlyMap<string, EnrichedBoundedContextIR> = new Map(),
  /** Extern components declared on the ui (name → params) — threaded into the
   *  walker so a body call renders through `felizTarget.renderUserComponent`. */
  externComponents: ReadonlyMap<string, PageIR["params"]> = new Map(),
  /** Extern frontend function names declared on the ui. */
  externFunctionNames: ReadonlySet<string> = new Set(),
  /** Accumulator: names actually USED across the ui's pages, so the App.fs head
   *  can `open` exactly the extern modules referenced (F# unused-open warns). */
  used?: { components: Set<string>; functions: Set<string> },
  /** Action names whose body is a `match await` async effect — their dispatch
   *  wrapper passes the route `id` to the trigger Msg. */
  asyncEffectActions: ReadonlyMap<string, FelizAsyncEffect> = new Map(),
  /** UI-gate mode (D-AUTH-OIDC): the app decodes session claims + holds them on
   *  the Model, so a page carrying `requires` wraps its body in a
   *  `match model.CurrentUser with Some currentUser when <gate> -> … | _ ->
   *  forbiddenView` guard (the client mirror of the backend 403). */
  pageGate = false,
  /** True when the hosting frontend deployable has `auth: ui` — threaded into the
   *  walk so `Action { instance.op }` buttons gate on currentUser-only op
   *  `requires` (the action-level mirror of the page gate). */
  authUi = false,
): string {
  // A detail page's view takes the route `id` (bound by its `Page` case); the
  // body's `byId(id)` renders through the `renderRouteId` seam to this local.
  const idParam = takesRouteId ? " (id: string)" : "";
  const head = `let ${fnName} (model: Model) (dispatch: Msg -> unit)${idParam} =`;
  if (!page.body) return `${head}\n    Html.none`;
  const stateNames = new Set(page.state.map((s) => s.name));
  const result = walkBody(
    page.body,
    felizTarget,
    felizPack(),
    new Set(),
    stateNames,
    externComponents, // userComponents (extern only)
    ui.apiParams,
    aggregatesByName,
    bcByAggregate, // form seams resolve enum-typed fields → <select> options
    workflowsByName, // WorkflowForm(runs:) resolves here
    bcByWorkflow, // workflow-form enum resolution
    new Map(), // paramTypes
    new Map(), // pageRoutes
    externFunctionNames, // extern frontend function names
    new Set(), // derivedNames (Feliz has no page-derived bindings)
    authUi, // gate `Action` buttons on currentUser-only op `requires`
  );
  if (used) {
    for (const c of result.usedUserComponents) used.components.add(c);
    for (const f of result.usedExternFunctions ?? []) used.functions.add(f);
  }
  const wrappers = [
    ...dispatchWrappers(page, result.usedActions ?? new Set(), asyncEffectActions),
    ...storeWrappers(page, ui, result.usedStores ?? new Map()),
  ];
  const body = indentBlock(result.tsx, 4);
  const preamble = wrappers.length > 0 ? `${wrappers.join("\n")}\n` : "";
  // A page `requires <gate>` (under the UI-gate machinery) wraps the body in a
  // claims guard: the bound `currentUser` local is tested by the F#-rendered
  // gate; a failing predicate (or no session) renders `forbiddenView`.
  if (pageGate && page.requires) {
    const gate = renderFelizGate(page.requires, "currentUser");
    const inner = indentBlock(`${preamble}${body}`, 4);
    return [
      head,
      "    match model.CurrentUser with",
      `    | Some currentUser when ${gate} ->`,
      inner,
      "    | _ -> forbiddenView",
    ].join("\n");
  }
  return `${head}\n${preamble}${body}`;
}

/** True when an expression tree reads `currentUser.<claim>` — a member access
 *  whose receiver is a `current-user` ref.  Drives the claims-machinery trigger
 *  (`model.CurrentUser` must exist for the body seam to render). */
function exprUsesCurrentUser(e: import("../../ir/types/loom-ir.js").ExprIR): boolean {
  if (e.kind === "member" && e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
    return true;
  }
  for (const [, v] of Object.entries(e)) {
    if (Array.isArray(v)) {
      for (const c of v)
        if (c && typeof c === "object" && "kind" in c && exprUsesCurrentUser(c)) return true;
    } else if (v && typeof v === "object" && "kind" in v && exprUsesCurrentUser(v as never)) {
      return true;
    }
  }
  return false;
}

/** Derive an F# module reference for an extern component / function from its
 *  `from "<path>"` clause — Fable binds by MODULE, not file path.  Segments
 *  (split on `/` or `.`) are PascalCased and joined with `.`, e.g.
 *  `"widgets/order-chart"` → `Widgets.OrderChart`; write `"my_app/widgets"`
 *  for `MyApp.Widgets`.  The App.fs head `open`s exactly the modules used. */
function externModuleFromPath(path: string): string {
  const pascalSeg = (seg: string): string =>
    seg
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((w) => upperFirst(w))
      .join("");
  return path
    .replace(/^\.?\//, "")
    .split(/[/.]/)
    .filter(Boolean)
    .map(pascalSeg)
    .join(".");
}

// --- Multi-page routing helpers (Feliz.Router) ----------------------------

/** F# `Page` union case for a page.  Uses the aggregate-qualified emit name
 *  (`OrderList`), NOT the scaffold's role-scoped page name (`List`), which
 *  collides across aggregates — three aggregates each scaffold a `List`/`New`/
 *  `Detail`, so the bare name produced duplicate `Page` union cases + view fns
 *  and Fable refused to compile. */
function pageCase(page: PageIR, nameCtx: PageNameCtx): string {
  return upperFirst(pageEmitName(page, nameCtx));
}
/** Per-page view function name (`OrderList` → `orderListView`) — aggregate-
 *  qualified for the same collision reason as {@link pageCase}. */
function pageViewFn(page: PageIR, nameCtx: PageNameCtx): string {
  return `${lowerFirst(pageEmitName(page, nameCtx))}View`;
}
/** A page carries a route param when its `route:` has a `:param` segment
 *  (`/products/:id`) — a detail page.  v1 binds only the FIRST such param, as
 *  the magic route `id`. */
function hasRouteParam(page: PageIR): boolean {
  return (page.route ?? "/").split("/").some((s) => s.startsWith(":"));
}
/** URL segments of a page's `route:` as an F# list pattern.  `/` → `[]`;
 *  `/orders/:id` → `[ "orders"; id ]` (the first `:param` binds the local `id`,
 *  further params match as `_` — single-param detail routes are the v1 shape). */
function routePattern(route: string | undefined): string {
  const segs = (route ?? "/").split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return "[]";
  let bound = false;
  const pats = segs.map((s) => {
    if (!s.startsWith(":")) return `"${s}"`;
    if (bound) return "_";
    bound = true;
    return "id";
  });
  return `[ ${pats.join("; ")} ]`;
}

/** The `Page` union + `parseUrl` — URL segments → the active `Page`.  A detail
 *  page's case carries its route param (`| ProductDetail of string`); `parseUrl`
 *  binds the segment.  Arms are emitted in page order; the catch-all falls back
 *  to the first PARAMLESS page (a valid nullary ctor).  When every page carries a
 *  route param (a degenerate single-detail app), the fallback ctor takes an empty
 *  id (`ProductDetail ""`) so the match still returns a `Page`, not a partially-
 *  applied `string -> Page`. */
function renderRouting(pages: readonly PageIR[], nameCtx: PageNameCtx): string {
  const caseDecl = (p: PageIR): string =>
    hasRouteParam(p) ? `  | ${pageCase(p, nameCtx)} of string` : `  | ${pageCase(p, nameCtx)}`;
  const ctor = (p: PageIR): string =>
    hasRouteParam(p) ? `${pageCase(p, nameCtx)} id` : pageCase(p, nameCtx);
  const union = `type Page =\n${pages.map(caseDecl).join("\n")}`;
  const arms = pages.map((p) => `  | ${routePattern(p.route)} -> ${ctor(p)}`);
  const fallback = pages.find((p) => !hasRouteParam(p)) ?? pages[0]!;
  const fallbackCtor = hasRouteParam(fallback)
    ? `${pageCase(fallback, nameCtx)} ""`
    : pageCase(fallback, nameCtx);
  const parse =
    `let parseUrl (segments: string list) : Page =\n  match segments with\n` +
    `${arms.join("\n")}\n  | _ -> ${fallbackCtor}`;
  return `${union}\n\n${parse}`;
}

/** The root routing `view` — a `React.router` that dispatches `UrlChanged` and
 *  renders the active page's view fn (threading the route `id` to detail pages).
 *  Named `view` normally; `appView` under an auth gate (the gate owns `view`). */
/** Humanise an identifier for a nav label: `ProductNew` → `Product New`. */
function humanizeLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** The persistent daisyUI `navbar` above the routed content — a brand link plus
 *  one menu item per TOP-LEVEL page (a static route, no `:param`; detail pages
 *  are reached from their list, not the nav).  Returns "" when there are fewer
 *  than two top-level pages (a lone nav item isn't worth a bar). */
function renderNavbar(pages: readonly PageIR[], brand: string): string {
  const navPages = pages.filter((p) => !hasRouteParam(p));
  if (navPages.length < 2) return "";
  const items = navPages
    .map((p) => {
      // PATH href (History API routing), not a `#/…` hash link.
      const href = p.route ?? "/";
      return `          Html.li [ prop.children [ Html.a [ prop.href "${href}"; prop.text "${humanizeLabel(p.name)}" ] ] ]`;
    })
    .join("\n");
  return [
    '    Html.div [ prop.className "navbar bg-base-200 rounded-box mb-4"; prop.children [',
    '      Html.div [ prop.className "flex-1"; prop.children [',
    `        Html.a [ prop.className "btn btn-ghost text-xl"; prop.href "/"; prop.text "${humanizeLabel(brand)}" ]`,
    "      ] ]",
    '      Html.div [ prop.className "flex-none"; prop.children [',
    '        Html.ul [ prop.className "menu menu-horizontal px-1"; prop.children [',
    items,
    "        ] ]",
    "      ] ]",
    "    ] ]",
  ].join("\n");
}

function renderRootView(
  pages: readonly PageIR[],
  nameCtx: PageNameCtx,
  fnName = "view",
  brand = "",
): string {
  const arms = pages.map((p) =>
    hasRouteParam(p)
      ? `        | ${pageCase(p, nameCtx)} id -> ${pageViewFn(p, nameCtx)} model dispatch id`
      : `        | ${pageCase(p, nameCtx)} -> ${pageViewFn(p, nameCtx)} model dispatch`,
  );
  const navbar = renderNavbar(pages, brand);
  const router = [
    "    React.router [",
    // PATH-based routing (History API), NOT hash (`#/…`) — the generated SPA
    // routes like every other Loom frontend, so the shared page objects (and any
    // deep link) reach a page by its real path.  `pathMode` + `Router.currentPath`
    // + `Router.navigatePath` / `Cmd.navigatePath` are the matched path-mode set.
    "      router.pathMode",
    "      router.onUrlChanged (UrlChanged >> dispatch)",
    "      router.children [",
    "        match model.CurrentPage with",
    ...arms,
    "      ]",
    "    ]",
  ];
  // A persistent app shell wraps the router so the navbar stays put across route
  // changes (only the router's children swap).  With no navbar (a single top-
  // level page) the router is the view body directly — byte-identical to before.
  if (navbar === "") {
    return [
      `let ${fnName} (model: Model) (dispatch: Msg -> unit) =`,
      ...router.map((l) => l.replace(/^ {2}/, "")),
    ].join("\n");
  }
  return [
    `let ${fnName} (model: Model) (dispatch: Msg -> unit) =`,
    "  Html.div [",
    "    prop.children [",
    navbar,
    ...router,
    "    ]",
    "  ]",
  ].join("\n");
}

/** The api reads a ui issues, across ALL its pages (deduped by Model field) —
 *  the single source both `App.fs` (wire layer + MVU) and `App.fsproj` (package
 *  refs) read. */
function readsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizRead[] {
  const aggregateNames = new Set<string>();
  for (const c of contexts) for (const a of c.aggregates) aggregateNames.add(a.name);
  const apiParamNames = new Set(ui.apiParams.map((p) => p.name));
  const nameCtx: PageNameCtx = {
    aggregateNames: [...aggregateNames],
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };
  const seen = new Set<string>();
  const out: FelizRead[] = [];
  for (const page of ui.pages) {
    for (const r of collectPageReads(page, apiParamNames, aggregateNames, nameCtx)) {
      if (seen.has(r.field)) continue;
      seen.add(r.field);
      out.push(r);
    }
  }
  return out;
}

/** The mutations a ui issues, across ALL its pages (deduped by aggregate) —
 *  v1 covers `DestroyForm(of: X)` deletes. */
function mutationsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizMutation[] {
  const aggregateNames = new Set<string>();
  for (const c of contexts) for (const a of c.aggregates) aggregateNames.add(a.name);
  const seen = new Set<string>();
  const out: FelizMutation[] = [];
  for (const page of ui.pages) {
    for (const m of collectPageMutations(page, aggregateNames)) {
      if (seen.has(m.aggregate)) continue;
      seen.add(m.aggregate);
      out.push(m);
    }
  }
  return out;
}

/** All enum declarations across a ui's contexts, keyed name → values — so a
 *  form's enum-typed field resolves to a `<select>`.  Built the same in the
 *  MVU-assembly collectors (here) and the view seams (from the owning BC), so a
 *  form's field set is identical on both sides. */
function enumsFromContexts(contexts: EnrichedBoundedContextIR[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of contexts) for (const e of c.enums) out.set(e.name, e.values);
  return out;
}

/** Every aggregate → its `idselect` option-label field (`display` derived or
 *  `id`), across a ui's contexts.  Built identically here (MVU assembly) and in
 *  the view seam (from `ctx.aggregatesByName`) so a form's field set agrees. */
function idLabelsFromContexts(contexts: EnrichedBoundedContextIR[]): Map<string, string> {
  return idLabelsFrom(contexts.flatMap((c) => c.aggregates));
}

/** Every value object → its fields, across a ui's contexts — so a VO-typed form
 *  field flattens into per-sub-field inputs.  Built identically here and in the
 *  seam (from the owning BC) so the flattened field set agrees. */
function vosFromContexts(contexts: EnrichedBoundedContextIR[]): Map<string, readonly FieldIR[]> {
  const out = new Map<string, readonly FieldIR[]>();
  for (const c of contexts) for (const vo of c.valueObjects) out.set(vo.name, vo.fields);
  return out;
}

/** The create forms a ui hosts, across ALL its pages (deduped by aggregate) —
 *  `CreateForm(of: X)`. */
function formsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizForm[] {
  const aggregatesByName = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const enumsByName = enumsFromContexts(contexts);
  const idLabels = idLabelsFromContexts(contexts);
  const vosByName = vosFromContexts(contexts);
  const seen = new Set<string>();
  const out: FelizForm[] = [];
  for (const page of ui.pages) {
    for (const f of collectPageForms(page, aggregatesByName, enumsByName, idLabels, vosByName)) {
      if (seen.has(f.aggregate)) continue;
      seen.add(f.aggregate);
      out.push(f);
    }
  }
  return out;
}

/** The operation forms a ui hosts, across ALL its pages (deduped by form type) —
 *  `OperationForm(of: X, op: Y)`. */
function operationFormsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizOperationForm[] {
  const aggregatesByName = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const enumsByName = enumsFromContexts(contexts);
  const idLabels = idLabelsFromContexts(contexts);
  const vosByName = vosFromContexts(contexts);
  const seen = new Set<string>();
  const out: FelizOperationForm[] = [];
  for (const page of ui.pages) {
    for (const f of collectPageOperationForms(
      page,
      aggregatesByName,
      enumsByName,
      idLabels,
      vosByName,
    )) {
      if (seen.has(f.formType)) continue;
      seen.add(f.formType);
      out.push(f);
    }
  }
  return out;
}

/** The one-click actions a ui hosts (`Action { instance.op }`), across ALL its
 *  pages (deduped by trigger `Msg`) — the fieldless operation buttons. */
function actionsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizAction[] {
  const aggregatesByName = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const seen = new Set<string>();
  const out: FelizAction[] = [];
  for (const page of ui.pages) {
    for (const a of collectPageActions(page, aggregatesByName)) {
      if (seen.has(a.triggerMsg)) continue;
      seen.add(a.triggerMsg);
      out.push(a);
    }
  }
  return out;
}

/** The `match await` async effects a ui hosts, across ALL its pages (deduped by
 *  action name) — `match await <api>.<Agg>.<op>() { <Agg> b => … else => … }`. */
function asyncEffectsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizAsyncEffect[] {
  const aggregatesByName = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  const apiParamNames = new Set(ui.apiParams.map((p) => p.name));
  // Error payloads across the ui's contexts — used to classify a match arm as an
  // error variant (reified from the non-2xx ProblemDetails) vs a success arm.
  const errorPayloadNames = new Set<string>();
  for (const c of contexts)
    for (const p of c.payloads) if (p.kind === "error") errorPayloadNames.add(p.name);
  const seen = new Set<string>();
  const out: FelizAsyncEffect[] = [];
  for (const page of ui.pages) {
    for (const e of collectPageAsyncEffects(
      page,
      aggregatesByName,
      apiParamNames,
      errorPayloadNames,
    )) {
      if (seen.has(e.action)) continue;
      seen.add(e.action);
      out.push(e);
    }
  }
  return out;
}

/** All workflows reachable from a ui's contexts, keyed by name. */
function workflowsForUi(contexts: EnrichedBoundedContextIR[]): Map<string, WorkflowIR> {
  const out = new Map<string, WorkflowIR>();
  for (const c of contexts) for (const w of c.workflows) out.set(w.name, w);
  return out;
}

/** The workflow forms a ui hosts, across ALL its pages (deduped by workflow) —
 *  `WorkflowForm(runs: X)`. */
function workflowFormsForUi(ui: UiIR, contexts: EnrichedBoundedContextIR[]): FelizWorkflowForm[] {
  const workflowsByName = workflowsForUi(contexts);
  const enumsByName = enumsFromContexts(contexts);
  const idLabels = idLabelsFromContexts(contexts);
  const vosByName = vosFromContexts(contexts);
  const seen = new Set<string>();
  const out: FelizWorkflowForm[] = [];
  for (const page of ui.pages) {
    for (const f of collectPageWorkflowForms(
      page,
      workflowsByName,
      enumsByName,
      idLabels,
      vosByName,
    )) {
      if (seen.has(f.formType)) continue;
      seen.add(f.formType);
      out.push(f);
    }
  }
  return out;
}

/** The page `state` fields a ui's controlled inputs two-way-bind, across ALL
 *  pages (deduped by name) — each gets a `Set<Field>` Msg + update arm so the
 *  input `onChange` can dispatch it. */
function boundStateForUi(ui: UiIR): FelizBoundState[] {
  const seen = new Set<string>();
  const out: FelizBoundState[] = [];
  for (const page of ui.pages)
    for (const b of collectPageBoundState(page))
      if (!seen.has(b.name)) {
        seen.add(b.name);
        out.push(b);
      }
  return out;
}

/** A ui's `state {}` fields across ALL pages, deduped by name (multi-page uis
 *  share one flat Model; distinct pages should use distinct field names). */
function combinedState(ui: UiIR): PageIR["state"][number][] {
  const seen = new Set<string>();
  const out: PageIR["state"][number][] = [];
  for (const page of ui.pages)
    for (const f of page.state)
      if (!seen.has(f.name)) {
        seen.add(f.name);
        out.push(f);
      }
  return out;
}

/** A ui's named `action`s across ALL pages, deduped by name. */
function combinedActions(ui: UiIR): PageIR["actions"][number][] {
  const seen = new Set<string>();
  const out: PageIR["actions"][number][] = [];
  for (const page of ui.pages)
    for (const a of page.actions)
      if (!seen.has(a.name)) {
        seen.add(a.name);
        out.push(a);
      }
  return out;
}

/** Assemble the single `App.fs` module for a ui.  A ui with >1 page emits a
 *  `Page` union + `parseUrl` + a `React.router` root over a combined Model
 *  (`Feliz.Router`); a single-page ui stays byte-for-byte as before.  When any
 *  page issues api reads the file also carries the wire layer (Thoth decoders +
 *  a `Cmd`-based `Api` module + the `Remote`/`View` helpers). */
function renderAppFs(
  ui: UiIR,
  contexts: EnrichedBoundedContextIR[],
  authUi = false,
  /** System `user { }` claim shape — present whenever `authUi` is true (the
   *  gate requires it).  Drives the `CurrentUser` record + decoder emitted when
   *  a page carries a `requires` UI gate. */
  user?: UserIR,
): string {
  const pages = ui.pages;
  if (pages.length === 0) {
    return `module App\n\nopen Feliz\n\n// ui '${ui.name}' declares no pages\n`;
  }
  const aggregatesByName = new Map<string, AggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) aggregatesByName.set(a.name, a);
  // Aggregate-qualified page-name context (`classifyPage` inputs) — the scaffold
  // pages are role-scoped (`List`/`New`/`Detail`), so the `Page` union cases +
  // view fn names must qualify by aggregate or they collide (Fable error 37).
  const nameCtx: PageNameCtx = {
    aggregateNames: [...aggregatesByName.keys()],
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };
  // One-click actions (`Action { instance.op }`) — the fieldless operation
  // buttons; their trigger/done Msg + POST Cmd + refetch wire like a mutation.
  const opActions: FelizAction[] = actionsForUi(ui, contexts);
  // UI-gate mode: an `auth: ui` app (claims available) where a page declares
  // `requires` OR an action button gates on a currentUser-only op `requires`.
  // Either upgrades the status-only probe to a claims decode + adds `CurrentUser`
  // to the Model.  A gate-free auth app stays byte-for-byte on the boolean probe.
  const aggByNameEnriched = new Map<string, EnrichedBoundedContextIR["aggregates"][number]>();
  for (const c of contexts) for (const a of c.aggregates) aggByNameEnriched.set(a.name, a);
  const hasGatedAction = opActions.some((act) => {
    const op = aggByNameEnriched.get(act.aggregate)?.operations.find((o) => o.name === act.op);
    return !!op && opActionGate(op) !== null;
  });
  // A body that reads `currentUser.<claim>` also needs the decoded claims on the
  // Model (the read-side of the gate) — it joins the same claims-machinery trigger.
  const bodyUsesCurrentUser = ui.pages.some((p) => p.body && exprUsesCurrentUser(p.body));
  const pageGate = authUi && !!user && (uiHasPageGate(ui) || hasGatedAction || bodyUsesCurrentUser);
  const workflowsByName = workflowsForUi(contexts);
  // Aggregate/workflow → owning bounded context (form seams resolve enum-typed
  // fields to their `<select>` values from the owning BC's enum declarations).
  const bcByAggregate = new Map<string, EnrichedBoundedContextIR>();
  const bcByWorkflow = new Map<string, EnrichedBoundedContextIR>();
  for (const c of contexts) {
    for (const a of c.aggregates) bcByAggregate.set(a.name, c);
    for (const w of c.workflows) bcByWorkflow.set(w.name, c);
  }

  // Extern frontend hatches (extern-{component,function}-escape-hatch.md): the
  // extern components (name → params, threaded into the walker's userComponents
  // so a body call routes to `felizTarget.renderUserComponent`) and the extern
  // function names.  `used` accumulates what the page walks actually reference
  // so the App.fs head `open`s exactly the modules used (F# unused-open warns).
  const externComponents = new Map<string, PageIR["params"]>(
    ui.components.filter((c) => c.extern).map((c) => [c.name, c.params]),
  );
  const externFunctionNames = new Set((ui.functions ?? []).map((f) => f.name));
  const used = { components: new Set<string>(), functions: new Set<string>() };
  // Module lookup for a used extern name → its `from`-path-derived F# module.
  const componentModule = new Map(
    ui.components
      .filter((c) => c.extern)
      .map((c) => [c.name, externModuleFromPath(c.externPath ?? "")]),
  );
  const functionModule = new Map(
    (ui.functions ?? []).map((f) => [f.name, externModuleFromPath(f.externPath)]),
  );
  const mutations: FelizMutation[] = mutationsForUi(ui, contexts);
  const forms: FelizForm[] = formsForUi(ui, contexts);
  const operationForms: FelizOperationForm[] = operationFormsForUi(ui, contexts);
  const workflowForms: FelizWorkflowForm[] = workflowFormsForUi(ui, contexts);
  // `match await` async effects — projected to trigger/result Msg cases + arms
  // (excluded from the plain-action path below) and a `type`-tagged decode.
  const asyncEffects: FelizAsyncEffect[] = asyncEffectsForUi(ui, contexts);
  const asyncEffectActions = new Map(asyncEffects.map((e) => [e.action, e] as const));
  const hasEffects = asyncEffects.length > 0;
  const formRecords = [...forms, ...operationForms, ...workflowForms]; // shared type/encoder wiring
  // Foreign-key `idselect` fields need the target aggregate's `.all` loaded to
  // populate their options — an IMPLICIT list read per target, merged into the
  // page's read set (deduped against any explicit QueryView `.all` of it) so the
  // whole Remote/Api/Model/init/update wiring is emitted for free.
  const fkTargets = new Set<string>();
  for (const form of formRecords)
    for (const fld of form.fields) if (fld.idTarget) fkTargets.add(fld.idTarget);
  const hasIdSelect = fkTargets.size > 0;
  const reads: FelizRead[] = readsForUi(ui, contexts);
  const readFields = new Set(reads.map((r) => r.field));
  for (const target of fkTargets) {
    const r = felizAllRead(target);
    if (!readFields.has(r.field)) {
      readFields.add(r.field);
      reads.push(r);
    }
  }
  const hasReads = reads.length > 0;
  const hasForms = formRecords.length > 0;
  // Any form with a message-bearing (required) field → the `View.fieldError`
  // helper must ship even on a form-only page that has no reads.
  const hasFieldErrors = formRecords.some(formHasFieldErrors);
  // Http/Api are needed for reads, mutations, forms (POST) AND async effects
  // (POST + decode); the auth probe also uses `Http.get`.  The Thoth
  // record/decoder layer is needed for reads AND async effects (the op's
  // `type`-tagged 200 body); the `Remote`/View envelope is reads-only.
  const hasHttp =
    hasReads ||
    mutations.length > 0 ||
    hasForms ||
    authUi ||
    hasEffects ||
    pageGate ||
    opActions.length > 0;
  const hasWire = hasReads || hasEffects;
  // A ui is routed when it has >1 page OR any page carries a route param (a lone
  // detail page still needs a router to bind its `:id`).
  const routed = pages.length > 1 || pages.some(hasRouteParam);
  const pageCmd = renderPageCmd(reads); // "" unless byId reads exist

  // MVU triple is built from the COMBINED (all-page, deduped) state + actions;
  // a single-page ui's combined lists are exactly its one page's.  Stores fold
  // into the SAME single-program Model/Msg/update: each store field becomes a
  // namespaced Model field (`Cart` + `count` → `CartCount`) and each store
  // action a namespaced Msg case (`CartClear`), so `Cart.count` reads and
  // `Cart.clear()` dispatches resolve against the one model.
  const storeStateFields = ui.stores.flatMap((s) =>
    s.state.map((f) => ({ name: storeModelField(s.name, f.name), type: f.type, init: f.init })),
  );
  const state = [...combinedState(ui), ...storeStateFields];
  // Async-effect actions project to their own trigger/result Msg cases + update
  // arms, so they're excluded from the plain action Msg/update path.
  const actions = combinedActions(ui).filter((a) => !asyncEffectActions.has(a.name));
  // Msg needs a case per store action too (the update arms come from `stores`).
  const msgActions = [
    ...actions,
    ...ui.stores.flatMap((s) =>
      s.actions.map((a) => ({ name: storeMsgCase(s.name, a.name), params: a.params, body: [] })),
    ),
  ];
  // Controlled inputs (`Field`/`Toggle`/… via `bind:`, `Modal` via `open:`)
  // two-way-bind page `state` — each needs a `Set<Field>` Msg + update arm.
  const boundState = boundStateForUi(ui);
  const model = renderModel(state, reads, routed, formRecords, authUi, pageGate);
  const init = renderInit(state, reads, routed, formRecords, authUi, pageGate);
  const msg = renderMsg(
    msgActions,
    reads,
    routed,
    mutations,
    forms,
    operationForms,
    workflowForms,
    authUi,
    asyncEffects,
    pageGate,
    opActions,
    boundState,
  );
  const update = renderUpdate(
    actions,
    state,
    reads,
    routed,
    mutations,
    forms,
    operationForms,
    workflowForms,
    authUi,
    ui.stores,
    asyncEffects,
    pageGate,
    opActions,
    boundState,
  );
  const wire = hasWire
    ? renderWireTypes(
        reads,
        contexts,
        asyncEffects.flatMap((e) => e.extraAggregates),
        asyncEffects.flatMap((e) => e.extraErrorPayloads),
      )
    : { domain: "", decoders: "" };
  // Multi-variant async effects emit a discriminated-union outcome type, placed
  // right after the domain records (its cases reference them).
  const asyncOutcomes = renderAsyncOutcomeTypes(asyncEffects);
  const api = hasHttp
    ? renderApiModule(
        reads,
        mutations,
        forms,
        operationForms,
        workflowForms,
        asyncEffects,
        opActions,
      )
    : "";
  const formTypes = hasForms ? renderFormTypes(formRecords) : "";
  const encoders = hasForms ? renderEncoders(formRecords) : "";
  const validation = hasForms ? renderValidation(formRecords) : "";

  // Views: one root view (single-page) OR per-page `<page>View` functions + a
  // `React.router` root.  Under an auth gate the root is named `appView` and the
  // emitted `view` is the gate (Checking → Anon sign-in → Authed appView).
  const rootFn = authUi ? "appView" : "view";
  const rootViews = routed
    ? [
        ...pages.map((p) =>
          renderPageView(
            p,
            ui,
            aggregatesByName,
            workflowsByName,
            pageViewFn(p, nameCtx),
            hasRouteParam(p),
            bcByAggregate,
            bcByWorkflow,
            externComponents,
            externFunctionNames,
            used,
            asyncEffectActions,
            pageGate,
            authUi,
          ),
        ),
        "",
        renderRootView(pages, nameCtx, rootFn, ui.name),
      ]
    : [
        renderPageView(
          pages[0]!,
          ui,
          aggregatesByName,
          workflowsByName,
          rootFn,
          false, // single-page (non-routed) branch: no `:id` route param
          bcByAggregate,
          bcByWorkflow,
          externComponents,
          externFunctionNames,
          used,
          asyncEffectActions,
          pageGate,
          authUi,
        ),
      ];
  // A gated app defines `forbiddenView` ahead of the page views that render it
  // (the claims-fallback element).
  const gatedViews = pageGate ? [FORBIDDEN_VIEW, "", ...rootViews] : rootViews;
  const views = authUi ? [...gatedViews, "", renderAuthGate()] : gatedViews;

  // `open` one line per DISTINCT extern module actually referenced by the page
  // walks (components + functions), so bare `OrderChart {| … |}` /
  // `initials(args)` references resolve.  Deduped + sorted for stable output.
  const externModules = new Set<string>();
  for (const c of used.components) {
    const m = componentModule.get(c);
    if (m) externModules.add(m);
  }
  for (const f of used.functions) {
    const m = functionModule.get(f);
    if (m) externModules.add(m);
  }
  const externOpens = [...externModules].sort().map((m) => `open ${m}`);

  return lines(
    "module App",
    "",
    "open Feliz",
    // Hand-written extern component / function modules (extern-*-escape-hatch.md).
    ...externOpens,
    // Feliz.Router provides `React.router` (routed) AND `Cmd.navigate` (any form
    // navigates on success), so a single-page ui with a form still needs it.
    (routed || hasForms) && "open Feliz.Router",
    "open Elmish",
    "open Elmish.React",
    // Thoth is needed for decoders (reads + async effects), encoders (forms),
    // AND the UI-gate claims decode.
    (hasReads || hasForms || hasEffects || pageGate) && "open Thoth.Json",
    hasHttp && "open Fable.SimpleHttp",
    // Browser.Dom provides `window` for the auth sign-in/out redirects.
    authUi && "open Browser.Dom",
    // Auth session gate — SessionState (gates the Model) + the Auth probe module.
    // Under a page gate the probe decodes the verified claims into `CurrentUser`
    // (record + decoder ahead of the claims-variant Auth module); a gate-free
    // auth app stays on the status-only boolean probe.
    authUi && "",
    authUi && SESSION_TYPE,
    pageGate && user ? "" : false,
    pageGate && user ? renderCurrentUserType(user) : false,
    pageGate && user ? "" : false,
    pageGate && user ? renderCurrentUserDecoder(user) : false,
    authUi && "",
    authUi && (pageGate ? AUTH_MODULE_CLAIMS : AUTH_MODULE),
    // Wire layer — domain records + decoders when there are reads OR async
    // effects; the `Remote` envelope is reads-only (async effects don't use it).
    hasWire && "",
    hasWire && wire.domain,
    hasReads && "",
    hasReads && REMOTE_TYPE,
    hasWire && "",
    hasWire && wire.decoders,
    // Multi-variant async-effect outcome unions (after the records they wrap).
    asyncOutcomes ? "" : false,
    asyncOutcomes || undefined,
    // Create-form state (form record types + empty values) → encoders (write dir)
    // → validation (submit guard: every required field non-empty).
    hasForms && "",
    hasForms && formTypes,
    hasForms && "",
    hasForms && encoders,
    hasForms && validation ? "" : false,
    validation || undefined,
    // Api module — reads (fetch + decode), mutations (verb request), creates (POST).
    hasHttp && "",
    hasHttp && api,
    // View helpers — Remote matchers (reads) + the per-field `fieldError` matcher
    // (validated forms), so a form-only page still gets the helper.
    (hasReads || hasFieldErrors) && "",
    (hasReads || hasFieldErrors) && renderViewModule(reads, hasIdSelect, hasFieldErrors),
    // Routing table (multi-page only) — Page union + parseUrl, ahead of Model.
    routed && "",
    routed && renderRouting(pages, nameCtx),
    "",
    model,
    "",
    msg,
    // `pageCmd` (byId reads only) fires a detail read on entry; sits after Msg
    // (it references the read's `Loaded` case) and before init (which feeds it).
    pageCmd ? "" : false,
    pageCmd || undefined,
    "",
    init,
    "",
    update,
    "",
    views.join("\n"),
    "",
    "Program.mkProgram init update view",
    '|> Program.withReactSynchronous "root"',
    "|> Program.run",
    "",
  );
}

// The wire layer pulls in two more packages (proposal §10 known-good pins):
// Fable.SimpleHttp for the fetch, Thoth.Json for the decoders.  A read-free
// (Counter-class) app omits them so its project stays minimal.
// A multi-page ui additionally pulls in Feliz.Router for URL routing.
function fsproj(hasHttp: boolean, needsRouter: boolean, authUi = false): string {
  const wireRefs = hasHttp
    ? `
    <PackageReference Include="Fable.SimpleHttp" Version="3.6.0" />
    <PackageReference Include="Thoth.Json" Version="10.2.0" />`
    : "";
  const routerRef = needsRouter
    ? `
    <PackageReference Include="Feliz.Router" Version="4.0.0" />`
    : "";
  // The auth gate's sign-in/out redirects use `window` (Fable.Browser.Dom).
  const authRef = authUi
    ? `
    <PackageReference Include="Fable.Browser.Dom" Version="2.14.0" />`
    : "";
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="src/App.fs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Fable.Core" Version="4.3.0" />
    <PackageReference Include="Feliz" Version="2.8.0" />
    <PackageReference Include="Fable.Elmish.React" Version="4.0.0" />${routerRef}${wireRefs}${authRef}
  </ItemGroup>
</Project>
`;
}

const DOTNET_TOOLS = `{
  "version": 1,
  "isRoot": true,
  "tools": {
    "fable": {
      "version": "4.29.0",
      "commands": ["fable"]
    }
  }
}
`;

const PACKAGE_JSON = (name: string): string =>
  `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        fable: "dotnet tool restore && dotnet fable App.fsproj -o out --extension .js",
        build: "npm run fable && vite build",
        dev: "npm run fable && vite",
      },
      dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
      // Tailwind + daisyUI drive the design system: the pack emits daisyUI
      // component classes (`btn` / `card` / `table` / `badge` / …), Vite runs
      // the Tailwind PostCSS plugin over `styles.css` at build, and daisyUI
      // supplies the component layer + themes.  Pinned to Tailwind v3 / daisyUI
      // v4 (the v3 `@tailwind base` directive syntax, matching the HEEx pack).
      devDependencies: {
        vite: "^5.4.0",
        tailwindcss: "^3.4.0",
        daisyui: "^4.12.0",
        autoprefixer: "^10.4.0",
        postcss: "^8.4.0",
      },
    },
    null,
    2,
  )}\n`;

const VITE_CONFIG = `import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist" },
});
`;

// The default daisyUI theme applied on <html data-theme="…">.  `corporate` is a
// clean, flat, professional light theme; `business` is its dark sibling (wired
// as `darkTheme` so `prefers-color-scheme: dark` degrades gracefully).
const DEFAULT_FELIZ_THEME = "corporate";

/** The daisyUI theme a feliz deployable renders under, chosen by its `design:`
 *  slot.  A `design:` naming a built-in daisyUI theme (`design: dracula`) selects
 *  it; anything else (unset → the lowered `mantine@v7` default, or a non-theme
 *  value) falls back to `corporate`.  The validator (Rule 14, feliz branch)
 *  already rejects a user-written non-theme `design:`, so the fallback only ever
 *  fires for the unset default. */
function felizThemeFor(design: string | undefined): string {
  return design && DAISYUI_THEMES.includes(design) ? design : DEFAULT_FELIZ_THEME;
}

// PostCSS config — Vite auto-discovers this and runs Tailwind + Autoprefixer
// over any CSS it processes (here, `styles.css` linked from index.html).
const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

// Tailwind config — daisyUI is registered as a plugin (it supplies the component
// classes the pack emits).  `content` scans index.html + the Fable-compiled JS
// (`out/**/*.js`, where every \`prop.className "btn"\` becomes a \`"btn"\` string
// literal) so Tailwind keeps exactly the utilities/components in use.
const TAILWIND_CONFIG = (theme: string): string => {
  // Compile in the chosen theme + `business` as the dark sibling (deduped so
  // `design: business` doesn't list it twice).  `data-theme` on <html> picks
  // the active one; `darkTheme` answers `prefers-color-scheme: dark`.
  const themes = [...new Set([theme, "business"])];
  return `import daisyui from "daisyui";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./out/**/*.js"],
  theme: { extend: {} },
  plugins: [daisyui],
  daisyui: {
    themes: ${JSON.stringify(themes)},
    darkTheme: "business",
    logs: false,
  },
};
`;
};

// The design-system stylesheet — Tailwind's three layers (daisyUI injects its
// component classes into the `components` layer) plus a couple of app-shell
// rules the class contract can't express: `#root` is centred to a readable
// measure with page padding, and a scaffold detail's <details>-based Modal gets
// a hanging list-marker reset so the daisyUI `collapse` arrow reads cleanly.
const STYLES_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

/* App shell — centre every page to a readable measure with page padding. */
#root {
  max-width: 64rem;
  margin: 0 auto;
  padding: 2rem 1rem;
}
`;

// Multi-stage build — the Fable step (F# → JS) needs the .NET SDK, the bundle
// step needs Node, so the build stage carries both; the runtime stage serves
// the static bundle.  (Compose-boot verification is a follow-up slice; this
// makes the emitted tree structurally buildable.)
const DOCKERFILE = `# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /app
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
  && apt-get install -y --no-install-recommends nodejs \\
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN dotnet tool restore
RUN npm install
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
RUN printf 'server { listen 3000; root /usr/share/nginx/html; location / { try_files $uri /index.html; } }' \\
  > /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
`;

const INDEX_HTML = (theme: string): string => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Loom · Feliz</title>
    <!-- Vite runs Tailwind (+ daisyUI) PostCSS over this at build; the daisyUI
         component classes the pack emits resolve here. -->
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body class="bg-base-100 text-base-content">
    <div id="root"></div>
    <!-- Fable mirrors the fsproj source layout: src/App.fs → out/src/App.js.
         Relative (not root-absolute) so Vite/Rollup resolves it at build. -->
    <script type="module" src="./out/src/App.js"></script>
  </body>
</html>
`;

/** Generate a Fable/Feliz project for a frontend deployable. */
export function generateFelizForContexts(
  contexts: EnrichedBoundedContextIR[],
  sys: SystemIR,
  deployable: DeployableIR,
  options: GenerateFelizOptions = {},
): Map<string, string> {
  void options;
  const out = new Map<string, string>();
  if (!deployable.uiName) {
    throw new Error(
      `Feliz deployable '${deployable.name}' has no ui binding (uiName). A frontend deployable must target a ui.`,
    );
  }
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  if (!ui) {
    throw new Error(
      `Feliz deployable '${deployable.name}' references ui '${deployable.uiName}' but no such ui is declared.`,
    );
  }
  // fsproj package refs must match what `renderAppFs` emits: SimpleHttp/Thoth
  // when there's any Http (reads or mutations/forms), Feliz.Router when routed
  // (>1 page OR a lone `:id` detail page) OR any form exists (forms navigate via
  // `Cmd.navigate` on success).
  // Auth gate (D-AUTH-OIDC, `auth: ui`): this feliz deployable opts in AND its
  // target backend enforces auth AND the system declares a `user { }` claim
  // shape — mirrors the React frontend's `authUi` gate.
  const target = sys.deployables.find((d) => d.name === deployable.targetName);
  const authUi = !!(deployable.auth?.ui && target?.auth?.required && sys.user);
  const anyForm =
    formsForUi(ui, contexts).length > 0 ||
    operationFormsForUi(ui, contexts).length > 0 ||
    workflowFormsForUi(ui, contexts).length > 0;
  const hasEffects = asyncEffectsForUi(ui, contexts).length > 0;
  const hasHttp =
    readsForUi(ui, contexts).length > 0 ||
    mutationsForUi(ui, contexts).length > 0 ||
    anyForm ||
    authUi ||
    hasEffects;
  const needsRouter = ui.pages.length > 1 || ui.pages.some(hasRouteParam) || anyForm;
  out.set("src/App.fs", renderAppFs(ui, contexts, authUi, sys.user));
  out.set("App.fsproj", fsproj(hasHttp, needsRouter, authUi));
  out.set(".config/dotnet-tools.json", DOTNET_TOOLS);
  const theme = felizThemeFor(deployable.design);
  out.set("package.json", PACKAGE_JSON(`${deployable.name}-feliz`));
  out.set("vite.config.js", VITE_CONFIG);
  out.set("index.html", INDEX_HTML(theme));
  out.set("styles.css", STYLES_CSS);
  out.set("tailwind.config.js", TAILWIND_CONFIG(theme));
  out.set("postcss.config.js", POSTCSS_CONFIG);
  out.set("Dockerfile", DOCKERFILE);

  // --- Playwright e2e harness (framework-neutral, testid-driven) ----------
  // The page objects + smoke spec + e2e config are SHARED with every other
  // frontend — they locate elements by `data-testid`, which the Feliz pack +
  // form seams now emit (feliz testid-emission PR).  Feliz renders native
  // `<select>`s, so the fill blocks drive choice fields via `selectOption`
  // (`selectStyle: "native"`, like Svelte).  Walker page objects are disabled
  // (`false`, like Angular): Feliz forms render through the `felizTarget` seams,
  // not pack `field-input`/`form-of` templates, so driving the TSX walker
  // against the procedural feliz pack would misfire — the scaffold-archetype
  // page objects stay framework-neutral and emit regardless.  The `.ui.spec.ts`
  // itself is emitted by the system orchestrator (`mountsUi`).  The page-object
  // `import type { <Agg>Request }` lines point at a TS api module Feliz doesn't
  // emit (its client is F#), but they are TYPE-only — esbuild (Playwright's
  // loader) erases them at runtime, so the specs run against the built bundle.
  const e2eAggregatesByName = new Map<string, AggregateIR>();
  for (const c of contexts) for (const a of c.aggregates) e2eAggregatesByName.set(a.name, a);
  const pageObjects = emitPageObjectsForUi(
    ui,
    {
      sys,
      deployable,
      aggregatesByName: e2eAggregatesByName,
      contextsByName: new Map<string, BoundedContextIR>(contexts.map((c) => [c.name, c])),
      pack: felizPack(),
      topLevelComponents: [],
    },
    /* walkerPageObjects */ false,
    /* selectStyle */ "native",
  );
  for (const [p, content] of pageObjects) out.set(p, content);
  const e2ePageNameCtx: PageNameCtx = {
    aggregateNames: [...e2eAggregatesByName.keys()],
    workflowNames: contexts.flatMap((c) => c.workflows.map((w) => w.name)),
    viewNames: contexts.flatMap((c) => c.views.map((v) => v.name)),
  };
  out.set("e2e/smoke.spec.ts", smokeSpec(ui, e2ePageNameCtx));
  out.set("e2e/fixtures.ts", E2E_FIXTURES_TS);
  out.set("e2e/playwright.config.ts", PLAYWRIGHT_CONFIG_TS);
  out.set("e2e/package.json", E2E_PACKAGE_JSON);
  out.set("e2e/tsconfig.json", E2E_TSCONFIG_JSON);

  return out;
}
