// Page emitter.
//
// Walks `ui.pages` (after scaffold expansion: explicit pages + scaffold
// rewrites + shared Home / WorkflowsIndex) and emits one
// TSX file per page, dispatching by `archetype.kind` to the
// per-archetype builders.  Single entry point for page emission from
// the React index orchestrator.
//
// What this emitter does:
// - Page emission via one call to `emitPagesForUi`.
// - Dispatches to `renderListPage`, `buildNewPage`, `buildDetailPage`,
//   `buildWorkflowFormPage`, `buildWorkflowsIndexPage`, `homeTsx`.
//
// What this emitter intentionally doesn't touch:
// - Per-aggregate api modules (`src/api/<agg>.ts`) — emitted by
//   `index.ts` via the aggregate iteration.
// - Per-aggregate / per-workflow Playwright page objects
//   under `e2e/pages/` — emitted alongside, not from here.
// - Project shell (App.tsx, main.tsx, vite.config.ts, package.json,
//   theme, smoke spec) — orthogonal to the page metamodel.
//
// Hand-written (custom) pages flow through the closed-stdlib component
// emission path, not the per-archetype dispatch below.

import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  DeployableIR,
  ParamIR,
  SystemIR,
  UiIR,
} from "../../ir/types/loom-ir.js";
import {
  classifyPage,
  type PageNameCtx,
  pageConstructId,
  pageEmitName,
} from "../../ir/util/page-kind.js";
import { lowerFirst, snake } from "../../util/naming.js";
import { buildWorkflowPageObject } from "../_frontend/workflows-module.js";
import type { LoadedPack } from "../_packs/loader.js";
import type { SourceMapRecorder } from "../_trace/sourcemap.js";
import { isWalkableLayoutBody, walkBodyToTsx } from "./body-walker.js";
import {
  buildExternFunctionShim,
  buildExternFunctionSignature,
} from "./extern-function-builder.js";
import { buildPageObjectModule, type SelectStyle } from "./page-objects-builder.js";
import {
  renderCustomLayoutPage,
  renderExternComponentProps,
  renderExternComponentShim,
  renderUserComponentFile,
} from "./walker/page-shell.js";
import { buildWalkerPageObject } from "./walker-page-objects.js";

/** Inputs the page emitter needs in addition to the page IR.  Kept as
 *  a struct so additions (theme overrides, design-pack picks, sidebar
 *  spec) don't require re-threading every call site. */
export interface PageEmitContext {
  sys: SystemIR;
  deployable: DeployableIR;
  /** Pre-walked aggregates from the deployable's reachable contexts.
   *  Used by the per-aggregate builders to resolve `X id` cross-
   *  references to display fields. */
  aggregatesByName: Map<string, AggregateIR>;
  /** Map context name → `BoundedContextIR` for fast `archetype`
   *  → ctx lookup. */
  contextsByName: Map<string, BoundedContextIR>;
  /** Loaded design pack.  Used by the list-page renderer; other
   *  archetypes use the procedural per-archetype builders. */
  pack: LoadedPack;
  /** Top-level (workspace-wide) components from `LoomModel.components`.
   *  Merged into the per-ui name→params map at emission so a page
   *  body can invoke them by bare name; their emitted file lands at
   *  `src/components/<Name>.tsx` alongside ui-scope components.  A
   *  ui-scope component with the same name overrides the top-level
   *  one (the ui-scope iteration runs second and wins). */
  topLevelComponents: readonly ComponentIR[];
  /** True when this frontend opts into `auth: ui` against an `auth: required`
   *  backend — `useSession()` + the verified claims are then available, so a
   *  page's `requires` gate renders a client-side `<Forbidden/>` guard.
   *  Optional: only the React host wires the page gate today (Vue/Svelte reuse
   *  this context but don't yet consume it), so absent means "ungated". */
  authUi?: boolean;
  /** Generate-time source-map recorder (`--sourcemap`) — see
   *  `PlatformSurface.emitProject`'s doc comment.  Absent means "record
   *  nothing" (the default, flag-off shape). */
  sourcemap?: SourceMapRecorder;
}

/** Compute the relative-path prefix from a page's emit
 *  path back to the `src/` root.  Used by the walker shell to
 *  rewrite per-pack `../api/X` and `../lib/format` imports so they
 *  resolve correctly regardless of how deep the page lives.
 *
 *    src/pages/x.tsx                 → "../"
 *    src/pages/orders/list.tsx       → "../../"
 *    src/pages/workflows/fulfill_order/x → "../../../"
 *
 *  Strips a leading `src/` segment before counting, since some call
 *  sites pass paths rooted at the project root rather than `src/`. */
function computeSrcImportPrefix(emitPath: string): string {
  let path = emitPath;
  if (path.startsWith("src/")) path = path.slice(4);
  // Count directory hops from `src/` (root) to the file's parent.
  // `pages/x.tsx` has one segment of directories (`pages/`) → 1 hop.
  // `pages/orders/list.tsx` has two (`pages/orders/`) → 2 hops.
  const dirCount = path.split("/").length - 1;
  return "../".repeat(Math.max(dirCount, 1));
}

/** Derived map: aggregate name → owning bounded context.
 *  Required by `CreateForm(of: <Agg>)` and `IdLink(of: <Agg>)` so the
 *  walker can resolve enum / value-object types declared alongside
 *  the aggregate.  Built from `ctx.contextsByName` once per emit
 *  so the walker doesn't repeatedly scan all contexts. */
/** The served aggregate / workflow names `classifyPage` matches a
 *  page's role-scoped name against (slice 3c — replaces stamped `origin`). */
function pageNameCtx(ctx: PageEmitContext): PageNameCtx {
  const workflowNames: string[] = [];
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) workflowNames.push(wf.name);
  }
  return { aggregateNames: [...ctx.aggregatesByName.keys()], workflowNames };
}

function buildBcByAggregate(ctx: PageEmitContext): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const agg of bc.aggregates) out.set(agg.name, bc);
  }
  return out;
}

/** Derived map: workflow name → workflow IR.  Powers
 *  `WorkflowForm(runs: <wf>)` field dispatch in the walker. */
function buildWorkflowsByName(
  ctx: PageEmitContext,
): Map<string, import("../../ir/types/loom-ir.js").WorkflowIR> {
  const out = new Map<string, import("../../ir/types/loom-ir.js").WorkflowIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, wf);
  }
  return out;
}

/** Derived map: workflow name → owning bounded context. */
function buildBcByWorkflow(ctx: PageEmitContext): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, bc);
  }
  return out;
}

/** Emit `src/pages/<route>.tsx` per page in `ui.pages`.  Returns just
 *  the page-file map; api modules / page objects / shell files stay
 *  in `index.ts`. */
/** Collect the AppShell `extraRoutes` for non-
 *  conventional explicit pages, partitioned by layout selector.
 *  Three channels:
 *    - `inShell`: `layout: default` or unset — mounted inside the
 *      AppShell layout-route alongside conventional scaffold routes.
 *    - `outOfShell`: `layout: none` — mounted as sibling routes
 *      OUTSIDE every layout wrapper, getting no chrome at all.
 *    - `namedLayouts`: Phase 8 — pages with `layout: <Name>` map
 *      `Name → ExtraPageRoute[]`.  The generator emits one
 *      `<Name>Layout` wrapper component and routes the bucket
 *      through it. */
export function deriveExtraRoutesFromUi(
  ui: UiIR,
  topLevelComponents: readonly ComponentIR[] = [],
  nameCtx: PageNameCtx = { aggregateNames: [], workflowNames: [] },
): {
  inShell: import("./templating/preparers/app-shell.js").ExtraPageRoute[];
  outOfShell: import("./templating/preparers/app-shell.js").ExtraPageRoute[];
  namedLayouts: Map<string, import("./templating/preparers/app-shell.js").ExtraPageRoute[]>;
} {
  const inShell: import("./templating/preparers/app-shell.js").ExtraPageRoute[] = [];
  const outOfShell: import("./templating/preparers/app-shell.js").ExtraPageRoute[] = [];
  const namedLayouts = new Map<
    string,
    import("./templating/preparers/app-shell.js").ExtraPageRoute[]
  >();
  // Same name→params map the page emitter builds, so
  // route derivation recognises pages whose body is a user-component
  // invocation.  Top-level components seed the map first; ui-scope
  // entries override on collision.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);
  for (const page of ui.pages) {
    if (!page.route) continue;
    if (classifyPage(page, nameCtx).kind !== "custom") continue;
    if (isWalkableLayoutBody(page.body, userComponents)) {
      const route: import("./templating/preparers/app-shell.js").ExtraPageRoute = {
        componentName: page.name,
        importFrom: `./pages/${snake(page.name)}`,
        route: page.route,
      };
      if (page.layout?.kind === "preset" && page.layout.name === "none") {
        outOfShell.push(route);
      } else if (page.layout?.kind === "named") {
        const bucket = namedLayouts.get(page.layout.ref) ?? [];
        bucket.push(route);
        namedLayouts.set(page.layout.ref, bucket);
      } else {
        inShell.push(route);
      }
    }
  }
  return { inShell, outOfShell, namedLayouts };
}

export function emitPagesForUi(ui: UiIR, ctx: PageEmitContext): Map<string, string> {
  const out = new Map<string, string>();
  const pageCtx = pageNameCtx(ctx);

  // Build the per-ui name→params map the walker uses to resolve
  // cross-component invocations.  Top-level components seed the map
  // first; ui-scope entries override on collision so a ui can shadow
  // a workspace-wide name when needed.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ctx.topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);
  // Page name → declared route, so an `Action`'s `then: navigate(<Page>)`
  // targets the page's real path (only routable pages are included).
  const pageRoutes = new Map<string, string>();
  for (const page of ui.pages) {
    if (page.route) pageRoutes.set(page.name, page.route);
  }
  // Extern frontend functions (extern-function-hook-escape-hatch.md §3):
  // emit the typed signature + conformance shim per declaration; body
  // calls register through `externFunctionNames` and the page /
  // component shells import each used shim.
  const externFunctionNames = new Set<string>();
  for (const fn of ui.functions ?? []) {
    externFunctionNames.add(fn.name);
    out.set(`src/lib/extern/${fn.name}.signature.ts`, buildExternFunctionSignature(fn));
    out.set(`src/lib/${fn.name}.ts`, buildExternFunctionShim(fn));
  }
  // Merge top-level + ui-scope components, ui-scope last so it wins
  // by overwriting the earlier entry under the same name.  Both
  // flavours emit identical `src/components/<Name>.tsx` files.
  const emittedComponents = new Map<string, ComponentIR>();
  for (const c of ctx.topLevelComponents) emittedComponents.set(c.name, c);
  for (const c of ui.components) emittedComponents.set(c.name, c);
  for (const c of emittedComponents.values()) {
    const componentConstruct = `${ui.name}.${c.name}`;
    // Extern component: Loom owns a re-export shim at
    // `src/components/<Name>.tsx` (so call sites import `components/<Name>`
    // unchanged) plus a typed `<Name>.props.ts`; the user owns the
    // hand-written module at the `from` path.  No body is walked.
    if (c.extern) {
      const shimPath = `src/components/${c.name}.tsx`;
      const shimContent = renderExternComponentShim(c.name, c.externPath ?? "");
      out.set(shimPath, shimContent);
      ctx.sourcemap?.file(shimPath, shimContent, c.origin, componentConstruct);
      const propsPath = `src/components/${c.name}.props.ts`;
      const propsContent = renderExternComponentProps(c.name, c.params, ctx.aggregatesByName);
      out.set(propsPath, propsContent);
      ctx.sourcemap?.file(propsPath, propsContent, c.origin, componentConstruct);
      continue;
    }
    const componentPath = `src/components/${c.name}.tsx`;
    const componentContent = renderUserComponentFile(
      c.name,
      c.params,
      c.state,
      c.body!,
      ctx.pack,
      userComponents,
      ctx.aggregatesByName,
      buildBcByAggregate(ctx),
      pageRoutes,
      externFunctionNames,
      c.derived,
      // `auth: ui` enables currentUser-only operation `requires` gating on
      // `Action(...)` buttons in this component.
      ctx.authUi,
      // Named, typed component event handlers (Proposal A Stage 1).
      c.actions,
    );
    out.set(componentPath, componentContent);
    ctx.sourcemap?.file(componentPath, componentContent, c.origin, componentConstruct);
  }

  for (const page of ui.pages) {
    // Every page (scaffold OR explicit) routes through the walker.  Scaffold
    // pages carry their full body tree directly from the macro's
    // `_body-builders.ts` scaffolders, so by the time we're here the body is
    // always walker-eligible.  `classifyPage` distinguishes scaffold pages (the
    // per-aggregate page-object emitter above handles those) from `custom` ones
    // (which get the walker-side per-page page-object).
    if (isWalkableLayoutBody(page.body, userComponents)) {
      // `page.emitPath` overrides the default
      // `src/pages/<page-snake>.tsx` location.  Set by the
      // scaffold expander to land rewritten pages at their
      // conventional archetype path (`src/pages/<plural>/<arch>.tsx`)
      // so URL/file shape stays stable when scaffold expansion becomes
      // the default.
      const emitPath = page.emitPath ?? `src/pages/${snake(page.name)}.tsx`;
      // Relative-path prefix from the emitted TSX back
      // to `src/`.  Default-located walker pages (`src/pages/<x>.tsx`)
      // need 1 hop (`"../"`); scaffold-expanded pages at
      // `src/pages/<plural>/<arch>.tsx` need 2 hops (`"../../"`).
      // Computed from the depth difference between emitPath and
      // `src/`.
      const srcImportPrefix = computeSrcImportPrefix(emitPath);
      const pageContent = renderCustomLayoutPage(
        // Component function name stays the aggregate-qualified `OrderList`
        // form even though the scaffold names the page by role (`List`) — see
        // `pageEmitName`.  Matches the origin-bound router import.
        pageEmitName(page, pageCtx),
        page.body!,
        ctx.pack,
        page.params,
        page.state,
        page.title,
        userComponents,
        ui.apiParams,
        ctx.aggregatesByName,
        buildBcByAggregate(ctx),
        srcImportPrefix,
        buildWorkflowsByName(ctx),
        buildBcByWorkflow(ctx),
        pageRoutes,
        externFunctionNames,
        page.derived,
        // `page { requires <expr> }` UI gate — only meaningful when the
        // frontend has a verified session to evaluate it against.
        ctx.authUi ? page.requires : undefined,
        // `auth: ui` also enables currentUser-only operation `requires`
        // gating on `Action(...)` buttons inside the body.
        ctx.authUi,
        // Named, typed page event handlers — hoisted as `const <name> = …`
        // and bound by bare `onSubmit: <name>` references.
        page.actions,
      );
      out.set(emitPath, pageContent);
      ctx.sourcemap?.file(emitPath, pageContent, page.origin, pageConstructId(ui.name, page));
    }
    // Bodies the v0 dispatcher doesn't recognise are silently
    // skipped (e.g. user-defined components composed of stdlib
    // bits).  A future change expands the walker's component table.
  }
  return out;
}

/** True when the UI contains at least one `CodeBlock { ... }`
 *  primitive call anywhere — in a page body OR a user-component
 *  body (ui-scope or workspace-wide top-level).  Drives conditional
 *  injection of the highlight.js CDN payload into the shell's
 *  `index.html` (parallels the `usesMoney` contract for
 *  `decimal.js` in `package.json`). */
export function uiUsesCodeBlock(
  ui: UiIR,
  topLevelComponents: readonly ComponentIR[] = [],
): boolean {
  for (const page of ui.pages) {
    if (page.body && exprUsesCodeBlock(page.body)) return true;
  }
  for (const component of ui.components) {
    if (component.body && exprUsesCodeBlock(component.body)) return true;
  }
  for (const component of topLevelComponents) {
    if (component.body && exprUsesCodeBlock(component.body)) return true;
  }
  return false;
}

/** Recursive walk over an `ExprIR` looking for a `CodeBlock` call.
 *  Stops at the first hit — no flag accumulation needed.  Covers
 *  every compound `ExprIR` shape from `loom-ir.ts`; leaf nodes
 *  (`literal` / `ref` / `this` / `id`) fall through to `false`. */
function exprUsesCodeBlock(expr: import("../../ir/types/loom-ir.js").ExprIR): boolean {
  switch (expr.kind) {
    case "call":
      if (expr.name === "CodeBlock") return true;
      return expr.args.some(exprUsesCodeBlock);
    case "method-call":
      if (exprUsesCodeBlock(expr.receiver)) return true;
      return expr.args.some(exprUsesCodeBlock);
    case "member":
      return exprUsesCodeBlock(expr.receiver);
    case "binary":
      return exprUsesCodeBlock(expr.left) || exprUsesCodeBlock(expr.right);
    case "unary":
      return exprUsesCodeBlock(expr.operand);
    case "ternary":
      return (
        exprUsesCodeBlock(expr.cond) ||
        exprUsesCodeBlock(expr.then) ||
        exprUsesCodeBlock(expr.otherwise)
      );
    case "convert":
      return exprUsesCodeBlock(expr.value);
    case "object":
    case "new":
      return expr.fields.some((f) => exprUsesCodeBlock(f.value));
    case "lambda":
      if (expr.body && exprUsesCodeBlock(expr.body)) return true;
      // Block-bodied lambdas wrap StmtIR; CodeBlock can only appear
      // inside an `expression` statement at body position — other
      // statement kinds (assign, let, emit, call) don't host the
      // primitive itself, but their sub-expressions might.
      for (const s of expr.block ?? []) {
        if (stmtUsesCodeBlock(s)) return true;
      }
      return false;
    case "paren":
      return exprUsesCodeBlock(expr.inner);
    case "match":
      for (const arm of expr.arms) {
        if (exprUsesCodeBlock(arm.cond)) return true;
        if (exprUsesCodeBlock(arm.value)) return true;
      }
      if (expr.otherwise && exprUsesCodeBlock(expr.otherwise)) return true;
      return false;
    default:
      return false;
  }
}

function stmtUsesCodeBlock(stmt: import("../../ir/types/loom-ir.js").StmtIR): boolean {
  switch (stmt.kind) {
    case "let":
    case "expression":
      return exprUsesCodeBlock(stmt.expr);
    case "assign":
    case "add":
    case "remove":
      return exprUsesCodeBlock(stmt.value);
    case "call":
      return stmt.args.some(exprUsesCodeBlock);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Playwright page-object emission walked from `ui.pages`.
//
// Each scaffold-synthesised page contributes to its archetype's
// page-object file:
//
//   aggregate-list / aggregate-new / aggregate-detail
//     → one shared `e2e/pages/<camel-agg>.ts` per aggregate
//       (covers all three classes ListPage / NewPage / DetailPage)
//   workflow-form
//     → `e2e/pages/workflows/<snake-name>.ts` per workflow
//
// Iteration is driven by page IR; per-aggregate / per-workflow
// builders (`buildPageObjectModule` / `buildWorkflowPageObject`)
// produce the actual file content.
// ---------------------------------------------------------------------------

export function emitPageObjectsForUi(
  ui: UiIR,
  ctx: PageEmitContext,
  /** Emit page objects for custom (walker-emitted) pages by collecting
   *  their testids through the shared TSX walker.  Default `true` for the
   *  JSX/markup frontends (React / Vue / Svelte) whose packs ship the
   *  shared `field-input-*` / `form-of` form templates.  Angular sets this
   *  `false`: its forms render inline via `angularTarget` + `form-fields.ts`
   *  (no pack form templates), so driving the React TSX walker against the
   *  angularMaterial pack would throw on the first `CreateForm`.  The
   *  scaffold-archetype page objects above stay framework-neutral and emit
   *  for every frontend. */
  walkerPageObjects = true,
  /** How choice fields (`enum` / `X id`) are driven in the emitted page-object
   *  fill blocks.  Combobox (default) for the portal-select frontends (React
   *  Mantine et al.); `"native"` for frontends rendering a real `<select>`
   *  (Svelte, Feliz) — Playwright drives those with `selectOption`, and native
   *  mode needs no per-option `-option-<id>` testids. */
  selectStyle: SelectStyle = "combobox",
): Map<string, string> {
  const out = new Map<string, string>();
  const pageCtx = pageNameCtx(ctx);
  const seenAggregates = new Set<string>();
  const seenWorkflows = new Set<string>();

  for (const page of ui.pages) {
    // Only scaffold pages dispatch to the per-aggregate / per-workflow
    // page-object builders.  Custom (user-written) pages get the
    // walker-side per-page page-object emitted separately.
    const origin = classifyPage(page, pageCtx);
    if (origin.kind === "custom") continue;
    switch (origin.kind) {
      case "aggregate-list":
      case "aggregate-new":
      case "aggregate-detail": {
        // One file per aggregate, regardless of how many of its
        // archetypes appear — `buildPageObjectModule` covers
        // ListPage / NewPage / DetailPage classes in one go.
        if (seenAggregates.has(origin.aggregateName)) break;
        seenAggregates.add(origin.aggregateName);
        const agg = ctx.aggregatesByName.get(origin.aggregateName);
        let ctxIR = ctx.contextsByName.get(origin.contextName);
        if (!ctxIR && agg) {
          // Fallback: AST expander leaves `contextName: ""`.
          for (const c of ctx.contextsByName.values()) {
            if (c.aggregates.some((a) => a.name === agg.name)) {
              ctxIR = c;
              break;
            }
          }
        }
        if (!agg || !ctxIR) break;
        out.set(
          `e2e/pages/${lowerFirst(agg.name)}.ts`,
          buildPageObjectModule(agg, ctxIR, undefined, selectStyle),
        );
        break;
      }
      case "workflow-form": {
        if (seenWorkflows.has(origin.workflowName)) break;
        seenWorkflows.add(origin.workflowName);
        let ctxIR = ctx.contextsByName.get(origin.contextName);
        let wf = ctxIR?.workflows.find((w) => w.name === origin.workflowName);
        if (!wf) {
          for (const c of ctx.contextsByName.values()) {
            const found = c.workflows.find((w) => w.name === origin.workflowName);
            if (found) {
              ctxIR = c;
              wf = found;
              break;
            }
          }
        }
        if (!ctxIR || !wf) break;
        out.set(
          `e2e/pages/workflows/${snake(wf.name)}.ts`,
          buildWorkflowPageObject(wf, ctxIR, undefined, selectStyle),
        );
        break;
      }
      // Index pages and Home don't produce page objects (no
      // testable form / table; the index pages are tested via
      // their child links, the home page via its summary cards).
      case "workflows-index":
      case "home":
        break;
    }
  }
  // Walker-emitted pages (those whose bodies are
  // recognised by `isWalkableLayoutBody` but NOT by the scaffold
  // dispatcher) get a parallel page-object emission: one class
  // per page, exposing every static `testid:` literal the walker
  // captured + form-synthesised testids.
  //
  // Path-collision contract: scaffold-archetype pages own
  // `e2e/pages/<aggregate-camel>.ts`; walker pages emit at
  // `e2e/pages/<page-snake>.ts`.  These namespaces don't collide
  // by construction (camel vs snake, aggregate vs page name), but
  // we still guard against an explicit page named identically to
  // a scaffold-aggregate fragment by skipping any walker output
  // whose path is already in `out`.
  if (!walkerPageObjects) return out;
  const userComponents = buildUserComponentsMap(ui, ctx.topLevelComponents);
  const bcByAggregate = buildBcByAggregate(ctx);
  for (const page of ui.pages) {
    // Skip scaffold pages; per-aggregate page-objects above covered them
    // (with their richer fill/submit/expectRow surface).
    if (classifyPage(page, pageCtx).kind !== "custom") continue;
    if (!isWalkableLayoutBody(page.body, userComponents)) continue;
    if (!page.body) continue;
    const paramNames = new Set(page.params.map((p) => p.name));
    const stateNames = new Set(page.state.map((s) => s.name));
    const { collectedTestids } = walkBodyToTsx(
      page.body,
      ctx.pack,
      paramNames,
      stateNames,
      userComponents,
      ui.apiParams,
      ctx.aggregatesByName,
      bcByAggregate,
    );
    const path = `e2e/pages/${snake(page.name)}.ts`;
    if (out.has(path)) continue;
    out.set(
      path,
      buildWalkerPageObject({
        pageName: page.name,
        params: page.params,
        route: page.route ?? "",
        testids: collectedTestids,
      }),
    );
  }
  return out;
}

/** UI's component-name → ParamIR map, mirroring how
 *  `emitPagesForUi` builds it.  Top-level components seed the map;
 *  ui-scope entries override on collision so a ui can shadow a
 *  workspace-wide name.  `isWalkableLayoutBody` calls this to
 *  decide whether a body composed of user components is
 *  walker-eligible. */
function buildUserComponentsMap(
  ui: UiIR,
  topLevelComponents: readonly ComponentIR[] = [],
): Map<string, readonly ParamIR[]> {
  const map = new Map<string, readonly ParamIR[]>();
  for (const c of topLevelComponents) map.set(c.name, c.params);
  for (const c of ui.components) map.set(c.name, c.params);
  return map;
}
