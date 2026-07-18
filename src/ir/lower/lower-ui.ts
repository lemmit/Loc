// -------------------------------------------------------------------------
// UI lowering — ui blocks, pages, components, state
// fields, menu blocks, and layouts.  Consumed by lowerContext / lowerProject
// in ./lower.ts.
// -------------------------------------------------------------------------

import type {
  ActionDecl,
  Component,
  Layout,
  LayoutNamedSlot,
  MenuBlock,
  Page,
  StateBlock,
  StateField,
  Store,
  Ui,
} from "../../language/generated/ast.js";
import { snake } from "../../util/naming.js";
import type {
  ActionIR,
  ComponentIR,
  DerivedIR,
  ExprIR,
  LayoutIR,
  MenuBlockIR,
  MenuLinkIR,
  MenuMetaIR,
  PageIR,
  PageLayoutIR,
  PageMetadataIR,
  StateFieldIR,
  StmtIR,
  StoreIR,
  TypeIR,
  UiApiParamIR,
  UiChannelParamIR,
  UiFunctionIR,
  UiIR,
  UiNotificationIR,
  UserIR,
} from "../types/loom-ir.js";
import { lowerExpr } from "./lower-expr.js";
import { lowerDerived } from "./lower-members.js";
import { lowerStatement } from "./lower-stmt.js";
import { type Env, lowerType, withLocal } from "./lower-types.js";
import { originFor } from "./origin.js";

/** Build the `env.actions` index (action name → single declared payload
 *  param type) consumed by `resolveNameRef` so a bare handler-arg reference
 *  (`onSubmit: next`) lowers to a fully-typed `action-ref`.  The action's
 *  body is lowered separately by `lowerAction`; this only carries the
 *  call-site-facing param type (named-actions-and-stores.md, Proposal A). */
function indexActions(decls: ReadonlyArray<ActionDecl>): Map<string, { paramType?: TypeIR }> {
  const index = new Map<string, { paramType?: TypeIR }>();
  for (const a of decls) {
    // v1: a single payload param (the call-site supplies it); arity > 1 is
    // gated by the IR validator (`loom.action-payload-mismatch`).  Carry the
    // first param's type as the call-site contract; nullary ⇒ undefined.
    const paramType = a.params[0] ? lowerType(a.params[0].type) : undefined;
    index.set(a.name, { paramType });
  }
  return index;
}

/** Lower a named `action name(p: T) { … }` member.  Params bind as locals in
 *  the action-body env; the body statements lower through the SAME
 *  `lowerStatement` path an anonymous handler block uses — no new statement
 *  semantics (named-actions-and-stores.md, Proposal A Stage 1). */
function lowerAction(a: ActionDecl, env: Env): ActionIR {
  const params = a.params.map((p) => ({ name: p.name, type: lowerType(p.type) }));
  let scopeEnv = env;
  for (const p of params) {
    scopeEnv = withLocal(scopeEnv, p.name, "param", p.type);
  }
  const body: StmtIR[] = [];
  for (const s of a.stmts) {
    const lowered = lowerStatement(s, scopeEnv);
    body.push(lowered.stmt);
    scopeEnv = lowered.envAfter;
  }
  return { name: a.name, params, body };
}

/** Build the ui-wide store index (store name → field types + action param
 *  types) threaded into every body env so dotted store refs resolve during
 *  lowering (named-actions-and-stores.md §3, Stage 5).  Built BEFORE any
 *  page/component/store body lowers, since all three may reference a store. */
function indexStores(
  stores: ReadonlyArray<Store>,
): Map<string, { fields: Map<string, TypeIR>; actions: Map<string, { paramType?: TypeIR }> }> {
  const index = new Map<
    string,
    { fields: Map<string, TypeIR>; actions: Map<string, { paramType?: TypeIR }> }
  >();
  for (const s of stores) {
    const fields = new Map<string, TypeIR>();
    const actions = new Map<string, { paramType?: TypeIR }>();
    for (const decl of s.decls) {
      if (decl.$type === "StateBlock") {
        for (const f of (decl as StateBlock).fields) fields.set(f.name, lowerType(f.type));
      } else {
        const a = decl as ActionDecl;
        actions.set(a.name, { paramType: a.params[0] ? lowerType(a.params[0].type) : undefined });
      }
    }
    index.set(s.name, { fields, actions });
  }
  return index;
}

/** Lower a `store Name { state {…} action …}` member.  Reuses `lowerStateField`
 *  for state and `lowerAction` for actions — no new statement lowering.  Store
 *  action bodies lower against an env whose `this`-owner is the store's own
 *  state (so `lines := …` resolves to a store-field write) and whose `stores`
 *  index is in scope (so a store action may call another store action). */
function lowerStore(s: Store, baseEnv: Env): StoreIR {
  // The store's own state binds as `let` locals so a bare `lines` inside an
  // action body resolves to its own field (a same-store write); the dotted
  // `Cart.lines` form from a foreign body resolves via the `stores` index.
  let env = baseEnv;
  const state: StateFieldIR[] = [];
  for (const decl of s.decls) {
    if (decl.$type === "StateBlock") {
      for (const f of (decl as StateBlock).fields) {
        env = withLocal(env, f.name, "let", lowerType(f.type));
        state.push(lowerStateField(f, env));
      }
    }
  }
  const actionDecls = s.decls.filter((d): d is ActionDecl => d.$type === "ActionDecl");
  env = { ...env, actions: indexActions(actionDecls) };
  const actions = actionDecls.map((a) => lowerAction(a, env));
  // Lifetime ladder (frontend-state-management.md §3.1): the optional
  // `persist: <id>` clause names where the state lives.  The AST validator
  // (`loom.store-lifetime-invalid`) rejects any value outside this set, so an
  // unrecognised value here defaults to in-memory rather than crashing.
  return { name: s.name, lifetime: lowerStoreLifetime(s.lifetime), state, actions };
}

/** Maps the grammar's `persist: <id>` identifier onto the `StoreIR.lifetime`
 *  enum.  Absent clause (or an out-of-set value the validator already flagged)
 *  → `"memory"`. */
function lowerStoreLifetime(raw: string | undefined): StoreIR["lifetime"] {
  switch (raw) {
    case "local":
      return "persistLocal";
    case "session":
      return "persistSession";
    case "url":
      return "url";
    default:
      return "memory";
  }
}

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

export function lowerUi(ui: Ui, user?: UserIR): UiIR {
  const pages: PageIR[] = [];
  const components: ComponentIR[] = [];
  const stores: StoreIR[] = [];
  const apiParams: UiApiParamIR[] = [];
  const channelParams: UiChannelParamIR[] = [];
  const notifications: UiNotificationIR[] = [];
  const functions: UiFunctionIR[] = [];
  let menu: MenuBlockIR | undefined;
  // Build the ui-wide store index up front so every page/component/store body
  // resolves a dotted `Cart.lines` / `Cart.clear()` ref during lowering (the
  // IR stays fully resolved).  Empty index ⇒ no stores declared.
  const storeDecls = ui.members.filter((m): m is Store => m.$type === "Store");
  const storeIndex = storeDecls.length > 0 ? indexStores(storeDecls) : undefined;
  // Pages inside `area { … }` blocks group by containment: the file lands at
  // `src/pages/<area-path>/<page>.tsx`, the path joining down the nesting.
  const collectArea = (
    area: import("../../language/generated/ast.js").Area,
    parent: string[],
  ): void => {
    const path = [...parent, snake(area.name)];
    for (const member of area.members) {
      if (member.$type === "Page") {
        const p = lowerPage(member, user, storeIndex);
        p.area = path;
        p.emitPath = `src/pages/${path.join("/")}/${snake(p.name)}.tsx`;
        pages.push(p);
      } else if (member.$type === "Area") {
        collectArea(member, path);
      }
    }
  };
  for (const m of ui.members) {
    if (m.$type === "Page") pages.push(lowerPage(m, user, storeIndex));
    else if (m.$type === "Area") collectArea(m, []);
    else if (m.$type === "Component") components.push(lowerComponent(m, storeIndex));
    else if (m.$type === "Store") {
      const env: Env = { locals: new Map(), user, stores: storeIndex };
      stores.push(lowerStore(m, env));
    } else if (m.$type === "UiApiParam") {
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
    framework: ui.framework,
    pages,
    components,
    stores,
    menu,
    apiParams,
    ...(channelParams.length > 0 ? { channelParams } : {}),
    ...(notifications.length > 0 ? { notifications } : {}),
    ...(functions.length > 0 ? { functions } : {}),
  };
}

function lowerPage(p: Page, user?: UserIR, stores?: Env["stores"]): PageIR {
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
  // `user` is threaded so a page `requires` gate (and any page-scope
  // `currentUser` ref) resolves to a `current-user` ref rather than `unknown`.
  let env: Env = { locals: new Map(), user, stores };
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
  // Index named actions before lowering bodies so a bare handler-arg
  // reference (`onSubmit: next`) in the page body resolves to a typed
  // `action-ref` (named-actions-and-stores.md, Proposal A Stage 1).
  const actionDecls = p.props.filter((prop): prop is ActionDecl => prop.$type === "ActionDecl");
  env = { ...env, actions: indexActions(actionDecls) };
  // Page-derived bindings — read-only computed values in the render scope.
  // Lowered sequentially (in source order) so a derived may reference
  // params, state, and EARLIER derived; each name binds into `env` after
  // lowering so the body (and later derived / title / requires) resolve
  // their refs to it.
  const derived: DerivedIR[] = [];
  for (const prop of p.props) {
    if (prop.$type === "DerivedProp") {
      const d = lowerDerived(prop, env);
      derived.push(d);
      env = withLocal(env, d.name, "let", d.type);
    }
  }
  // Action bodies lower through the standard statement path, in source
  // order, against the page env (params + state + derived in scope).
  const actions = actionDecls.map((a) => lowerAction(a, env));
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
  return {
    name: p.name,
    params,
    route,
    title,
    requires,
    state,
    derived,
    actions,
    body,
    menuMeta,
    layout,
    metadata,
    origin: originFor(p),
  };
}

export function lowerComponent(c: Component, stores?: Env["stores"]): ComponentIR {
  const params = c.params.map((param) => ({
    name: param.name,
    type: lowerType(param.type),
  }));
  // An `extern` component declares only its typed param contract —
  // no body, no state to walk.  Carry the flag + src-relative module
  // path; the React generator emits a `<Name>.props.ts` interface and
  // imports the user's module at call sites.
  if (c.extern) {
    return {
      name: c.name,
      params,
      state: [],
      derived: [],
      actions: [],
      extern: true,
      externPath: c.externPath,
      origin: originFor(c),
    };
  }
  // Component-scoped env: params + state bind so `inferExprType`
  // resolves refs to their declared types (same reason as
  // `lowerPage`; see comment there).
  let env: Env = { locals: new Map(), user: undefined, stores };
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
  // Index named actions before lowering bodies (same as `lowerPage`) so a
  // bare handler-arg reference in the component body resolves to a typed
  // `action-ref`.
  const actionDecls = (c.decls ?? []).filter(
    (decl): decl is ActionDecl => decl.$type === "ActionDecl",
  );
  env = { ...env, actions: indexActions(actionDecls) };
  // Component-derived bindings — same sequential, reactive-over-state
  // semantics as `lowerPage`.
  const derived: DerivedIR[] = [];
  for (const decl of c.decls ?? []) {
    if (decl.$type === "DerivedProp") {
      const d = lowerDerived(decl, env);
      derived.push(d);
      env = withLocal(env, d.name, "let", d.type);
    }
  }
  // Action bodies lower through the standard statement path (same as pages).
  const actions = actionDecls.map((a) => lowerAction(a, env));
  // Non-extern components always carry a body (validator-enforced);
  // guard defensively so lowering an invalid model can't crash.
  const body = c.body ? lowerExpr(c.body, env) : undefined;
  return { name: c.name, params, state, derived, actions, body, origin: originFor(c) };
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
          // Capture the resolved page's route as the menu emitter's match key —
          // role-named scaffold pages (`List`/`New`/`Detail`) share `name`
          // across aggregates, so `Orders.List` and `Items.List` are told apart
          // by route, not name.
          const routeProp = pageRef.props.find((pp) => pp.$type === "RouteProp");
          return {
            kind: "page",
            pageName: pageRef.name,
            route: routeProp?.$type === "RouteProp" ? routeProp.value : undefined,
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
