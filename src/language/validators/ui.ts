// UI / page / menu / theme / helper-import / api-body-ref checks.

import { AstUtils, type ValidationAcceptor } from "langium";
import type {
  ActionDecl,
  Api,
  Component,
  Layout,
  MenuBlock,
  Model,
  NameRef,
  Page,
  Store,
  System,
  ThemeBlock,
  Ui,
  UiApiParam,
  UiChannelParam,
  UiMember,
  UiNotification,
} from "../generated/ast.js";
import {
  isActionDecl,
  isAggregate,
  isComponent,
  isMemberSuffix,
  isNameRef,
  isPostfixChain,
} from "../generated/ast.js";
import { isWalkerPrimitive } from "../walker-stdlib.js";
import {
  findAggregateInModule,
  isValidApiOperation,
  listValidApiOperations,
  pagePropDisplayName,
} from "./_shared.js";

/** `component` declarations — enforce the `extern` ↔ `body`
 *  exclusivity that the grammar admits but cannot constrain:
 *
 *   - An `extern` component hands rendering to a hand-written file, so
 *     it must declare **no** `body:` (mirror of "extern op bodies are
 *     preconditions-only").
 *   - A non-extern component is a walked region tree, so it **must**
 *     declare a `body:`.
 *
 *  Covers both ui-scope and top-level components (one stream over the
 *  whole model). */
export function checkComponent(model: Model, accept: ValidationAcceptor): void {
  for (const c of AstUtils.streamAllContents(model)) {
    if (!isComponent(c)) continue;
    const comp = c as Component;
    if (comp.extern) {
      if (comp.body) {
        accept(
          "error",
          `Extern component '${comp.name}' must not declare a 'body:' — its rendering is owned by the hand-written module at '${comp.externPath ?? "?"}'. Remove the body, or drop 'extern from' to make it a normal component.`,
          { node: comp, property: "body", code: "loom.extern-component-has-body" },
        );
      }
    } else if (!comp.body) {
      accept(
        "error",
        `Component '${comp.name}' requires a 'body:' (or mark it 'extern from "<path>"' to hand rendering to a hand-written module).`,
        { node: comp, property: "name", code: "loom.component-missing-body" },
      );
    }
    // Duplicate named action on one component — lowering's `indexActions` Map
    // would silently overwrite the earlier body (named-actions-and-stores.md,
    // Proposal A Stage 1).
    checkDuplicateActions(comp.decls.filter(isActionDecl), `component '${comp.name}'`, accept);
  }
}

/** Flag a second `action` member that re-declares a name already used on the
 *  same page/component surface (`loom.duplicate-action`).  AST-level: the IR's
 *  `indexActions` keys by name and would silently overwrite the first body, so
 *  the duplicate must be rejected before lowering. */
function checkDuplicateActions(
  actions: readonly ActionDecl[],
  surface: string,
  accept: ValidationAcceptor,
): void {
  const seen = new Set<string>();
  for (const a of actions) {
    if (seen.has(a.name)) {
      accept(
        "error",
        `Duplicate action '${a.name}' on ${surface}; action names must be unique on a page/component.`,
        { node: a, property: "name", code: "loom.duplicate-action" },
      );
      continue;
    }
    seen.add(a.name);
  }
}

export function checkTheme(block: ThemeBlock, accept: ValidationAcceptor): void {
  // Colour tokens (validated as hex) — palette + semantic slots.
  const colorNames = new Set([
    "primary",
    "secondary",
    "accent",
    "success",
    "warning",
    "error",
    "neutral",
  ]);
  // Non-colour tokens — each has its own per-property validator
  // below (radius enum, fontFamily/fontFamilyMono free-form,
  // colorScheme enum).
  const knownNames = new Set([
    ...colorNames,
    "radius",
    "fontFamily",
    "fontFamilyMono",
    "colorScheme",
  ]);
  const knownRadius = new Set(["none", "sm", "md", "lg", "xl"]);
  const knownColorSchemes = new Set(["light", "dark", "auto"]);
  // Hex colors: #RGB, #RRGGBB, or #RRGGBBAA.  Named colors,
  // `rgb(...)`, and CSS vars are rejected to keep the surface tight
  // and the Mantine shade-ramp generator simple.
  const hexColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const seen = new Set<string>();
  for (const p of block.props) {
    // (1) Unknown property name.
    if (!knownNames.has(p.name)) {
      accept(
        "error",
        `unknown theme property '${p.name}'. Known properties: ${[...knownNames].join(", ")}.`,
        { node: p, property: "name" },
      );
      continue;
    }
    // (2) Duplicate property name.
    if (seen.has(p.name)) {
      accept("error", `theme property '${p.name}' declared more than once.`, {
        node: p,
        property: "name",
      });
      continue;
    }
    seen.add(p.name);
    // (3) Per-property value validation.
    if (colorNames.has(p.name)) {
      if (!hexColor.test(p.value)) {
        accept(
          "error",
          `theme '${p.name}' must be a CSS hex color (#RGB, #RRGGBB, or #RRGGBBAA); got '${p.value}'.`,
          { node: p, property: "value" },
        );
      }
    } else if (p.name === "radius") {
      if (!knownRadius.has(p.value)) {
        accept(
          "error",
          `theme 'radius' must be one of ${[...knownRadius].join(" | ")}; got '${p.value}'.`,
          { node: p, property: "value" },
        );
      }
    } else if (p.name === "colorScheme") {
      if (!knownColorSchemes.has(p.value)) {
        accept(
          "error",
          `theme 'colorScheme' must be one of ${[...knownColorSchemes].join(" | ")}; got '${p.value}'.`,
          { node: p, property: "value" },
        );
      }
    }
    // fontFamily / fontFamilyMono are free-form strings —
    // pass-through to the Mantine theme.  No validation beyond
    // "non-empty"; a typo'd family name silently falls through
    // to the OS fallback at runtime, which is acceptable.
  }
}

// ---------------------------------------------------------------------------
// Page metamodel validator obligations.
//
// Walks each `ui` SystemMember and emits diagnostics for malformed
// pages, scaffold directives, menus, and the references between
// them.  Cross-cutting rules (uniqueness across uis, deployable.ui
// → ui resolution) are handled in the dispatcher and
// `checkDeployable()` respectively.
//
// These checks are intentionally syntactic / cross-reference; deeper
// type analysis on body expressions and component-stdlib parameter
// shape lives in the page emitter (closed-stdlib spec table).
// ---------------------------------------------------------------------------

export function checkUi(ui: Ui, sys: System, accept: ValidationAcceptor): void {
  // Page name uniqueness is *per scope* (Rule 7): the ui's top level and each
  // `area { … }` block form their own page namespace, so role-named pages
  // (`page List` repeated across per-aggregate areas) don't collide, while a
  // genuine duplicate within one scope is still an error.  Override-by-name is
  // the SAME mechanism — an explicit page displaces exactly one scaffolded page
  // in its scope; two explicit pages with the same name in one scope are an
  // error.  Recurses into nested areas.
  const checkPageScope = (members: readonly UiMember[], scopeLabel: string): void => {
    const seen = new Map<string, Page>();
    for (const m of members) {
      if (m.$type === "Area") {
        checkPageScope(m.members, `area '${m.name}'`);
        continue;
      }
      if (m.$type !== "Page") continue;
      if (seen.has(m.name)) {
        accept(
          "error",
          `Duplicate page '${m.name}' in ${scopeLabel}.  Pages within a scope (the ui top level or one area) must have unique names; an explicit override-by-name displaces a single scaffolded page, not another explicit one.`,
          { node: m, property: "name" },
        );
      } else {
        seen.set(m.name, m);
      }
    }
  };
  checkPageScope(ui.members, `ui '${ui.name}'`);

  // At most one ui-level menu block (Rule 8 part).
  const menuBlocks = ui.members.filter((m) => m.$type === "MenuBlock");
  if (menuBlocks.length > 1) {
    for (const extra of menuBlocks.slice(1)) {
      accept(
        "error",
        `ui '${ui.name}' declares more than one 'menu { ... }' block; keep just the first.`,
        { node: extra },
      );
    }
  }

  // UI api parameter checks.
  //   - Param names unique within the ui (`api Sales: …` declared twice).
  //   - apiRef cross-ref must resolve (handled by Langium linker; the
  //     refRoot returns undefined when the target isn't found, so the
  //     check below catches it explicitly with a clearer message).
  const apiParamSeen = new Map<string, UiApiParam>();
  for (const m of ui.members) {
    if (m.$type !== "UiApiParam") continue;
    const prior = apiParamSeen.get(m.name);
    if (prior) {
      accept("error", `ui '${ui.name}' declares api parameter '${m.name}' more than once.`, {
        node: m,
        property: "name",
      });
    } else {
      apiParamSeen.set(m.name, m);
    }
    if (!m.apiRef?.ref) {
      accept(
        "error",
        `ui '${ui.name}' references undeclared api '${m.apiRef?.$refText ?? "<missing>"}'.  Declare it at system scope as 'api ${m.apiRef?.$refText ?? "<Name>"} from <Module>'.`,
        { node: m, property: "apiRef" },
      );
    }
  }

  // UI channel parameter checks (channels.md Part I, ui surface).
  //   - Param names unique within the ui (shared namespace with api
  //     params — `channel Sales: …` next to `api Sales: …` would make
  //     `on Sales.X` ambiguous to a reader even though the cross-ref
  //     type disambiguates).
  //   - The subscribed channel must be `delivery: broadcast` — `queue`
  //     is competing-consumer work distribution, never UI-observable.
  const channelParamSeen = new Map<string, UiChannelParam>();
  for (const m of ui.members) {
    if (m.$type !== "UiChannelParam") continue;
    const prior = channelParamSeen.get(m.name) ?? apiParamSeen.get(m.name);
    if (prior) {
      accept("error", `ui '${ui.name}' declares parameter '${m.name}' more than once.`, {
        node: m,
        property: "name",
      });
    } else {
      channelParamSeen.set(m.name, m);
    }
    const ch = m.channel?.ref;
    if (ch && (ch.delivery ?? "broadcast") !== "broadcast") {
      accept(
        "error",
        `ui '${ui.name}' subscribes to channel '${ch.name}', but its delivery is '${ch.delivery}'.  Only 'delivery: broadcast' channels are UI-observable; 'queue' is work distribution.`,
        { node: m, property: "channel", code: "loom.ui-channel-not-broadcast" },
      );
    }
  }

  // Extern frontend functions (extern-function-hook-escape-hatch.md §3):
  //   - a name may not shadow a walker-stdlib primitive (the body
  //     dispatcher would route the call to the primitive, silently
  //     ignoring the user's module);
  //   - names unique within the ui.
  const fnSeen = new Set<string>();
  for (const m of ui.members) {
    if (m.$type !== "UiFunction") continue;
    if (isWalkerPrimitive(m.name)) {
      accept(
        "error",
        `extern function '${m.name}' shadows a walker-stdlib primitive.  Pick a different name.`,
        { node: m, property: "name", code: "loom.extern-function-shadows-stdlib" },
      );
    }
    if (fnSeen.has(m.name)) {
      accept("error", `ui '${ui.name}' declares function '${m.name}' more than once.`, {
        node: m,
        property: "name",
      });
    }
    fnSeen.add(m.name);
  }

  // Per-member walks.  `Scaffold` is gone — its arg-resolution
  // diagnostics now live in the macro expander, which surfaces
  // them through the same accept() pipeline.
  for (const m of ui.members) {
    if (m.$type === "Page") checkPage(m, ui, accept);
    else if (m.$type === "MenuBlock") checkMenuBlock(m, ui, accept);
    else if (m.$type === "UiNotification") checkUiNotification(m, ui, accept);
    else if (m.$type === "Store") checkStore(m, accept);
  }
  void sys;
}

/** Valid `persist: <value>` identifiers for the store lifetime ladder
 *  (frontend-state-management.md §3.1).  The value is a plain `ID` in the
 *  grammar (so `url`/`local`/`session` stay usable as field names), so its
 *  membership is enforced here rather than by the parser. */
const STORE_LIFETIMES = new Set(["memory", "local", "session", "url"]);

export function checkStore(store: Store, accept: ValidationAcceptor): void {
  if (store.lifetime != null && !STORE_LIFETIMES.has(store.lifetime)) {
    accept(
      "error",
      `store '${store.name}': unknown lifetime '${store.lifetime}' — ` +
        `\`persist:\` accepts ${[...STORE_LIFETIMES].join(" | ")}.`,
      { node: store, property: "lifetime", code: "loom.store-lifetime-invalid" },
    );
  }
}

/** `on <param>.<Event>(e) { … }` live-event handler (channels.md Part I).
 *  A handler body admits two actions:
 *
 *   - `toast(<one message expression>)` — a message notification.
 *   - `refetch(<Aggregate>[, <Aggregate>…])` — invalidate that
 *     aggregate's query cache, the realtime twin of a mutation's
 *     `onSuccess` invalidation.  Each target must name an aggregate
 *     declared in the enclosing system (the frontend registers its
 *     queries under `["<snake-plural>"]`).
 *
 *  Anything else (an assignment, `navigate(…)`, an unknown call) has
 *  nowhere to lower and is rejected with `loom.ui-handler-unsupported`.
 *  An unresolvable refetch target gets the distinct, more specific
 *  `loom.ui-handler-refetch-target` code. */
export function checkUiNotification(n: UiNotification, ui: Ui, accept: ValidationAcceptor): void {
  // Aggregate names declared anywhere in the enclosing model — the
  // frontend api modules the ui mounts register their queries under
  // `["<snake-plural-of-aggregate>"]`, so a refetch target must name a
  // real aggregate for the invalidation to hit anything.
  const aggregateNames = new Set<string>();
  for (const node of AstUtils.streamAllContents(AstUtils.findRootNode(ui))) {
    if (isAggregate(node)) aggregateNames.add(node.name);
  }
  const where = `'on ${n.param?.$refText}.${n.event?.$refText}' handler`;
  for (const stmt of n.body) {
    const isBareCall = !stmt.op && stmt.target.call === true && stmt.target.tail.length === 0;
    const head = stmt.target.head;
    if (isBareCall && head === "toast" && stmt.target.args.length === 1) {
      continue; // toast(<message>)
    }
    if (isBareCall && head === "refetch") {
      if (stmt.target.args.length === 0) {
        accept(
          "error",
          `'refetch(…)' in ${where} needs at least one aggregate to refetch, e.g. 'refetch(Order)'.`,
          { node: stmt, code: "loom.ui-handler-refetch-target" },
        );
        continue;
      }
      for (const arg of stmt.target.args) {
        if (!isNameRef(arg)) {
          accept(
            "error",
            `'refetch(…)' arguments in ${where} must each name an aggregate (e.g. 'refetch(Order)').`,
            { node: arg, code: "loom.ui-handler-refetch-target" },
          );
        } else if (!aggregateNames.has(arg.name)) {
          accept(
            "error",
            `Unknown refetch target '${arg.name}' in ${where} — it must name an aggregate declared in this system.`,
            { node: arg, code: "loom.ui-handler-refetch-target" },
          );
        }
      }
      continue;
    }
    accept(
      "error",
      `Unsupported statement in ${where}.  A handler body supports 'toast(<message expression>)' (one argument) and 'refetch(<Aggregate>[, …])'.`,
      { node: stmt, code: "loom.ui-handler-unsupported" },
    );
  }
}

export function checkPage(p: Page, ui: Ui, accept: ValidationAcceptor): void {
  void ui;
  // Validate api body refs first so each chain ref
  // gets a precise diagnostic with source-location ranges.
  checkApiBodyRefs(p, ui, accept);
  // Property uniqueness (Rule 9 part) — at most one each of route,
  // title, requires, body, menu metadata.  Multiple `state {}`
  // blocks merge (per spec §6 — same posture as `permissions`).
  const seen = new Map<string, number>();
  for (const prop of p.props) {
    const key = prop.$type;
    if (key === "StateBlock") continue; // multiple allowed
    // Multiple named `action`s per page are the norm (`action next()` +
    // `action submit()`) — they're declarations, not single-valued props
    // (named-actions-and-stores.md, Proposal A Stage 1).
    if (key === "ActionDecl") continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      accept(
        "error",
        `Page '${p.name}' declares more than one '${pagePropDisplayName(key)}' property; keep just the first.`,
        { node: p, property: "name" },
      );
    }
  }

  // Duplicate named action on one page — `ActionDecl` is excluded from the
  // single-valued-prop uniqueness loop above (multiple actions are the norm),
  // so it gets its own name-uniqueness check (named-actions-and-stores.md,
  // Proposal A Stage 1, Fix 2).
  checkDuplicateActions(p.props.filter(isActionDecl), `page '${p.name}'`, accept);

  // PageMenuMeta key names — only `section` / `label` / `order` /
  // `hidden` are recognised (parser accepts any LooseName via the
  // soft-keyword rule).
  const allowedMenuMetaKeys = new Set(["section", "label", "order", "hidden"]);
  for (const prop of p.props) {
    if (prop.$type !== "PageMenuMeta") continue;
    for (const entry of prop.entries) {
      if (!allowedMenuMetaKeys.has(entry.name)) {
        accept(
          "error",
          `Unknown menu metadata key '${entry.name}' on page '${p.name}'.  Recognised keys: ${[
            ...allowedMenuMetaKeys,
          ].join(", ")}.`,
          { node: entry, property: "name" },
        );
      }
    }
  }

  // LayoutProp — Phase 8 admits two preset values (`default` /
  // `none`) plus the name of any `layout <Name> { … }` SystemMember
  // declared in the same system.  Resolution is system-scope: walk
  // up the AST to the enclosing System and look for a matching
  // Layout declaration.
  //
  // The v1 restriction "no `layout:` on scaffold-synthesised pages"
  // is intentionally dropped — named layouts make
  // `Home: layout AdminFrame` meaningful (a scaffold Home page can
  // now opt into a custom chrome).
  const system = ui.$container;
  const declaredLayouts = new Set<string>();
  if (system?.$type === "System") {
    for (const m of system.members) {
      if (m.$type === "Layout") declaredLayouts.add(m.name);
    }
  }
  for (const prop of p.props) {
    if (prop.$type !== "LayoutProp") continue;
    const v = prop.value;
    const isPreset = v === "default" || v === "none";
    if (!isPreset && !declaredLayouts.has(v)) {
      const known = ["default", "none", ...declaredLayouts].join(", ");
      accept("error", `Unknown layout '${v}' on page '${p.name}'.  Recognised: ${known}.`, {
        node: prop,
        property: "value",
      });
    }
  }
}

export function checkMenuBlock(block: MenuBlock, _ui: Ui, accept: ValidationAcceptor): void {
  // Rule 8 — every page-link in a menu block must reference a page.
  // The grammar's `[Page:ID]` cross-reference resolves through the
  // default scope provider, already scoped to the surrounding ui, so
  // the linker reports unresolved refs natively ("Could not resolve
  // reference to Page named 'X'") — no custom validator message needed.
  for (const section of block.sections) {
    for (const link of section.links) {
      // MenuLinkProp key names — only `label` / `order` recognised.
      const allowedLinkKeys = new Set(["label", "order"]);
      for (const prop of link.props ?? []) {
        if (!allowedLinkKeys.has(prop.name)) {
          accept(
            "error",
            `Unknown menu link property '${prop.name}'.  Recognised: ${[...allowedLinkKeys].join(
              ", ",
            )}.`,
            { node: prop, property: "name" },
          );
        }
      }
    }
  }
}

/** Validate `<paramName>.<aggregate>.<op>` body
 *  ref chains in a page.  Each chain must:
 *    - root at a declared UiApiParam in the page's UI
 *    - reference a real aggregate in the api's source module
 *    - reference a real operation on that aggregate (CRUD or
 *      repository find)
 *  Diagnostics emit at the source-level node so the editor
 *  underlines the exact wrong segment. */
export function checkApiBodyRefs(p: Page, ui: Ui, accept: ValidationAcceptor): void {
  // Build the param-name → resolved Api map for this UI.
  const apiByParam = new Map<string, Api>();
  for (const m of ui.members) {
    if (m.$type !== "UiApiParam") continue;
    const apiNode = m.apiRef?.ref;
    if (apiNode) apiByParam.set(m.name, apiNode);
  }
  if (apiByParam.size === 0) return; // no api params → nothing to validate

  // Walk every Expression in the page (body, title, requires,
  // state inits — anything that can mention a body-ref chain).
  // Post-flatten: a 3-segment chain `<paramName>.<aggregate>.<op>` is
  // a single PostfixChain with head=NameRef(paramName) and two
  // MemberSuffix suffixes.
  for (const node of AstUtils.streamAllContents(p)) {
    if (!isPostfixChain(node)) continue;
    if (node.suffixes.length < 2) continue;
    const head = node.head;
    if (head.$type !== "NameRef") continue;
    const rootName = (head as NameRef).name as string;
    if (!apiByParam.has(rootName)) continue;
    const aggSuffix = node.suffixes[0];
    const opSuffix = node.suffixes[1];
    if (!aggSuffix || !isMemberSuffix(aggSuffix)) continue;
    if (!opSuffix || !isMemberSuffix(opSuffix)) continue;

    const apiNode = apiByParam.get(rootName)!;
    const moduleName = apiNode.source?.$refText ?? "";
    const aggregateName = aggSuffix.member as string;
    const op = opSuffix.member as string;

    const moduleNode = apiNode.source?.ref;
    const aggregate = moduleNode ? findAggregateInModule(moduleNode, aggregateName) : undefined;
    if (!aggregate) {
      accept(
        "error",
        `Aggregate '${aggregateName}' not found in api '${apiNode.name}' (subdomain '${moduleName}').`,
        { node: aggSuffix, property: "member" },
      );
      continue;
    }

    if (!isValidApiOperation(aggregate, op)) {
      const allowed = listValidApiOperations(aggregate);
      accept(
        "error",
        `Operation '${op}' is not declared on aggregate '${aggregateName}'.  Available: ${allowed.join(", ")}.`,
        { node: opSuffix, property: "member" },
      );
    }
  }
}

/** Phase 8: validate a named `layout <Name> { … }` SystemMember. */
export function checkLayout(layout: Layout, accept: ValidationAcceptor): void {
  if (layout.name === "default" || layout.name === "none") {
    accept(
      "error",
      "Layout name '" + layout.name + "' shadows a reserved layout preset.  Pick a different name.",
      { node: layout, property: "name" },
    );
  }
  let mainCount = 0;
  const slotCounts = new Map<string, number>();
  for (const slot of layout.slots) {
    if (slot.$type === "LayoutMainSlot") {
      mainCount++;
      continue;
    }
    const slotName = (slot as { name?: string }).name ?? "";
    slotCounts.set(slotName, (slotCounts.get(slotName) ?? 0) + 1);
  }
  if (mainCount === 0) {
    accept(
      "error",
      "Layout '" + layout.name + "' must declare a 'main' slot (the page-body Outlet position).",
      { node: layout, property: "name" },
    );
  } else if (mainCount > 1) {
    accept(
      "error",
      "Layout '" + layout.name + "' declares more than one 'main' slot; keep just the first.",
      { node: layout, property: "name" },
    );
  }
  for (const [slotName, count] of slotCounts) {
    if (count > 1) {
      accept(
        "error",
        "Layout '" +
          layout.name +
          "' declares more than one '" +
          slotName +
          "' slot; keep just the first.",
        { node: layout, property: "name" },
      );
    }
  }
}
