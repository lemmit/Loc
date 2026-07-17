// Named layouts — Vue flavour (Phase 8).
//
// A `layout <Name> { header / main / footer }` SystemMember wraps every
// page that selects it via `layout: <Name>`.  React weaves the layout
// wrappers into App.tsx and nests routes via React Router; SvelteKit
// uses route groups.  The vue-router-native shape is nested routes: a
// parent route whose `component` is the layout SFC (slots + an inner
// `<router-view />` for the page), with the layout-bound pages as
// `children`.
//
// Layout slots are static wrappers — no params, no state, no API calls
// — so the walker runs with empty defaults; what comes back is pack
// markup + the imports it needs.  `main` is implicit: the inner
// `<router-view />`.

import type { ComponentIR, LayoutIR, ParamIR, SystemIR, UiIR } from "../../ir/types/loom-ir.js";
import type { LoadedPack } from "../_packs/loader.js";
import { walkBody } from "../_walker/walker-core.js";
import { vueTarget } from "./walker/vue-target.js";

interface WalkedSlot {
  html: string;
  imports: Map<string, ReadonlySet<string>>;
  usedUserComponents: ReadonlySet<string>;
  usesNavigate: boolean;
}

function walkSlot(
  body: NonNullable<LayoutIR["header"]>,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
): WalkedSlot {
  const result = walkBody(body, vueTarget, pack, new Set(), new Set(), userComponents);
  return {
    html: result.tsx,
    imports: result.imports,
    usedUserComponents: result.usedUserComponents,
    usesNavigate: result.usesNavigate,
  };
}

/** A prepared named layout: the emit path + rendered SFC content. */
export interface PreparedVueLayout {
  name: string;
  /** `src/layouts/<Name>.vue` content. */
  content: string;
}

/** For every named layout REFERENCED by a page in this ui, walk its
 *  slot expressions and render the `src/layouts/<Name>.vue` SFC.
 *  Returns `[]` when no page selects a named layout. */
export function prepareVueNamedLayouts(
  ui: UiIR,
  sys: SystemIR,
  pack: LoadedPack,
  topLevelComponents: readonly ComponentIR[] = [],
  externComponents: ReadonlySet<string> = new Set(),
): PreparedVueLayout[] {
  if (sys.layouts.length === 0) return [];
  const referenced = new Set<string>();
  for (const page of ui.pages) {
    if (page.layout?.kind === "named") referenced.add(page.layout.ref);
  }
  if (referenced.size === 0) return [];
  // Build the per-emit `userComponents` map the same way the page
  // emitter does: top-level seeds first, ui-scope overrides on
  // collision.  Layout-slot walks consult it identically.
  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);

  const out: PreparedVueLayout[] = [];
  for (const layout of sys.layouts) {
    if (!referenced.has(layout.name)) continue;
    out.push({
      name: layout.name,
      content: renderVueLayoutFile(layout, pack, userComponents, externComponents),
    });
  }
  return out;
}

function renderVueLayoutFile(
  layout: LayoutIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
  externComponents: ReadonlySet<string>,
): string {
  const header = layout.header ? walkSlot(layout.header, pack, userComponents) : undefined;
  const sidebar = layout.sidebar ? walkSlot(layout.sidebar, pack, userComponents) : undefined;
  const footer = layout.footer ? walkSlot(layout.footer, pack, userComponents) : undefined;
  const slots = [header, sidebar, footer].filter((s): s is WalkedSlot => s !== undefined);

  // Aggregate the slot imports.  Layout slots reach only pack primitives
  // + user components (no api/forms), so the import set is small.
  const vueImports = new Set<string>();
  const importLines: string[] = [];
  const usedComponents = new Set<string>();
  const usesNavigate = slots.some((s) => s.usesNavigate);
  const packImports = new Map<string, Set<string>>();
  const walkerInternalSources = new Set(["react-hook-form", "@hookform/resolvers/zod"]);
  for (const slot of slots) {
    for (const n of slot.usedUserComponents) usedComponents.add(n);
    for (const [from, names] of slot.imports) {
      if (names.size === 0) continue;
      if (walkerInternalSources.has(from) || from.startsWith("./") || from.startsWith("../")) {
        continue;
      }
      const set = packImports.get(from) ?? new Set<string>();
      for (const n of names) set.add(n);
      packImports.set(from, set);
    }
  }

  const script: string[] = [];
  if (usesNavigate) {
    vueImports.add("useRouter");
  }
  if (usesNavigate) {
    script.push(`import { useRouter } from "vue-router";`);
  }
  // Format helpers — imported unconditionally, mirroring the page /
  // component shells (layouts sit at src/layouts/, one hop from src/).
  script.push(
    `import { EMPTY, formatBool, formatDateTime, formatMoney, formatNumber, formatPlain, isEmpty, shortId } from "../lib/format";`,
  );
  for (const [from, names] of [...packImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    script.push(`import { ${[...names].sort().join(", ")} } from "${from}";`);
  }
  for (const n of [...usedComponents].sort()) {
    const ext = externComponents.has(n) ? "" : ".vue";
    script.push(`import ${n} from "../components/${n}${ext}";`);
  }
  if (usesNavigate) {
    script.push("");
    script.push("const router = useRouter();");
    script.push("const navigate = (to: string) => { void router.push(to); };");
  }
  void vueImports;
  void importLines;

  // a11y: the header / routed-content / footer slots are wrapped in the
  // matching landmark elements (<header>, <main id="main-content">, <footer>)
  // so a named layout carries the same landmark set the auto DefaultLayout does.
  const body: string[] = [];
  if (header) {
    body.push("    <header>");
    body.push(indentSlot(header.html, "      "));
    body.push("    </header>");
  }
  if (sidebar) {
    body.push('    <div class="loom-layout-body">');
    body.push(indentSlot(sidebar.html, "      "));
    body.push('      <main id="main-content"><router-view /></main>');
    body.push("    </div>");
  } else {
    body.push('    <main id="main-content"><router-view /></main>');
  }
  if (footer) {
    body.push("    <footer>");
    body.push(indentSlot(footer.html, "      "));
    body.push("    </footer>");
  }

  // A named layout is a top-level routed component, so on Vuetify it must
  // carry the `<v-app>` root every Vuetify component needs for layout/theme
  // injection (the auto DefaultLayout, a pack template, does the same).  Other
  // vue packs (shadcnVue) use the plain wrapper.
  const testid = `layout-${snakeName(layout.name)}`;
  const [openTag, closeTag] =
    pack.manifest.name === "vuetify"
      ? [`<v-app data-testid="${testid}">`, "</v-app>"]
      : [`<div class="loom-layout" data-testid="${testid}">`, "</div>"];

  return `<!-- Auto-generated.  Do not edit by hand.  (${layout.name} layout) -->
<script setup lang="ts">
${script.join("\n")}
</script>

<template>
  ${openTag}
${body.join("\n")}
  ${closeTag}
</template>
`;
}

function indentSlot(html: string, prefix = "    "): string {
  return html
    .split("\n")
    .map((l) => (l.length > 0 ? prefix + l : l))
    .join("\n");
}

function snakeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}
