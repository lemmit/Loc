// UI / page / menu / theme / helper-import / api-body-ref checks.

import { AstUtils, type ValidationAcceptor } from "langium";
import type {
  Api,
  Layout,
  MenuBlock,
  Model,
  NameRef,
  Page,
  System,
  ThemeBlock,
  Ui,
  UiApiParam,
  UiHelperImport,
} from "../generated/ast.js";
import { isMemberSuffix, isPostfixChain } from "../generated/ast.js";
import {
  WALKER_LAYOUT_PRIMITIVES,
  WALKER_SCAFFOLD_PRIMITIVES,
  WALKER_SUB_PRIMITIVES,
} from "../walker-stdlib.js";
import {
  findAggregateInModule,
  isScaffoldOriginPageBody,
  isValidApiOperation,
  listValidApiOperations,
  pagePropDisplayName,
} from "./_shared.js";

/** Union of all walker-stdlib primitive names — derived once from the
 *  `walker-stdlib.ts` SSOT and reused across `checkUiHelperImports`
 *  invocations.  Drift between this set and the registry surfaces as
 *  a `walker-stdlib-completeness.test.ts` failure, not as a silent
 *  validation gap. */
const STDLIB_PRIMITIVES: ReadonlySet<string> = new Set<string>([
  ...WALKER_LAYOUT_PRIMITIVES,
  ...WALKER_SUB_PRIMITIVES,
  ...WALKER_SCAFFOLD_PRIMITIVES,
]);

/** `import helper <name> from "<path>"` at the UI
 *  level.  Validate two invariants:
 *   1. Helper names don't shadow any walker stdlib primitive
 *      (else a typo would silently divert a body call like
 *      `Stack(...)` from the primitive to the helper).
 *   2. No duplicate helper names within the same UI. */
export function checkUiHelperImports(model: Model, accept: ValidationAcceptor): void {
  for (const member of model.members) {
    if (member.$type !== "System") continue;
    const sys = member as System;
    const uis = sys.members.filter((sm) => sm.$type === "Ui") as Ui[];
    for (const ui of uis) {
      const seen = new Map<string, UiHelperImport>();
      for (const um of ui.members) {
        if (um.$type !== "UiHelperImport") continue;
        const h = um as UiHelperImport;
        if (STDLIB_PRIMITIVES.has(h.name)) {
          accept(
            "error",
            `Helper '${h.name}' shadows the walker stdlib primitive '${h.name}'. Rename the helper.`,
            { node: h, property: "name" },
          );
        }
        const prior = seen.get(h.name);
        if (prior) {
          accept("error", `Duplicate helper import '${h.name}' in ui '${ui.name}'.`, {
            node: h,
            property: "name",
          });
        } else {
          seen.set(h.name, h);
        }
      }
    }
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
  // Page name uniqueness within the ui (Rule 7).  Override-by-name
  // is the SAME mechanism — the explicit page must displace exactly
  // one scaffolded page; multiple explicit pages with the same name
  // are still an error.
  const pageNamesSeen = new Map<string, Page>();
  for (const m of ui.members) {
    if (m.$type !== "Page") continue;
    const prior = pageNamesSeen.get(m.name);
    if (prior) {
      accept(
        "error",
        `Duplicate page '${m.name}' in ui '${ui.name}'.  Pages within a ui must have unique names; an explicit override-by-name displaces a single scaffolded page, not another explicit one.`,
        { node: m, property: "name" },
      );
    } else {
      pageNamesSeen.set(m.name, m);
    }
  }

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

  // Per-member walks.  `Scaffold` is gone — its arg-resolution
  // diagnostics now live in the macro expander, which surfaces
  // them through the same accept() pipeline.
  for (const m of ui.members) {
    if (m.$type === "Page") checkPage(m, ui, accept);
    else if (m.$type === "MenuBlock") checkMenuBlock(m, ui, accept);
  }
  void sys;
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
  void isScaffoldOriginPageBody; // imported but unused after the v1 restriction lifted
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

export function checkMenuBlock(block: MenuBlock, ui: Ui, accept: ValidationAcceptor): void {
  // Rule 8 — every page-link in a menu block must reference a page
  // in the SAME ui.  The grammar's `[Page:ID]` cross-reference
  // resolves globally; we additionally check the resolved page's
  // container.
  const pagesInThisUi = new Set(
    ui.members.filter((m) => m.$type === "Page").map((m) => (m as Page).name),
  );
  for (const section of block.sections) {
    for (const link of section.links) {
      // Page links use a Langium cross-reference now
      // that scaffold expansion runs at the AST level.  The
      // linker reports unresolved refs natively
      // ("Could not resolve reference to Page named 'X'") — no
      // custom validator message needed.  `pagesInThisUi` is no
      // longer consulted here because cross-references are
      // already scoped to the surrounding ui by the default
      // scope provider.
      void pagesInThisUi;
      const targetName = link.page?.ref?.name ?? link.page?.$refText;
      void targetName;
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
        `Aggregate '${aggregateName}' not found in api '${apiNode.name}' (module '${moduleName}').`,
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
