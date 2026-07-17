// Named layouts — SvelteKit route-group flavour (Phase 8, svelte).
//
// A `layout <Name> { header: …, sidebar: …, footer: … }` SystemMember
// wraps every page that selects it via `layout: <Name>`.  React weaves
// these into the App.tsx router as `<NameLayout>` wrapper elements; the
// SvelteKit-native shape is a route group `(<group>)` whose
// `+layout.svelte` renders the slots around `{@render children()}`.
// `sveltePageGroup` routes a `layout: <Name>` page into that group dir
// (see routes-emitter); this module emits the group's `+layout.svelte`.
//
// Slots are static region trees (no params / state / api), walked
// through the shared markup walker with the svelte target exactly like
// a component body — the layout's `<script>` imports whatever pack
// primitives + user components the slots reference.

import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  ExprIR,
  ParamIR,
  SystemIR,
  UiIR,
} from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { walkBody } from "../_walker/walker-core.js";
import { renderSvelteImportLines } from "./walker/import-lines.js";
import { svelteTarget } from "./walker/svelte-target.js";

/** Route-group directory for a named layout — `LandingFrame` →
 *  `(landingframe)`.  Snake-cased so it's a stable, lowercase dir that
 *  can't collide with the reserved `(app)` / `(bare)` groups (a layout
 *  named `App` or `Bare` would, but those are not valid layout names in
 *  practice and the validator owns name uniqueness). */
export function svelteLayoutGroup(layoutName: string): string {
  return `(${snake(layoutName)})`;
}

interface SlotEmit {
  markup: string;
  imports: ReturnType<typeof walkBody>["imports"];
  usedUserComponents: Set<string>;
}

function walkSlot(
  body: ExprIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
  aggregatesByName: ReadonlyMap<string, AggregateIR>,
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>,
): SlotEmit {
  const r = walkBody(
    body,
    svelteTarget,
    pack,
    new Set(),
    new Set(),
    userComponents,
    [],
    aggregatesByName,
    bcByAggregate,
  );
  return { markup: r.tsx, imports: r.imports, usedUserComponents: r.usedUserComponents };
}

export interface SvelteLayoutContext {
  ui: UiIR;
  sys: SystemIR;
  pack: LoadedPack;
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  topLevelComponents: readonly ComponentIR[];
}

/** Emit `src/routes/(<group>)/+layout.svelte` for every named layout a
 *  page in this ui actually selects.  Returns an empty map when no page
 *  uses a named layout (so the default `(app)` chrome is untouched). */
export function emitSvelteNamedLayouts(ctx: SvelteLayoutContext): Map<string, string> {
  const out = new Map<string, string>();
  if (ctx.sys.layouts.length === 0) return out;

  const referenced = new Set<string>();
  for (const page of ctx.ui.pages) {
    if (page.layout?.kind === "named") referenced.add(page.layout.ref);
  }
  if (referenced.size === 0) return out;

  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ctx.topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ctx.ui.components) userComponents.set(c.name, c.params);

  for (const layout of ctx.sys.layouts) {
    if (!referenced.has(layout.name)) continue;
    const slots: Array<{ tag: "header" | "nav" | "footer"; body: ExprIR }> = [];
    if (layout.header) slots.push({ tag: "header", body: layout.header });
    if (layout.sidebar) slots.push({ tag: "nav", body: layout.sidebar });
    if (layout.footer) slots.push({ tag: "footer", body: layout.footer });

    const importMap = new Map<string, Set<string>>();
    const usedComponents = new Set<string>();
    const rendered = new Map<"header" | "nav" | "footer", string>();
    for (const { tag, body } of slots) {
      const s = walkSlot(body, ctx.pack, userComponents, ctx.aggregatesByName, ctx.bcByAggregate);
      rendered.set(tag, s.markup);
      for (const [from, names] of s.imports) {
        const set = importMap.get(from) ?? new Set<string>();
        for (const n of names) set.add(n);
        importMap.set(from, set);
      }
      for (const n of s.usedUserComponents) usedComponents.add(n);
    }

    const packImports = renderSvelteImportLines(importMap);
    const componentImports = [...usedComponents]
      .sort()
      .map((n) => `  import ${n} from "$lib/components/${n}.svelte";\n`)
      .join("");
    const header = rendered.has("header")
      ? `  <header class="loom-layout-header">\n    ${rendered.get("header")}\n  </header>\n`
      : "";
    const sidebar = rendered.has("nav")
      ? `    <nav class="loom-layout-sidebar">\n      ${rendered.get("nav")}\n    </nav>\n`
      : "";
    const footer = rendered.has("footer")
      ? `  <footer class="loom-layout-footer">\n    ${rendered.get("footer")}\n  </footer>\n`
      : "";

    const file = `<!-- Auto-generated.  Do not edit by hand. -->
<!-- Named layout '${layout.name}' (route group ${svelteLayoutGroup(layout.name)}). -->
<script lang="ts">
${packImports}${componentImports}  let { children } = $props();
</script>

<div class="loom-layout">
${header}  <div class="loom-layout-body">
${sidebar}    <main id="main-content" class="loom-layout-main">
      {@render children()}
    </main>
  </div>
${footer}</div>
`;
    out.set(`src/routes/${svelteLayoutGroup(layout.name)}/+layout.svelte`, file);
  }
  return out;
}
