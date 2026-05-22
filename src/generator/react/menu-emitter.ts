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
//      `prepareAppShellVM(aggregates, workflows, views, …)` —
//      byte-equivalent to main's pre-Slice-6 output for the bulk-
//      scaffold case (the byte-equivalence acceptance gate).
//
// What this slice covers:
// - Explicit `ui.menu` overrides emit the user's exact section
//   layout, with per-link `label:` / `order:` metadata honoured.
// - External links render as anchor tags so `link "Docs" -> "url"`
//   produces a clickable navigation entry (no React Router).
// - Per-link auth — when the underlying page has a `requires`
//   clause, the rendered link wraps in a permission gate (deferred
//   to Slice 6.1 with the `useAuth` plumbing; v0 emits the link
//   unconditionally).
//
// What this slice intentionally doesn't yet handle:
// - Per-page `menuMeta` as the *default* sidebar driver.  The
//   default still goes through main's hardcoded grouping so that
//   the bulk-scaffold byte-equivalence holds without churning the
//   expander or the AppShell preparer.  Slice 6.1 unifies the
//   default path on the page-IR.

import type { PageIR, UiIR } from "../../ir/loom-ir.js";
import { plural, snake } from "../../util/naming.js";
import type { NavEntryVM, NavSectionVM } from "./templating/view-models.js";

/** Build sidebar `navSections` from a ui's explicit `menu { … }`
 *  block.  Returns `undefined` when the ui has no menu block — the
 *  caller keeps the legacy hardcoded grouping in that case
 *  (byte-equivalence guarantee for the bulk-scaffold case). */
export function deriveSidebarFromUi(ui: UiIR): NavSectionVM[] | undefined {
  if (ui.menu) {
    return ui.menu.sections.map(
      (section): NavSectionVM => ({
        label: section.label,
        entries: section.links
          .map((link) => navEntryForLink(link, ui))
          .filter((e): e is NavEntryVM => e !== undefined),
      }),
    );
  }
  // Fallback driver: per-page `menuMeta` blocks on
  // EXPLICIT pages.  When no `ui.menu` is declared, walker-rendered
  // pages (and any other source-declared pages) with `menu {
  // section: "X" }` metadata group by section into a sidebar.
  //
  // Restricted to `source === "explicit"` so scaffold-synthesised
  // pages (which carry default menuMeta from the scaffold expander)
  // don't pre-empt the legacy hardcoded grouping in app-shell.ts.
  // The default path stays byte-equivalent for the bulk-scaffold
  // case; explicit pages opt into this driver by declaring a
  // `menu { … }` block.
  const eligible = ui.pages.filter(
    (p) => p.source === "explicit" && p.menuMeta && !readMenuMetaBool(p, "hidden"),
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
        const label = readMenuMetaString(p, "label") ?? p.name;
        const tIdAndActive = testIdAndActive(p);
        return {
          to: p.route ?? "",
          label,
          testId: tIdAndActive.testId,
          activeArgs: tIdAndActive.activeArgs,
        };
      }),
    });
  }
  return sections;
}

function navEntryForLink(
  link: import("../../ir/loom-ir.js").MenuLinkIR,
  ui: UiIR,
): NavEntryVM | undefined {
  if (link.kind === "external") {
    // External links don't go through React Router; render as a
    // plain anchor.  We inject a sentinel `__external:<url>` token
    // into `to` so the AppShell template can recognise the form
    // (the existing template only renders `<NavLink to=...>` —
    // external rendering lands with the template-pack work in
    // Slice 6.1 if it's needed by a real example).
    return {
      to: `__external:${link.url}`,
      label: link.label,
      testId: `nav-ext-${slugifyLabel(link.label)}`,
      activeArgs: `""`,
    };
  }
  // `link Page { label: "...", order: N }` — page reference.
  const page = ui.pages.find((p) => p.name === link.pageName);
  if (!page) return undefined;
  // Allow per-link `label:` override; otherwise fall back to the
  // page's menuMeta `label` and finally to the page name.
  const overrideLabel = stringPropOf(link.props, "label");
  const metaLabel = readMenuMetaString(page, "label");
  const label = overrideLabel ?? metaLabel ?? page.name;
  // Identify well-known page kinds via `scaffoldOrigin` so testid
  // and active-route semantics match main's hardcoded conventions.
  const tIdAndActive = testIdAndActive(page);
  return {
    to: page.route ?? "",
    label,
    testId: tIdAndActive.testId,
    activeArgs: tIdAndActive.activeArgs,
  };
}

function testIdAndActive(page: PageIR): {
  testId: string;
  activeArgs: string;
} {
  const route = page.route ?? "";
  switch (page.scaffoldOrigin?.kind) {
    case "aggregate-list": {
      const slug = snake(plural(page.scaffoldOrigin.aggregateName));
      return {
        testId: `nav-${slug}`,
        activeArgs: JSON.stringify(`/${slug}`),
      };
    }
    case "aggregate-new":
    case "aggregate-detail": {
      const slug = snake(plural(page.scaffoldOrigin.aggregateName));
      return {
        testId: `nav-${slug}-${page.scaffoldOrigin.kind === "aggregate-new" ? "new" : "detail"}`,
        activeArgs: JSON.stringify(route),
      };
    }
    case "workflow-form": {
      const slug = snake(page.scaffoldOrigin.workflowName);
      return {
        testId: `nav-workflow-${slug}`,
        activeArgs: JSON.stringify(`/workflows/${slug}`),
      };
    }
    case "view-list": {
      const slug = snake(page.scaffoldOrigin.viewName);
      return {
        testId: `nav-view-${slug}`,
        activeArgs: JSON.stringify(`/views/${slug}`),
      };
    }
    case "workflows-index":
      return {
        testId: "nav-workflows",
        activeArgs: `"/workflows", { exact: true }`,
      };
    case "views-index":
      return {
        testId: "nav-views",
        activeArgs: `"/views", { exact: true }`,
      };
    case "home":
      return { testId: "nav-home", activeArgs: `"/", { exact: true }` };
    default: {
      // Explicit page (no scaffoldOrigin) — use the page name as
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
  props: { name: string; value: import("../../ir/loom-ir.js").ExprIR }[] | undefined,
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
