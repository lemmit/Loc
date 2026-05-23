import {
  aggregatesIn,
  boolLit,
  callExpr,
  defineMacro,
  nameRefExpr,
  page,
  stringLit,
  viewsIn,
  workflowsIn,
} from "../macro-api/index.js";
import type {
  Aggregate,
  Page,
  UiMember,
  View,
  Workflow,
} from "../macro-api/index.js";

/** Mass-page synthesis: take a list of aggregates, workflows,
 * views, or whole modules, and produce default list/detail/new
 * pages + index pages for each.  This is the macro-system
 * replacement for the legacy `scaffold <selector>: <names>`
 * directive (`src/language/ddd-scaffold-ast-expander.ts`); see the
 * macro plan for the migration story.
 *
 * The output mirrors the legacy expander byte-for-byte where
 * possible — same page names, same routes, same body shape, same
 * menu metadata — so existing examples can be ported without
 * changing the generated React output.  The one structural change
 * is the call form: `scaffold aggregates: Order, Customer` becomes
 * `with scaffold(aggregates: [Order, Customer])` on the ui block.
 *
 * Composition with explicit pages: the expander's spliceMembers
 * applies override-by-name globally — if the user declared
 * `page OrderList { ... }` directly on the ui, the scaffold-emitted
 * `OrderList` is silently skipped.  Same behavior as the legacy
 * expander; tests in test/macro/scaffold-equivalence.test.ts
 * verify it.
 *
 * Shared pages (Home / WorkflowsIndex / ViewsIndex) are emitted
 * unconditionally for now.  The legacy expander gated them on
 * "did any directive in this ui cover the corresponding category"
 * — that conditional logic doesn't fit the macro shape without
 * adding inter-call coordination.  Override-by-name still lets
 * the user write `page Home { ... }` to replace the default. */
export default defineMacro({
  name: "scaffold",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises default List/Detail/New pages for the listed aggregates, " +
    "form pages for workflows, and list pages for views.  Replaces the " +
    "legacy `scaffold` keyword directive (deleted in the Phase 4 macro " +
    "migration).",
  params: {
    aggregates: { kind: "refList", of: "Aggregate" },
    workflows: { kind: "refList", of: "Workflow" },
    views: { kind: "refList", of: "View" },
    modules: { kind: "refList", of: "Module" },
  },
  expand({ args }) {
    const out: UiMember[] = [];

    // Direct aggregates / workflows / views.
    for (const a of args.aggregates as readonly Aggregate[]) {
      out.push(...pagesForAggregate(a));
    }
    for (const w of args.workflows as readonly Workflow[]) {
      out.push(pageForWorkflow(w));
    }
    for (const v of args.views as readonly View[]) {
      out.push(pageForView(v));
    }

    // Module fanout — for each named module, walk its aggregates,
    // workflows, views and emit pages for each.
    type Mod = import("../macro-api/index.js").Module;
    for (const mod of args.modules as readonly Mod[]) {
      for (const a of aggregatesIn(mod)) out.push(...pagesForAggregate(a));
      for (const w of workflowsIn(mod)) out.push(pageForWorkflow(w));
      for (const v of viewsIn(mod)) out.push(pageForView(v));
    }

    // Shared index pages.  Always emitted; override-by-name lets
    // users replace them with custom variants.
    if (out.length > 0) {
      out.push(homePage());
    }
    if ((args.workflows as readonly Workflow[]).length > 0 || hasAnyWorkflow(args.modules as readonly Mod[])) {
      out.push(workflowsIndexPage());
    }
    if ((args.views as readonly View[]).length > 0 || hasAnyView(args.modules as readonly Mod[])) {
      out.push(viewsIndexPage());
    }

    return out;
  },
});

// ---------------------------------------------------------------------------
// Per-archetype page synthesis.  Mirrors
// `ddd-scaffold-ast-expander.ts:expandAggregate/synthesise*Page` —
// same names, routes, body shapes, menu metadata.  Keep these
// helpers structurally identical to the legacy code so the
// equivalence test stays byte-accurate.
// ---------------------------------------------------------------------------

function pagesForAggregate(agg: Aggregate): Page[] {
  const pluralSnake = snake(plural(agg.name));
  const aggName = agg.name;
  const labelPlural = humanize(plural(aggName));
  return [
    page({
      name: `${aggName}List`,
      route: `/${pluralSnake}`,
      body: callExpr("List", [{ name: "of", value: nameRefExpr(aggName) }]),
      menu: {
        section: stringLit("Aggregates"),
        label: stringLit(labelPlural),
      },
    }),
    page({
      name: `${aggName}New`,
      route: `/${pluralSnake}/new`,
      body: callExpr("Form", [{ name: "creates", value: nameRefExpr(aggName) }]),
      menu: { hidden: boolLit(true) },
    }),
    page({
      name: `${aggName}Detail`,
      route: `/${pluralSnake}/:id`,
      body: callExpr("Detail", [
        { name: "of", value: nameRefExpr(aggName) },
        { name: "by", value: nameRefExpr("id") },
      ]),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

function pageForWorkflow(wf: Workflow): Page {
  return page({
    name: `${pascal(wf.name)}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    body: callExpr("Form", [{ name: "runs", value: nameRefExpr(wf.name) }]),
    menu: {
      section: stringLit("Workflows"),
      label: stringLit(humanize(wf.name)),
    },
  });
}

function pageForView(v: View): Page {
  return page({
    name: `${v.name}View`,
    route: `/views/${snake(v.name)}`,
    // Body uses Loom's `view <Name>` reference form — see the
    // legacy expander's comment.  The literal name is passed as
    // a single name-ref token to preserve the parse shape.
    body: callExpr("List", [{ name: "of", value: nameRefExpr(`view ${v.name}`) }]),
    menu: {
      section: stringLit("Views"),
      label: stringLit(humanize(v.name)),
    },
  });
}

function homePage(): Page {
  return page({
    name: "Home",
    route: "/",
    body: callExpr("Home", []),
    menu: { hidden: boolLit(true) },
  });
}

function workflowsIndexPage(): Page {
  return page({
    name: "WorkflowsIndex",
    route: "/workflows",
    body: callExpr("WorkflowsIndex", []),
    menu: {
      section: stringLit("Workflows"),
      label: stringLit("Index"),
    },
  });
}

function viewsIndexPage(): Page {
  return page({
    name: "ViewsIndex",
    route: "/views",
    body: callExpr("ViewsIndex", []),
    menu: {
      section: stringLit("Views"),
      label: stringLit("Index"),
    },
  });
}

function hasAnyWorkflow(modules: readonly import("../macro-api/index.js").Module[]): boolean {
  return modules.some((m) => workflowsIn(m).length > 0);
}
function hasAnyView(modules: readonly import("../macro-api/index.js").Module[]): boolean {
  return modules.some((m) => viewsIn(m).length > 0);
}

// ---------------------------------------------------------------------------
// Naming utilities — duplicated from the legacy expander to keep
// scaffold output byte-identical.  Once a macro-side casing helper
// surface stabilises (see `src/util/naming.ts`), these inline
// copies will be replaced with imports.
// ---------------------------------------------------------------------------

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function plural(s: string): string {
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  if (s.endsWith("s")) return s + "es";
  return s + "s";
}

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function humanize(s: string): string {
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
