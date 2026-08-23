// ---------------------------------------------------------------------------
// A page's EMIT IDENTITY — the one derivation every frontend keys its emitted
// artefacts on.
//
// The bug this module exists to kill: page identity used to be *reconstructed
// by convention* from `page.name` at each consumer (`./pages/${snake(name)}`,
// `${snake(name)}_page.dart`, `e2e/pages/${snake(name)}.ts`, …) while lowering
// had ALREADY computed the authoritative answer on the IR node (`page.area` →
// `page.emitPath`).  `page.name` is unique only within ONE area scope, so every
// such site diverged (React's router imported a module the page emitter never
// wrote — TS2307) or collided (one Flutter `list_page.dart` for every
// aggregate; one Angular `dashboard.component.ts` imported twice — TS2300) the
// moment an `area { … }` existed.  Six copies of one convention is what caused
// it, so the answer lives here once.
//
// Three questions, one source of truth each:
//
//   * WHERE does the module live      → `pageEmitPath` (honours `emitPath`)
//   * WHAT is it imported as          → `pageModuleSpecifier`
//   * WHAT single-segment file base /
//     identifier does it emit under   → `pageFileBase` / `pageEmitName`
//
// `pageEmitName` (the identifier half) lives in `src/ir/util/page-kind.ts`
// beside `classifyPage`, because the Phoenix backend needs it too and it is a
// pure function of the IR node.  This module holds the PATH half, which only
// the frontends care about.
// ---------------------------------------------------------------------------

import type { PageIR, UiIR } from "../../ir/types/loom-ir.js";
import {
  classifyPage,
  type PageNameCtx,
  pageEmitName,
  pageSlotKey,
} from "../../ir/util/page-kind.js";
import { snake } from "../../util/naming.js";

/** The page's module path within the generated project, extension included.
 *  `page.emitPath` (set by lowering from the `area` containment path, or from
 *  the scaffold's conventional archetype path) is AUTHORITATIVE; the
 *  `src/pages/<snake>.tsx` fallback applies only to a top-level page lowering
 *  left unplaced.  `ext` re-points the same path at another frontend's file
 *  extension (Vue's `.vue`). */
export function pageEmitPath(page: PageIR, ext = ".tsx"): string {
  const base = page.emitPath ?? `src/pages/${snake(page.name)}.tsx`;
  return ext === ".tsx" ? base : base.replace(/\.tsx$/, ext);
}

/** The specifier a router at `src/` imports this page by — the emit path with
 *  the `src/` prefix and the extension stripped, e.g.
 *  `src/pages/ops/billing/invoices.tsx` → `./pages/ops/billing/invoices`.
 *  Derived from {@link pageEmitPath} so an import can never name a module the
 *  page emitter did not write. */
export function pageModuleSpecifier(page: PageIR, ext = ".tsx"): string {
  const rel = pageEmitPath(page, ext)
    .replace(/^src\//, "")
    .replace(new RegExp(`${ext.replace(".", "\\.")}$`), "");
  return `./${rel}`;
}

/** A unique snake_case SINGLE-SEGMENT base for frontends whose page files live
 *  in one flat directory (Flutter's `lib/pages/`, the Playwright page objects'
 *  `e2e/pages/`, Phoenix's `live/`).  Derived from {@link pageEmitName}, so it
 *  carries the same area qualification the identifier does
 *  (`area Ops { page Dashboard }` → `ops_dashboard`) and area-less pages stay
 *  byte-identical to the old `snake(page.name)`. */
export function pageFileBase(page: PageIR, nameCtx: PageNameCtx): string {
  return snake(pageEmitName(page, nameCtx));
}

/** Slot key → the module specifier the page filling that slot actually emitted
 *  at.  First page wins on a duplicated slot (two pages classifying to the same
 *  archetype is an authoring error the IR check `loom.ui-page-slot-collision`
 *  reports; the emitter stays deterministic rather than throwing). */
export function buildPageModuleIndex(
  ui: UiIR,
  nameCtx: PageNameCtx,
  ext = ".tsx",
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const page of ui.pages) {
    const key = pageSlotKey(classifyPage(page, nameCtx));
    if (key === undefined || out.has(key)) continue;
    out.set(key, pageModuleSpecifier(page, ext));
  }
  return out;
}
