// ---------------------------------------------------------------------------
// Phoenix sidebar component emitter.
//
// Exports `renderSidebarComponent`, which produces the Elixir source for
// `lib/<app>_web/components/sidebar.ex` — a Phoenix.Component function that
// renders the application's sidebar navigation.
//
// The section/link structure is derived from the UI IR using
// `deriveSidebarFromUi` (the same React menu-emitter derivation), so explicit
// `ui.menu { section ... }` blocks and per-page `menuMeta` annotations both
// drive the Phoenix sidebar just as they drive the React sidebar.
//
// The MARKUP is design vocabulary and belongs to the deployable's HEEx design
// pack: this module prepares the VM (sections, entries, per-link gates) and
// renders `pack.render("sidebar", vm)` — the `sidebar-entry` template is a
// pack-internal partial the section loop composes.
// ---------------------------------------------------------------------------

import type { PageIR, UiIR } from "../../ir/types/loom-ir.js";
import type { PageNameCtx } from "../../ir/util/page-kind.js";
import { tryRenderGate } from "../_frontend/gate-expr.js";
import type { NavSectionVM } from "../_frontend/menu-emitter.js";
import { deriveSidebarFromUi } from "../_frontend/menu-emitter.js";
import type { LoadedPack } from "../_packs/loader.js";
import { renderRequiresGuardInTemplate } from "./heex-walker-core.js";
import { elixirI18nString } from "./i18n.js";

export interface RenderSidebarComponentArgs {
  ui: UiIR;
  appName: string;
  appModule: string;
  /** Served decl names for `classifyPage` (replaces stamped origin). */
  nameCtx: PageNameCtx;
  /** True when this deployable runs `auth: required` — so `LiveAuth.on_mount`
   *  assigns `@current_user` into the LiveView scope and the app layout passes
   *  it through to the sidebar.  Gates a nav link whose linked page has a
   *  currentUser-only `requires` clause (server-side, via a HEEx
   *  `<%= if (<gate>) do %>`).  False ⇒ no `@current_user` exists, so NO
   *  gating is emitted and the sidebar stays byte-identical. */
  authEnabled?: boolean;
  /** The deployable's loaded HEEx design pack — owns the sidebar markup. */
  pack: LoadedPack;
  /** True when this ui has extractable user-visible strings (M-T1.11) — the
   *  nav labels then bind through `pgettext(<catalog key>, <English>)` instead
   *  of shipping the source string at every locale.  False ⇒ byte-identical. */
  i18nEnabled?: boolean;
}

/** One sidebar link as the pack's `sidebar-entry` template consumes it.
 *  `label`/`testId`/`to`/`url` are pre-escaped for HEEx here (escaping is
 *  generator knowledge, not pack knowledge); `gate` is a pre-rendered Elixir
 *  predicate over `@current_user`, absent when the link is ungated. */
interface SidebarEntryVM {
  external: boolean;
  /** External href — `""` unless `external`. */
  url: string;
  /** Internal route for the `~p` sigil — `""` when `external`. */
  to: string;
  label: string;
  testId: string;
  /** Pre-rendered Elixir gate predicate — `""` when the link is ungated. */
  gate: string;
}

/** Emit the full Elixir source for `lib/<app>_web/components/sidebar.ex`. */
export function renderSidebarComponent(args: RenderSidebarComponentArgs): string {
  const { ui, appName, appModule, nameCtx, authEnabled = false, pack, i18nEnabled = false } = args;

  /** A nav label in HEEx TEXT position.  An AUTHORED label (one the extraction
   *  pass keyed into the catalog — `menu.link.*` / `page.<P>.menu.label.*`)
   *  binds through gettext under i18n; an emitter-DERIVED label (the default
   *  aggregate/workflow sidebar) has no key, so it stays the escaped literal —
   *  byte-identical to the pre-i18n sidebar.  A13b. */
  const navLabel = (label: string, key: string | undefined): string =>
    i18nEnabled && key
      ? `<%= pgettext(${elixirI18nString(key)}, ${elixirI18nString(label)}) %>`
      : escapeHeex(label);

  const navSections: NavSectionVM[] = deriveSidebarFromUi(ui, nameCtx) ?? buildDefaultSections(ui);

  // Per-entry currentUser-only gate, keyed by route.  Only populated when the
  // deployable has auth (so `@current_user` exists in the layout/sidebar
  // scope) and the linked page declares a currentUser-only `requires`.  A
  // non-currentUser predicate (one that touches `this`/params) is left
  // ungated — the sidebar has no record context to evaluate it against.
  const gateByRoute = authEnabled ? buildGatesByRoute(ui, appModule) : new Map<string, string>();

  // Section h3 wrappers only appear when there is more than one labelled
  // section — a single (or unlabelled) section renders its entries directly.
  const multi = navSections.length > 1;
  const sections = navSections.map((section) => ({
    labelled: multi && !!section.label,
    label: navLabel(section.label, section.labelKey),
    entries: section.entries.map((entry): SidebarEntryVM => {
      // Every VM key is always present (empty string when inapplicable) —
      // the pack templates compile in Handlebars strict mode, which throws
      // on a missing field rather than rendering it blank.
      const base = {
        label: navLabel(entry.label, entry.labelKey),
        testId: escapeHeex(entry.testId),
        gate: gateByRoute.get(entry.to) ?? "",
      };
      // External links — sentinel `__external:<url>` written by menu-emitter.
      // They map to no page, so they are never gated.
      if (entry.to.startsWith("__external:")) {
        return {
          ...base,
          external: true,
          url: escapeHeex(entry.to.slice("__external:".length)),
          to: "",
        };
      }
      return { ...base, external: false, to: escapeHeex(entry.to), url: "" };
    }),
  }));

  return pack.render("sidebar", {
    webModule: `${appModule}Web`,
    appName,
    authEnabled,
    sections,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build the route → rendered-gate map for the sidebar.  For every page
 *  with a `requires` clause that is currentUser-only (evaluable against the
 *  signed-in user alone — no record/param context), render the gate in HEEx
 *  template scope (`@current_user.…`).  Pages whose predicate touches
 *  `this`/params are skipped (the sidebar can't evaluate them), leaving
 *  their link ungated — the backend/page guard still enforces access. */
function buildGatesByRoute(ui: UiIR, appModule: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const page of ui.pages) {
    if (!page.requires || !page.route || page.route.includes(":")) continue;
    // Reuse the JS gate-expr's currentUser-only classifier: a non-null
    // result means the predicate touches only `currentUser` + constants —
    // exactly the subset the sidebar can render against `@current_user`.
    if (tryRenderGate(page.requires, "currentUser") === null) continue;
    const gate = renderRequiresGuardInTemplate(page as PageIR, ui, appModule);
    if (gate) out.set(page.route, gate);
  }
  return out;
}

/** Escape special HEEx characters in plain text content. */
function escapeHeex(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fallback: when the UI has no explicit menu block AND no eligible explicit
 *  pages with menuMeta, build a minimal section from whatever pages the UI
 *  declares.  This avoids an empty sidebar when `deriveSidebarFromUi`
 *  returns `undefined`. */
function buildDefaultSections(ui: UiIR): NavSectionVM[] {
  const entries = ui.pages
    .filter((p) => p.route && !p.route.includes(":"))
    .map((p) => ({
      to: p.route ?? "/",
      label: p.name,
      testId: `nav-${p.name.toLowerCase()}`,
      activeArgs: JSON.stringify(p.route ?? "/"),
    }));

  if (entries.length === 0) return [];
  return [{ label: "", entries }];
}
