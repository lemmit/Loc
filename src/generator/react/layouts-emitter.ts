// Phase 8 step 2 — walk each declared `layout <Name> { … }`
// SystemMember's slot expressions into TSX so the AppShell preparer
// can emit a `<Name>Layout` wrapper component per layout.
//
// Layouts are static wrappers: no params, no state, no API calls,
// no react-query hooks.  The walker handles all of that with empty
// defaults; what comes back is a slot of pure JSX + the set of
// pack imports the JSX needs.  The preparer wires those imports
// into the App.tsx shell's import list (deduped).

import type { LayoutIR, SystemIR, UiIR } from "../../ir/loom-ir.js";
import type { LoadedPack } from "../_packs/loader.js";
import { walkBodyToTsx } from "./body-walker.js";
import type { ExtraPageRoute } from "./templating/preparers/app-shell.js";
import type { ImportVM } from "./templating/view-models.js";

interface WalkedSlot {
  jsx: string;
  imports: Map<string, Set<string>>;
}

function walkSlot(body: NonNullable<LayoutIR["header"]>, pack: LoadedPack): WalkedSlot {
  const { tsx, imports } = walkBodyToTsx(body, pack);
  return { jsx: tsx, imports };
}

/** Pre-walked named layout — slots rendered to JSX, routes bucket
 *  populated.  The AppShell preparer flattens `ExtraPageRoute[]`
 *  into the final `RouteVM[]` shape the template iterates. */
export interface PreparedNamedLayout {
  name: string;
  hasHeader: boolean;
  headerJsx: string;
  hasSidebar: boolean;
  sidebarJsx: string;
  hasFooter: boolean;
  footerJsx: string;
  routes: ExtraPageRoute[];
}

/** For every named layout actually referenced by a page in this ui,
 *  pre-walk its slot expressions and bucket the routes that opted
 *  into it.  Returns `[]` when the ui has no layouts in scope. */
export function prepareNamedLayouts(
  ui: UiIR,
  sys: SystemIR,
  pack: LoadedPack,
  routesByLayout: ReadonlyMap<string, ExtraPageRoute[]>,
): { namedLayouts: PreparedNamedLayout[]; extraImports: ImportVM[] } {
  if (sys.layouts.length === 0) return { namedLayouts: [], extraImports: [] };
  const referenced = new Set<string>();
  for (const page of ui.pages) {
    if (page.layout?.kind === "named") referenced.add(page.layout.ref);
  }
  const namedLayouts: PreparedNamedLayout[] = [];
  const aggregatedImports = new Map<string, Set<string>>();
  for (const layout of sys.layouts) {
    if (!referenced.has(layout.name)) continue;
    const header = layout.header ? walkSlot(layout.header, pack) : undefined;
    const sidebar = layout.sidebar ? walkSlot(layout.sidebar, pack) : undefined;
    const footer = layout.footer ? walkSlot(layout.footer, pack) : undefined;
    for (const slot of [header, sidebar, footer]) {
      if (!slot) continue;
      for (const [from, symbols] of slot.imports) {
        const existing = aggregatedImports.get(from) ?? new Set<string>();
        for (const sym of symbols) existing.add(sym);
        aggregatedImports.set(from, existing);
      }
    }
    namedLayouts.push({
      name: layout.name,
      hasHeader: header !== undefined,
      headerJsx: header?.jsx ?? "",
      hasSidebar: sidebar !== undefined,
      sidebarJsx: sidebar?.jsx ?? "",
      hasFooter: footer !== undefined,
      footerJsx: footer?.jsx ?? "",
      routes: routesByLayout.get(layout.name) ?? [],
    });
  }
  // The shell template renders each entry as `import {{specifier}}
  // from "{{from}}"` (default-import syntax for page components).
  // Mantine primitives like `Title` / `Text` / `Stack` are already
  // destructured from `@mantine/core` at the top of the shell file,
  // so threading them again would emit duplicate (and worse,
  // default-vs-named-shape) imports.  Skip pack-bundled origins.
  // Pack-specific origins follow the same logic (the per-pack
  // AppShell template already imports its core primitives).
  const PACK_INTRINSIC_ORIGINS = new Set([
    "@mantine/core",
    "@mantine/hooks",
    "@chakra-ui/react",
    "@mui/material",
    "react",
    "react-router",
    "react-router-dom",
  ]);
  const extraImports: ImportVM[] = [];
  for (const [from, symbols] of aggregatedImports) {
    if (PACK_INTRINSIC_ORIGINS.has(from)) continue;
    if (from.startsWith("@/components/ui/")) continue; // shadcn
    for (const symbol of symbols) {
      extraImports.push({ specifier: symbol, from });
    }
  }
  return { namedLayouts, extraImports };
}
