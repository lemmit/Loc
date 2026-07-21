// Menu emitter.
//
// Builds the App.tsx sidebar's `navSections` array from a `ui` block.
// Two surface forms (per spec §11):
//
//   1. Explicit `ui.menu { section "S" { link Page, link "L" -> "url" } }`
//      → walks the menu block; each `link Page` resolves to the
//        matching `PageIR` in `ui.pages`; external links emit as
//        target="_blank" anchors styled to match NavLink.
//
//   2. No explicit menu block → returns `undefined`.  Caller falls
//      back to the hardcoded sidebar in
//      `prepareAppShellVM(aggregates, workflows, views, …)`.
//
// What this emitter covers:
// - Explicit `ui.menu` overrides emit the user's exact section
//   layout, with per-link `label:` / `order:` metadata honoured.
// - External links render as anchor tags so `link "Docs" -> "url"`
//   produces a clickable navigation entry (no React Router).
// - Per-link auth — when the underlying page has a `requires`
//   clause, the rendered link would wrap in a permission gate; this
//   awaits `useAuth` plumbing and currently emits the link
//   unconditionally.
//
// Per-page `menuMeta` is not consulted as the default sidebar driver;
// the default sidebar still flows through the hardcoded grouping in
// `prepareAppShellVM`.

import type { PageIR, UiIR } from "../../ir/types/loom-ir.js";
import { classifyPage, type PageNameCtx } from "../../ir/util/page-kind.js";
import { plural, snake } from "../../util/naming.js";
import { renderGateExpr } from "./gate-expr.js";

/** A page's declared `title:` as a plain string, usable as a default menu
 *  label (`link ProjectNew` → "New project", not "ProjectNew").  Only a
 *  string-literal title qualifies — a title that interpolates state/data refs
 *  is a render-time expression, not a static label, so those fall through to
 *  the page name. */
function pageTitleLabel(p: PageIR): string | undefined {
  const t = p.title;
  return t && t.kind === "literal" && t.lit === "string" ? t.value : undefined;
}

/** A single sidebar nav entry — framework-neutral data the React and
 *  Svelte app shells both render (React: NavLink; Svelte: <a>).
 *  Moved here from react/templating/view-models.ts with the menu
 *  emitter; the react module re-exports for its templates. */
export interface NavEntryVM {
  /** Router target path.  For external links this is the legacy
   *  `__external:<url>` sentinel (consumed by the Phoenix sidebar);
   *  React templates branch on `external`/`href` instead. */
  to: string;
  /** True when this entry links to an off-site URL (rendered as a
   *  plain `<a>`/`<Anchor>`, not a React-Router `<NavLink>`). */
  external?: boolean;
  /** The off-site URL for an `external` entry (the `to` sentinel with
   *  its `__external:` prefix stripped). */
  href?: string;
  /** Visible link text. */
  label: string;
  /** Stable testid for Playwright drivers. */
  testId: string;
  /** Argument list (verbatim) to splice into `isActive(...)` —
   *  e.g. `"/orders"` or `"/workflows", { exact: true }`.  The
   *  exact form is used for index pages whose slug prefix would
   *  otherwise match every per-item child route. */
  activeArgs: string;
  /** Rendered currentUser-only gate condition (e.g.
   *  `currentUser.role === "agent"`) when the linked page declares a
   *  `requires` clause AND the deployable is `auth: ui`.  The App-shell
   *  templates wrap this entry's nav link in `({requiresJs}) ? <link> :
   *  null` so a forbidden page's sidebar link hides at runtime — the
   *  nav-side mirror of the page guard's `<Forbidden/>`.  Absent ⇒ the
   *  link is never gated (rendered unconditionally, byte-identical to
   *  before). */
  requiresJs?: string;
}

/** A grouped sidebar section.  Sections with zero entries are
 *  omitted by the preparers so templates don't need empty-guards. */
export interface NavSectionVM {
  label: string;
  entries: NavEntryVM[];
}

/** Build sidebar `navSections` from a ui's explicit `menu { … }`
 *  block.  Returns `undefined` when the ui has no menu block — the
 *  caller falls back to the default hardcoded grouping. */
export function deriveSidebarFromUi(
  ui: UiIR,
  nameCtx: PageNameCtx,
  authUi = false,
): NavSectionVM[] | undefined {
  if (ui.menu) {
    return ui.menu.sections.map(
      (section): NavSectionVM => ({
        label: section.label,
        entries: section.links
          .map((link) => navEntryForLink(link, ui, nameCtx, authUi))
          .filter((e): e is NavEntryVM => e !== undefined),
      }),
    );
  }
  // Fallback driver: per-page `menuMeta` blocks on
  // EXPLICIT pages.  When no `ui.menu` is declared, walker-rendered
  // pages (and any other source-declared pages) with `menu {
  // section: "X" }` metadata group by section into a sidebar.
  //
  // Restricted to `custom` (hand-written) pages so scaffold-synthesised
  // pages (which carry default menuMeta from the scaffold expander)
  // don't pre-empt the default hardcoded grouping in app-shell.ts.
  // Explicit pages opt into this driver by declaring a `menu { … }`
  // block.
  const eligible = ui.pages.filter(
    (p) =>
      classifyPage(p, nameCtx).kind === "custom" && p.menuMeta && !readMenuMetaBool(p, "hidden"),
  );
  if (eligible.length === 0) return undefined;
  // Group pages by section name (default "" if no section declared).
  const bySection = new Map<string, PageIR[]>();
  for (const p of eligible) {
    const section = readMenuMetaString(p, "section") ?? "";
    let arr = bySection.get(section);
    if (!arr) {
      arr = [];
      bySection.set(section, arr);
    }
    arr.push(p);
  }
  // Per-section: order by `menuMeta.order` (numeric) when present,
  // otherwise by page declaration order.
  const sections: NavSectionVM[] = [];
  for (const [sectionLabel, pages] of bySection) {
    pages.sort((a, b) => {
      const aOrder = readMenuMetaNumber(a, "order") ?? Infinity;
      const bOrder = readMenuMetaNumber(b, "order") ?? Infinity;
      return aOrder - bOrder;
    });
    sections.push({
      label: sectionLabel,
      entries: pages.map((p): NavEntryVM => {
        const label = readMenuMetaString(p, "label") ?? pageTitleLabel(p) ?? p.name;
        const tIdAndActive = testIdAndActive(p, nameCtx);
        return {
          to: p.route ?? "",
          label,
          testId: tIdAndActive.testId,
          activeArgs: tIdAndActive.activeArgs,
          // Hide the nav link when the page's `requires` gate fails (auth: ui).
          ...(authUi && p.requires
            ? { requiresJs: renderGateExpr(p.requires, "currentUser") }
            : {}),
        };
      }),
    });
  }
  return sections;
}

function navEntryForLink(
  link: import("../../ir/types/loom-ir.js").MenuLinkIR,
  ui: UiIR,
  nameCtx: PageNameCtx,
  authUi: boolean,
): NavEntryVM | undefined {
  if (link.kind === "external") {
    // External links don't go through React Router; render as a plain
    // anchor.  `to` keeps the legacy `__external:<url>` sentinel that the
    // Phoenix sidebar slices; the React packs branch on `external`/`href`.
    return {
      to: `__external:${link.url}`,
      external: true,
      href: link.url,
      label: link.label,
      testId: `nav-ext-${slugifyLabel(link.label)}`,
      activeArgs: `""`,
    };
  }
  // `link Page { label: "...", order: N }` — page reference.  Match on the
  // resolved route first (unique) so a qualified `link Orders.List` targets the
  // exact page; role-named pages (`List`) share `pageName` across aggregates.
  // Fall back to name for unqualified links to unique pages.
  const page =
    (link.route !== undefined && ui.pages.find((p) => p.route === link.route)) ||
    ui.pages.find((p) => p.name === link.pageName);
  if (!page) return undefined;
  // Allow per-link `label:` override; otherwise fall back to the
  // page's menuMeta `label` and finally to the page name.
  const overrideLabel = stringPropOf(link.props, "label");
  const metaLabel = readMenuMetaString(page, "label");
  const label = overrideLabel ?? metaLabel ?? pageTitleLabel(page) ?? page.name;
  // Identify well-known page kinds via `classifyPage` so testid
  // and active-route semantics match main's hardcoded conventions.
  const tIdAndActive = testIdAndActive(page, nameCtx);
  return {
    to: page.route ?? "",
    label,
    testId: tIdAndActive.testId,
    activeArgs: tIdAndActive.activeArgs,
    // Per-link auth: when the deployable is `auth: ui` and the linked
    // page carries a `requires` gate, render the runtime condition so the
    // App-shell hides this link when the gate fails — the nav mirror of
    // the page guard's `<Forbidden/>`.  External links are returned above
    // and never gated.
    ...(authUi && page.requires
      ? { requiresJs: renderGateExpr(page.requires, "currentUser") }
      : {}),
  };
}

function testIdAndActive(
  page: PageIR,
  nameCtx: PageNameCtx,
): {
  testId: string;
  activeArgs: string;
} {
  const route = page.route ?? "";
  const kind = classifyPage(page, nameCtx);
  switch (kind.kind) {
    case "aggregate-list": {
      const slug = snake(plural(kind.aggregateName));
      return {
        testId: `nav-${slug}`,
        activeArgs: JSON.stringify(`/${slug}`),
      };
    }
    case "aggregate-new":
    case "aggregate-detail": {
      const slug = snake(plural(kind.aggregateName));
      return {
        testId: `nav-${slug}-${kind.kind === "aggregate-new" ? "new" : "detail"}`,
        activeArgs: JSON.stringify(route),
      };
    }
    case "workflow-form": {
      const slug = snake(kind.workflowName);
      return {
        testId: `nav-workflow-${slug}`,
        activeArgs: JSON.stringify(`/workflows/${slug}`),
      };
    }
    case "workflows-index":
      return {
        testId: "nav-workflows",
        activeArgs: `"/workflows", { exact: true }`,
      };
    case "home":
      return { testId: "nav-home", activeArgs: `"/", { exact: true }` };
    default: {
      // Explicit page (no archetype) — use the page name as
      // the testid suffix and exact-match the route.
      return {
        testId: `nav-${snake(page.name)}`,
        activeArgs: route ? JSON.stringify(route) : `""`,
      };
    }
  }
}

function readMenuMetaString(page: PageIR, key: string): string | undefined {
  const meta = page.menuMeta;
  if (!meta) return undefined;
  const entry = meta.entries.find((e) => e.name === key);
  if (!entry) return undefined;
  if (entry.value.kind !== "literal" || entry.value.lit !== "string") return undefined;
  return entry.value.value;
}

function readMenuMetaNumber(page: PageIR, key: string): number | undefined {
  const meta = page.menuMeta;
  if (!meta) return undefined;
  const entry = meta.entries.find((e) => e.name === key);
  if (!entry) return undefined;
  if (entry.value.kind !== "literal" || entry.value.lit !== "int") return undefined;
  const n = Number(entry.value.value);
  return Number.isFinite(n) ? n : undefined;
}

function readMenuMetaBool(page: PageIR, key: string): boolean | undefined {
  const meta = page.menuMeta;
  if (!meta) return undefined;
  const entry = meta.entries.find((e) => e.name === key);
  if (!entry) return undefined;
  if (entry.value.kind !== "literal" || entry.value.lit !== "bool") return undefined;
  return entry.value.value === "true";
}

function stringPropOf(
  props: { name: string; value: import("../../ir/types/loom-ir.js").ExprIR }[] | undefined,
  key: string,
): string | undefined {
  const entry = props?.find((p) => p.name === key);
  if (!entry) return undefined;
  if (entry.value.kind !== "literal" || entry.value.lit !== "string") return undefined;
  return entry.value.value;
}

function slugifyLabel(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "link"
  );
}
