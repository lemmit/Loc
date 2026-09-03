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
//   2. No explicit menu block → the caller's DEFAULT sections are
//      MERGED with every custom page's own `menu { … }` metadata
//      (and with the custom pages that declare none).  Returns
//      `undefined` only when that merge is empty, so a caller with
//      no default sections of its own keeps its fallback.
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
// The MERGE rule (M-FT.6 / finding C1).  A page-level `menu { … }`
// block is ADDITIVE, never a replacement: writing
// `menu { section: "Work", label: "Board" }` on one hand-written page
// used to collapse the whole sidebar to that single link, so every
// scaffolded aggregate/workflow link vanished — and omitting the block
// left the page with no link at all.  Both halves are fixed here:
// the caller passes the default sections it would otherwise have
// rendered on its own, this emitter appends the custom pages to them
// (same-labelled sections merge; a page with no `menu` block lands in
// a plain "Pages" section), and a default entry whose route a custom
// page already claims is dropped so the frontends whose default is
// "one link per routed page" (angular, phoenix) don't list it twice.

import type { PageIR, UiIR } from "../../ir/types/loom-ir.js";
import { areaQualifiedName, classifyPage, type PageNameCtx } from "../../ir/util/page-kind.js";
import { plural, snake } from "../../util/naming.js";
import { messageKey } from "../_walker/i18n-extract.js";
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
  /** The catalog key for {@link label} (M-T1.11), when the label is an AUTHORED
   *  string the extraction pass recorded — `menu.link.<hash>` for a
   *  `menu { … }` link, `page.<Page>.menu.label.<hash>` for a page's own
   *  `menu { label: … }` metadata.  Absent for an emitter-DERIVED label (the
   *  default aggregate/workflow sidebar, a page name used as a fallback): those
   *  are not in the catalog, so translating them would emit a key that resolves
   *  to nothing.  Consumed by `withNavLabelTokens` (`_frontend/nav-labels.ts`). */
  labelKey?: string;
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
  /** Catalog key for the section heading — `menu.section.<hash>` from a
   *  `menu { section "…" }` block, `page.<Page>.menu.section.<hash>` from a
   *  page's own metadata.  Same contract as {@link NavEntryVM.labelKey}. */
  labelKey?: string;
  entries: NavEntryVM[];
}

/** The section a custom page with no `menu { section: … }` of its own
 *  lands in.  Emitter-derived (no catalog key), like the default
 *  aggregate/workflow headings. */
const UNSECTIONED_LABEL = "Pages";

/** Whether a page can carry a sidebar link at all: it must have a
 *  parameterless route to navigate to, and must not have been mounted
 *  outside the app shell (`layout: none` — a login screen has no
 *  sidebar to appear in). */
function isNavigable(p: PageIR): boolean {
  const route = p.route;
  if (!route || route.includes(":")) return false;
  if (p.layout?.kind === "preset" && p.layout.name === "none") return false;
  return true;
}

/** Merge a caller's DEFAULT sidebar sections with the sections derived
 *  from the ui's own pages.  Defaults come first (an empty one is
 *  dropped rather than rendering a heading over nothing); a default
 *  entry whose route a page section already claims is dropped so the
 *  page's own label/testid wins; a page section whose label matches a
 *  default's is appended into it, and any other one is appended as a
 *  new section. */
export function mergeNavSections(
  defaults: readonly NavSectionVM[],
  pageSections: readonly NavSectionVM[],
): NavSectionVM[] {
  const claimed = new Set(pageSections.flatMap((s) => s.entries.map((e) => e.to)));
  const out: NavSectionVM[] = [];
  for (const section of defaults) {
    const entries = section.entries.filter((e) => !claimed.has(e.to));
    if (entries.length === 0) continue;
    out.push({ ...section, entries });
  }
  for (const section of pageSections) {
    const sameLabel = out.find((s) => s.label === section.label);
    if (sameLabel) sameLabel.entries = [...sameLabel.entries, ...section.entries];
    else out.push({ ...section });
  }
  return out;
}

/** Build sidebar `navSections` for a ui.  An explicit `menu { … }`
 *  block is the author's exact layout and REPLACES the caller's
 *  defaults; with no such block the ui's own pages are merged INTO
 *  `defaultSections` (see the merge rule at the top of this file).
 *  Returns `undefined` when nothing at all is derivable — the caller
 *  then keeps whatever fallback it has. */
export function deriveSidebarFromUi(
  ui: UiIR,
  nameCtx: PageNameCtx,
  authUi = false,
  /** The sections the caller would render on its own (the scaffolded
   *  Aggregates/Workflows grouping on react/vue/svelte, one link per
   *  routed page on angular/phoenix).  Omitted ⇒ page-derived sections
   *  only. */
  defaultSections: readonly NavSectionVM[] = [],
): NavSectionVM[] | undefined {
  if (ui.menu) {
    return ui.menu.sections.map(
      (section): NavSectionVM => ({
        label: section.label,
        // Keyed exactly as `collectUiMessages` records it, so the shell's
        // `t()` call and the catalog entry cannot drift (A13b).
        ...(section.label ? { labelKey: messageKey("menu", "section", section.label) } : {}),
        entries: section.links
          .map((link) => navEntryForLink(link, ui, nameCtx, authUi))
          .filter((e): e is NavEntryVM => e !== undefined),
      }),
    );
  }
  // No `ui.menu` block: the sidebar is the caller's defaults PLUS the
  // ui's own custom (hand-written) pages.  Scaffold-synthesised pages
  // are excluded here because the caller's default sections already
  // represent them — including them again would double every link.
  //
  // A custom page opts into a named section with `menu { section: "X" }`;
  // one with no `menu` block at all still gets a link (in the
  // `UNSECTIONED_LABEL` section) as long as it is navigable, so a
  // hand-written page is never unreachable from the shell.
  const eligible = ui.pages.filter((p) => {
    if (classifyPage(p, nameCtx).kind !== "custom") return false;
    if (readMenuMetaBool(p, "hidden")) return false;
    return p.menuMeta ? true : isNavigable(p);
  });
  if (eligible.length === 0) {
    const defaultsOnly = mergeNavSections(defaultSections, []);
    return defaultsOnly.length > 0 ? defaultsOnly : undefined;
  }
  // Group pages by section name (the unsectioned bucket if none declared).
  const bySection = new Map<string, PageIR[]>();
  for (const p of eligible) {
    const section = readMenuMetaString(p, "section") ?? UNSECTIONED_LABEL;
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
    // The unsectioned bucket's heading is emitter-DERIVED, so — like the
    // default aggregate/workflow headings — it carries no catalog key: no
    // translator ever saw it, and a key that resolves to nothing renders blank.
    const authoredSection = sectionLabel !== UNSECTIONED_LABEL;
    sections.push({
      label: sectionLabel,
      // The heading is one page's `menu { section: … }` metadata, extracted
      // under THAT page's prefix — every page in the group carries the same
      // message, so the first one's key is as good as any (A13b).
      ...(authoredSection && sectionLabel && pages[0]
        ? { labelKey: messageKey(`page.${pages[0].name}`, "menu.section", sectionLabel) }
        : {}),
      entries: pages.map((p): NavEntryVM => {
        const metaLabel = readMenuMetaString(p, "label");
        const label = metaLabel ?? pageTitleLabel(p) ?? p.name;
        const tIdAndActive = testIdAndActive(p, nameCtx);
        return {
          to: p.route ?? "",
          label,
          ...(metaLabel !== undefined
            ? { labelKey: messageKey(`page.${p.name}`, "menu.label", metaLabel) }
            : {}),
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
  const merged = mergeNavSections(defaultSections, sections);
  return merged.length > 0 ? merged : undefined;
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
      labelKey: messageKey("menu", "link", link.label),
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
  // Only the two AUTHORED spellings are in the catalog: the link's own `label:`
  // (extracted under the `menu` prefix) and the page's `menu { label: … }`
  // metadata (extracted under the page's prefix).  A page title / page name
  // fallback is not extracted, so it carries no key and stays untranslated
  // rather than emitting a key that resolves to nothing.
  const labelKey =
    overrideLabel !== undefined
      ? messageKey("menu", "link", overrideLabel)
      : metaLabel !== undefined
        ? messageKey(`page.${page.name}`, "menu.label", metaLabel)
        : undefined;
  // Identify well-known page kinds via `classifyPage` so testid
  // and active-route semantics match main's hardcoded conventions.
  const tIdAndActive = testIdAndActive(page, nameCtx);
  return {
    to: page.route ?? "",
    label,
    ...(labelKey ? { labelKey } : {}),
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
      // Explicit page (no archetype) — use the page's AREA-QUALIFIED name as
      // the testid suffix and exact-match the route.  The bare name is unique
      // only within one area, so two `page Dashboard` blocks in sibling areas
      // both produced `nav-dashboard` and every page object / e2e locator
      // built on it matched two links (Playwright strict mode: ambiguous).
      return {
        testId: `nav-${snake(areaQualifiedName(page))}`,
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
