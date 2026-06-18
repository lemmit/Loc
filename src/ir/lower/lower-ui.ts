// -------------------------------------------------------------------------
// UI lowering — ui blocks, pages (+ origin inference), components, state
// fields, menu blocks, and layouts.  Consumed by lowerContext / lowerProject
// in ./lower.ts.
// -------------------------------------------------------------------------

import type {
  Component,
  Layout,
  LayoutNamedSlot,
  MenuBlock,
  Page,
  StateField,
  Ui,
} from "../../language/generated/ast.js";
import { snake } from "../../util/naming.js";
import type {
  ComponentIR,
  ExprIR,
  LayoutIR,
  MenuBlockIR,
  MenuLinkIR,
  MenuMetaIR,
  PageIR,
  PageLayoutIR,
  PageMetadataIR,
  PageOriginIR,
  StateFieldIR,
  UiApiParamIR,
  UiChannelParamIR,
  UiFunctionIR,
  UiIR,
  UiNotificationIR,
} from "../types/loom-ir.js";
import { lowerExpr } from "./lower-expr.js";
import { canonicalFramework } from "./lower-platform.js";
import { type Env, lowerType, withLocal } from "./lower-types.js";

// ---------------------------------------------------------------------------
// Page metamodel lowering.
//
// Each `ui { ... }` SystemMember lowers to a `UiIR` carrying its
// pages, components, scaffold directives, and an optional menu block
// in source order.  This layer is intentionally shallow:
//   - Page bodies / component bodies / state init expressions lower
//     through the existing expression engine (`lowerExpr`); type
//     resolution falls out from the same `Env`.
//   - Scaffold directives stay as literal `ScaffoldIR` carrying their
//     selector + targets.  The expander walks the system's
//     domain IR to synthesise concrete pages from each directive.
//   - Validator obligations catch the rest: ui-name
//     uniqueness, deployable-references-existing-ui, scaffold target
//     resolution, etc.
// ---------------------------------------------------------------------------

export function lowerLayout(layout: Layout): LayoutIR {
  // Each non-main slot is lowered with an empty env — layouts have no
  // params or state, and the validator rejects refs to anything other
  // than walker-stdlib primitives + user components + helper imports.
  const env: Env = { locals: new Map(), user: undefined };
  let header: ExprIR | undefined;
  let sidebar: ExprIR | undefined;
  let footer: ExprIR | undefined;
  for (const slot of layout.slots) {
    if (slot.$type === "LayoutMainSlot") {
      // The `main` slot is the page-body sentinel.  No body to lower —
      // the React generator emits `<Outlet />` at this position.
      continue;
    }
    const named = slot as LayoutNamedSlot;
    const body = lowerExpr(named.body, env);
    switch (named.name) {
      case "header":
        header = body;
        break;
      case "sidebar":
        sidebar = body;
        break;
      case "footer":
        footer = body;
        break;
    }
  }
  return { name: layout.name, header, sidebar, footer };
}

export function lowerUi(ui: Ui): UiIR {
  const pages: PageIR[] = [];
  const components: ComponentIR[] = [];
  const apiParams: UiApiParamIR[] = [];
  const channelParams: UiChannelParamIR[] = [];
  const notifications: UiNotificationIR[] = [];
  const functions: UiFunctionIR[] = [];
  let menu: MenuBlockIR | undefined;
  // Pages inside `area { … }` blocks group by containment: the file lands at
  // `src/pages/<area-path>/<page>.tsx`, the path joining down the nesting.
  const collectArea = (
    area: import("../../language/generated/ast.js").Area,
    parent: string[],
  ): void => {
    const path = [...parent, snake(area.name)];
    for (const member of area.members) {
      if (member.$type === "Page") {
        const p = lowerPage(member);
        p.area = path;
        p.emitPath = `src/pages/${path.join("/")}/${snake(p.name)}.tsx`;
        pages.push(p);
      } else if (member.$type === "Area") {
        collectArea(member, path);
      }
    }
  };
  for (const m of ui.members) {
    if (m.$type === "Page") pages.push(lowerPage(m));
    else if (m.$type === "Area") collectArea(m, []);
    else if (m.$type === "Component") components.push(lowerComponent(m));
    else if (m.$type === "UiApiParam") {
      apiParams.push({
        name: m.name,
        apiName: m.apiRef?.$refText ?? "",
      });
    } else if (m.$type === "UiChannelParam") {
      channelParams.push({
        name: m.name,
        contextName: m.context?.$refText ?? "",
        channelName: m.channel?.$refText ?? "",
      });
    } else if (m.$type === "UiNotification") {
      // The bind types as the carried event (entity-kind, like a
      // workflow's `create(e: Event)` param); each body statement is a
      // `toast(<expr>)` call (validator `loom.ui-handler-unsupported`
      // rejects everything else), so only the message expr lowers.
      const eventName = m.event?.$refText ?? "";
      const env: Env = { locals: new Map(), user: undefined };
      const inner = withLocal(env, m.bind, "param", { kind: "entity", name: eventName });
      const toasts: ExprIR[] = [];
      for (const stmt of m.body) {
        const arg = stmt.target?.args?.[0];
        if (arg) toasts.push(lowerExpr(arg, inner));
      }
      notifications.push({
        paramName: m.param?.$refText ?? "",
        eventType: eventName,
        bind: m.bind,
        toasts,
      });
    } else if (m.$type === "UiFunction") {
      const env: Env = { locals: new Map(), user: undefined };
      functions.push({
        name: m.name,
        params: (m.params ?? []).map((p) => ({ name: p.name, type: lowerType(p.type, env) })),
        returnType: lowerType(m.returnType, env),
        externPath: m.externPath,
      });
    } else if (m.$type === "MenuBlock") {
      // First menu block wins.  Validator flags a duplicate
      // `menu { ... }` block at ui scope as an error.
      if (!menu) menu = lowerMenuBlock(m);
    }
  }
  return {
    name: ui.name,
    framework: canonicalFramework(ui.framework),
    pages,
    components,
    menu,
    apiParams,
    ...(channelParams.length > 0 ? { channelParams } : {}),
    ...(notifications.length > 0 ? { notifications } : {}),
    ...(functions.length > 0 ? { functions } : {}),
  };
}

function lowerPage(p: Page): PageIR {
  const params = (p.params ?? []).map((param) => ({
    name: param.name,
    type: lowerType(param.type),
  }));
  // Walk the unordered prop list to extract route / title / requires /
  // body / state / per-page menu meta.  Multiple state blocks merge
  // (matches `permissions` block multiplicity).
  let route: string | undefined;
  let title: ExprIR | undefined;
  let requires: ExprIR | undefined;
  let body: ExprIR | undefined;
  let menuMeta: MenuMetaIR | undefined;
  let layout: PageLayoutIR | undefined;
  let description: string | undefined;
  let ogImage: string | undefined;
  let canonical: string | undefined;
  const state: StateFieldIR[] = [];
  // Page-scoped env: route params + state fields bind as locals so
  // `inferExprType` resolves their refs to their declared types
  // (otherwise NameRef refs would fall through to the string-typed
  // default — wrong for `count + 1` arithmetic in a page primitive).
  // The page emitter does its own walker-side scope resolution at
  // emit time; this addition makes the IR's type info accurate enough
  // that contextual lowering tricks (literal promotion, implicit
  // string-concat convert injection) don't mis-fire on page bodies.
  let env: Env = { locals: new Map(), user: undefined };
  for (const param of p.params ?? []) {
    env = withLocal(env, param.name, "param", lowerType(param.type));
  }
  for (const prop of p.props) {
    if (prop.$type === "StateBlock") {
      for (const f of prop.fields) {
        env = withLocal(env, f.name, "let", lowerType(f.type));
      }
    }
  }
  for (const prop of p.props) {
    if (prop.$type === "RouteProp") route = prop.value;
    else if (prop.$type === "TitleProp") title = lowerExpr(prop.value, env);
    else if (prop.$type === "RequiresProp") requires = lowerExpr(prop.expr, env);
    else if (prop.$type === "BodyProp") body = lowerExpr(prop.expr, env);
    else if (prop.$type === "StateBlock") {
      for (const f of prop.fields) state.push(lowerStateField(f, env));
    } else if (prop.$type === "PageMenuMeta") {
      // Last block wins — validator flags repeated menu
      // metadata blocks on a single page.
      menuMeta = {
        entries: prop.entries.map((e) => ({
          name: e.name,
          value: lowerExpr(e.value, env),
        })),
      };
    } else if (prop.$type === "LayoutProp") {
      // Phase 8: bare `ID` value resolves to either the two reserved
      // presets (`default` / `none`) or the name of a named `layout`
      // SystemMember declared in the same system.  Validator gates
      // the resolution — by lowering time, anything that's not a
      // preset is treated as a named ref (the React generator
      // partitions pages by ref name).
      layout =
        prop.value === "default" || prop.value === "none"
          ? { kind: "preset", name: prop.value }
          : { kind: "named", ref: prop.value };
    } else if (prop.$type === "DescriptionProp") {
      description = prop.value;
    } else if (prop.$type === "OgImageProp") {
      ogImage = prop.value;
    } else if (prop.$type === "CanonicalProp") {
      canonical = prop.value;
    }
  }
  // Static metadata projected into the `index.html` shell.  Only
  // emitted when at least one metadata prop is present so consumers
  // can branch on `page.metadata` truthiness rather than checking
  // each field individually.
  let metadata: PageMetadataIR | undefined;
  if (description !== undefined || ogImage !== undefined || canonical !== undefined) {
    metadata = { description, ogImage, canonical };
  }
  // Pass-1 AST-to-AST scaffold expansion populates
  // synthesised pages with body expressions like
  // `List(of: Order)` / `CreateForm(of: T)` / etc.  We infer the
  // page's `archetype` discriminator and `source` from the
  // body shape so the React emitter dispatches identically
  // whether the page came from source or from the AST expander.
  const inferred = inferPageOrigin(body);
  return {
    name: p.name,
    params,
    route,
    title,
    requires,
    state,
    body,
    menuMeta,
    source: inferred.kind === "custom" ? "explicit" : "scaffold",
    origin: inferred,
    layout,
    metadata,
  };
}

/** Infer a page's `origin` from its body shape.  The scaffold macro
 *  emits canonical body primitives (`scaffoldList(of:)`,
 *  `scaffoldNewForm(of:)`, `scaffoldWorkflowForm(runs:)`,
 *  `scaffoldViewList(of:)`, `Stack(scaffoldDetails(of:), …)`,
 *  `Home()` / `WorkflowsIndex()` / `ViewsIndex()`) — each call name
 *  maps one-to-one to an origin kind.  Anything else is a
 *  user-written page → `{ kind: "custom" }`. */
function inferPageOrigin(body: ExprIR | undefined): PageOriginIR {
  if (!body || body.kind !== "call") return { kind: "custom" };
  const callName = body.name;
  const argNames = body.argNames ?? [];
  const refArg = (i: number): string | undefined => {
    const arg = body.args[i];
    return arg && arg.kind === "ref" ? arg.name : undefined;
  };
  // Singleton index pages — synthesised by the scaffold macro with
  // sentinel-call bodies whose name matches the page's role.
  if (callName === "Home") return { kind: "home" };
  if (callName === "WorkflowsIndex") return { kind: "workflows-index" };
  if (callName === "ViewsIndex") return { kind: "views-index" };
  // Canonical scaffold body primitives — one call name per origin
  // kind.  Each names its target explicitly via `of:` / `runs:`.
  if (callName === "scaffoldList" && argNames[0] === "of") {
    const aggName = refArg(0);
    if (aggName) return { kind: "aggregate-list", aggregateName: aggName, contextName: "" };
  }
  if (callName === "scaffoldNewForm" && argNames[0] === "of") {
    const aggName = refArg(0);
    if (aggName) return { kind: "aggregate-new", aggregateName: aggName, contextName: "" };
  }
  if (callName === "scaffoldWorkflowForm" && argNames[0] === "runs") {
    const wfName = refArg(0);
    if (wfName) return { kind: "workflow-form", workflowName: wfName, contextName: "" };
  }
  if (callName === "scaffoldViewList" && argNames[0] === "of") {
    const viewName = refArg(0);
    if (viewName) return { kind: "view-list", viewName, contextName: "" };
  }
  // Workflow-instance read pages (workflow-instance-visibility.md) — list /
  // detail over a saga's persisted correlation-state rows.
  if (callName === "scaffoldInstanceList" && argNames[0] === "of") {
    const wfName = refArg(0);
    if (wfName) return { kind: "workflow-instances-list", workflowName: wfName, contextName: "" };
  }
  if (callName === "scaffoldInstanceDetails" && argNames[0] === "of") {
    const wfName = refArg(0);
    if (wfName) return { kind: "workflow-instance-detail", workflowName: wfName, contextName: "" };
  }
  // Detail pages emit `Stack(scaffoldDetails(of:),
  // scaffoldOperations(of:), testid:)` — recognised by scanning for
  // a `scaffoldDetails` child at the top of the Stack.
  if (callName === "Stack") {
    for (const arg of body.args) {
      if (arg.kind !== "call") continue;
      if (arg.name !== "scaffoldDetails") continue;
      const ofIdx = (arg.argNames ?? []).indexOf("of");
      const ofArg = ofIdx >= 0 ? arg.args[ofIdx] : undefined;
      if (!ofArg || ofArg.kind !== "ref") continue;
      return { kind: "aggregate-detail", aggregateName: ofArg.name, contextName: "" };
    }
  }
  return { kind: "custom" };
}

export function lowerComponent(c: Component): ComponentIR {
  const params = c.params.map((param) => ({
    name: param.name,
    type: lowerType(param.type),
  }));
  // An `extern` component declares only its typed param contract —
  // no body, no state to walk.  Carry the flag + src-relative module
  // path; the React generator emits a `<Name>.props.ts` interface and
  // imports the user's module at call sites.
  if (c.extern) {
    return { name: c.name, params, state: [], extern: true, externPath: c.externPath };
  }
  // Component-scoped env: params + state bind so `inferExprType`
  // resolves refs to their declared types (same reason as
  // `lowerPage`; see comment there).
  let env: Env = { locals: new Map(), user: undefined };
  for (const param of c.params) {
    env = withLocal(env, param.name, "param", lowerType(param.type));
  }
  const state: StateFieldIR[] = [];
  for (const decl of c.decls ?? []) {
    if (decl.$type === "StateBlock") {
      for (const f of decl.fields) {
        env = withLocal(env, f.name, "let", lowerType(f.type));
        state.push(lowerStateField(f, env));
      }
    }
  }
  // Non-extern components always carry a body (validator-enforced);
  // guard defensively so lowering an invalid model can't crash.
  const body = c.body ? lowerExpr(c.body, env) : undefined;
  return { name: c.name, params, state, body };
}

function lowerStateField(f: StateField, env: Env): StateFieldIR {
  return {
    name: f.name,
    type: lowerType(f.type),
    init: f.init ? lowerExpr(f.init, env) : undefined,
  };
}

function lowerMenuBlock(m: MenuBlock): MenuBlockIR {
  const env: Env = { locals: new Map(), user: undefined };
  return {
    sections: m.sections.map((sec) => ({
      label: sec.label,
      links: sec.links.map((l): MenuLinkIR => {
        // Page links use a real Langium cross-reference.
        // Scaffold-synthesised pages are first-class AST nodes by
        // link time, so `[Page:LooseName]` resolves through the
        // standard linker.  We carry the resolved page's name into
        // the IR for the menu emitter (which iterates `ui.pages` by
        // name).  Unresolved refs surface as Langium linker errors,
        // not silent shim misses.
        const pageRef = l.page?.ref;
        if (pageRef) {
          return {
            kind: "page",
            pageName: pageRef.name,
            props: (l.props ?? []).map((p) => ({
              name: p.name,
              value: lowerExpr(p.value, env),
            })),
          };
        }
        if (l.page?.$refText) {
          // Reference exists but didn't resolve — preserve the text
          // for diagnostics.  The validator / Langium linker has
          // already reported the unresolved reference.
          return {
            kind: "page",
            pageName: l.page.$refText,
            props: (l.props ?? []).map((p) => ({
              name: p.name,
              value: lowerExpr(p.value, env),
            })),
          };
        }
        // External link: `link "Docs" -> "https://..."`.
        return {
          kind: "external",
          label: l.externalLabel ?? "",
          url: l.externalUrl ?? "",
        };
      }),
    })),
  };
}
