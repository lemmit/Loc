// Shared page-generation helpers for the scaffold macro family.
//
// Each `scaffold<X>` macro (scaffoldAggregate / scaffoldWorkflow /
// scaffoldView / scaffold) reaches into these to emit the same page
// shapes the legacy `scaffold` keyword expander produced.  Keeping
// them in one place means the per-archetype leaf macros and the
// top-level composer all stay byte-equivalent.

import type { Aggregate, Page, View, Workflow } from "../macro-api/index.js";
import { boolLit, callExpr, nameRefExpr, page, stringLit } from "../macro-api/index.js";

export function pagesForAggregate(agg: Aggregate): Page[] {
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

export function pageForWorkflow(wf: Workflow): Page {
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

export function pageForView(v: View): Page {
  return page({
    name: `${v.name}View`,
    route: `/views/${snake(v.name)}`,
    // Body uses Loom's `view <Name>` reference form — see the
    // legacy expander's comment.  The literal name is passed as a
    // single name-ref token to preserve the parse shape.
    body: callExpr("List", [{ name: "of", value: nameRefExpr(`view ${v.name}`) }]),
    menu: {
      section: stringLit("Views"),
      label: stringLit(humanize(v.name)),
    },
  });
}

export function homePage(): Page {
  return page({
    name: "Home",
    route: "/",
    body: callExpr("Home", []),
    menu: { hidden: boolLit(true) },
  });
}

export function workflowsIndexPage(): Page {
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

export function viewsIndexPage(): Page {
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

// Naming utilities — duplicated from the legacy expander so scaffold
// output stays byte-identical with the legacy code path's tests.

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
