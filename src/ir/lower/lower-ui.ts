// -------------------------------------------------------------------------
// UI lowering — ui blocks, pages (+ origin inference), components, state
// fields, menu blocks, and layouts.  Consumed by lowerContext / lowerProject
// in ./lower.ts.
// -------------------------------------------------------------------------

import type {
  Component,
  DerivedProp,
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
  UiApiParamIR,
  UiChannelParamIR,
  UiFunctionIR,
  UiIR,
  UiNotificationIR,
  UserIR,
} from "../types/loom-ir.js";
import { lowerExpr } from "./lower-expr.js";
import { lowerDerived } from "./lower-members.js";
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

export function lowerUi(ui: Ui, user?: UserIR): UiIR {
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
        const p = lowerPage(member, user);
        p.area = path;
        p.emitPath = `src/pages/${path.join("/")}/${snake(p.name)}.tsx`;
        pages.push(p);
      } else if (member.$type === "Area") {
        collectArea(member, path);
      }
    }
  };
  for (const m of ui.members) {
    if (m.$type === "Page") pages.push(lowerPage(m, user));
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

function lowerPage(p: Page, user?: UserIR): PageIR {
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
  let env: Env = { locals: new Map(), user };
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
    body,
    menuMeta,
    // `source` flags the three scaffold singleton sentinels (`Home` /
    // `WorkflowsIndex` / `ViewsIndex`), whose page NAMES collide with
    // hand-written pages — only their sentinel BODY (visible here, before the
    // ⑤c expander rewrites it) distinguishes them.  `classifyPage` gates its
    // singleton branch on this so a user page literally named `Home` stays
    // `custom`.  Every other page kind is name/area-derivable, so they keep the
    // default `"explicit"`.
    source: isSingletonSentinel(body) ? "scaffold" : "explicit",
    layout,
    metadata,
  };
}

/** True when a page body is one of the three scaffold singleton sentinels
 *  (`Home()` / `WorkflowsIndex()` / `ViewsIndex()`) the macro emits — the only
 *  origin-free signal that tells the scaffold singleton apart from a
 *  hand-written page that happens to share its reserved name. */
function isSingletonSentinel(body: ExprIR | undefined): boolean {
  return (
    body?.kind === "call" &&
    (body.name === "Home" || body.name === "WorkflowsIndex" || body.name === "ViewsIndex")
  );
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
    return { name: c.name, params, state: [], derived: [], extern: true, externPath: c.externPath };
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
  // Non-extern components always carry a body (validator-enforced);
  // guard defensively so lowering an invalid model can't crash.
  const body = c.body ? lowerExpr(c.body, env) : undefined;
  return { name: c.name, params, state, derived, body };
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
