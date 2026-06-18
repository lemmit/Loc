// Shared page-generation helpers for the scaffold macro family.
//
// Each `scaffold<X>` macro (scaffoldAggregate / scaffoldWorkflow /
// scaffoldView / scaffold) reaches into these to emit canonical page
// shapes.  Keeping them in one place means the per-archetype leaf
// macros and the top-level composer share one source of truth.

import type { Aggregate, Area, Page, View, Workflow } from "../../api/index.js";
import { area, boolLit, callExpr, nameRefExpr, page, stringLit } from "../../api/index.js";

/** Group an aggregate's List/New/Detail pages under a per-aggregate `area`
 *  named after its plural (`area Orders { … }` → `src/pages/orders/…`).  The
 *  scaffold returns this instead of loose pages so the generated page tree
 *  groups by aggregate.  In slice 2 `origin` still drives `emitPath` (output
 *  byte-identical); slice 3 makes the area authoritative.  See
 *  docs/proposals/unfoldable-page-scaffolding.md. */
export function areaForAggregate(agg: Aggregate): Area {
  return area(plural(agg.name), pagesForAggregate(agg));
}

export function pagesForAggregate(agg: Aggregate): Page[] {
  const pluralSnake = snake(plural(agg.name));
  const aggName = agg.name;
  const labelPlural = humanize(plural(aggName));
  return [
    page({
      name: `${aggName}List`,
      route: `/${pluralSnake}`,
      // Canonical body primitive — expands inline to the full
      // Breadcrumbs/Toolbar/QueryView/Table tree via
      // `expandInlineScaffoldPrimitives`.
      body: callExpr("scaffoldList", [{ name: "of", value: nameRefExpr(aggName) }]),
      menu: {
        section: stringLit("Aggregates"),
        label: stringLit(labelPlural),
      },
    }),
    page({
      name: `${aggName}New`,
      route: `/${pluralSnake}/new`,
      // Canonical body primitive — expands to Stack(Breadcrumbs,
      // Heading, Card(CreateForm(of:))).
      body: callExpr("scaffoldNewForm", [{ name: "of", value: nameRefExpr(aggName) }]),
      menu: { hidden: boolLit(true) },
    }),
    page({
      name: `${aggName}Detail`,
      route: `/${pluralSnake}/:id`,
      // Explicit Stack of two body primitives — see
      // `expandInlineScaffoldPrimitives` in
      // src/ir/lower/walker-primitive-expander.ts.
      //
      //   * scaffoldDetails(of: <Agg>)    — full read view
      //     (Breadcrumbs, Heading, QueryView wrapping the field
      //     card + related-entity cards).  Customisable: replacing
      //     this slot with custom JSX doesn't disturb operations.
      //   * scaffoldOperations(of: <Agg>) — Group(Modal × N), one
      //     per public operation.  Auto-fans at lowering time, so
      //     adding `operation reactivate()` to the aggregate makes
      //     its modal appear without touching this page.
      body: callExpr("Stack", [
        {
          value: callExpr("scaffoldDetails", [{ name: "of", value: nameRefExpr(aggName) }]),
        },
        {
          value: callExpr("scaffoldOperations", [{ name: "of", value: nameRefExpr(aggName) }]),
        },
        // testid on the outer Stack — the e2e page-objects anchor
        // on `<plural>-detail`.
        { name: "testid", value: stringLit(`${pluralSnake}-detail`) },
      ]),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

/** An event-triggered-only workflow (every `create` carries a `by`
 *  correlation clause — a reactor / saga started by an event, never an
 *  inbound call) has no command surface: the backends emit no `run/2` /
 *  HTTP route for it (see `workflowEmitsCommandRoute`), so the scaffold
 *  must not synthesise a form page (it would `phx-submit` / POST to a
 *  route that doesn't exist).  AST mirror of the lowered predicate: the
 *  facade create is the unnamed command create, else the first create;
 *  event-triggered iff that facade has a `by` clause. */
export function workflowIsEventTriggeredOnly(wf: Workflow): boolean {
  const creates = wf.members.filter(
    (m): m is Extract<Workflow["members"][number], { $type: "WorkflowCreateDecl" }> =>
      m.$type === "WorkflowCreateDecl",
  );
  if (creates.length === 0) return false;
  const facade = creates.find((c) => !c.name && !c.correlation) ?? creates[0]!;
  return !!facade.correlation;
}

/** Whether a workflow persists an observable instance row
 *  (workflow-instance-visibility.md).  AST mirror of the IR rule
 *  (`lower-workflow.ts`): a single id-shaped `Property` state field is the
 *  correlation field, and only a correlation-bearing, non-event-sourced
 *  workflow has a state table to list.  Two id fields (ambiguous) or zero
 *  (no correlation) ⇒ no instance surface, matching the IR's
 *  `instanceWireShape` gate, so the scaffolded pages never reference hooks
 *  that weren't emitted. */
export function workflowIsObservable(wf: Workflow): boolean {
  if (wf.eventSourced) return false;
  const props = wf.members.filter(
    (m): m is Extract<Workflow["members"][number], { $type: "Property" }> => m.$type === "Property",
  );
  const idProps = props.filter((p) => p.type.base.$type === "IdType" && !p.type.array);
  return idProps.length === 1;
}

/** The two read-only instance pages for an observable workflow: a list of
 *  running instances and a per-instance detail (no `New` analogue — instances
 *  are born from triggers, not a form).  Mirrors `pagesForAggregate`'s
 *  List/Detail; the bodies expand inline via the `scaffoldInstance*`
 *  sentinels in `walker-primitive-expander.ts`. */
export function pagesForWorkflowInstances(wf: Workflow): Page[] {
  const slug = snake(wf.name);
  const wfName = wf.name;
  return [
    page({
      name: `${pascal(wfName)}InstancesList`,
      route: `/workflows/${slug}/instances`,
      body: callExpr("scaffoldInstanceList", [{ name: "of", value: nameRefExpr(wfName) }]),
      menu: {
        section: stringLit("Workflows"),
        label: stringLit(`${humanize(wfName)} Instances`),
      },
    }),
    page({
      name: `${pascal(wfName)}InstanceDetail`,
      route: `/workflows/${slug}/instances/:id`,
      body: callExpr("scaffoldInstanceDetails", [{ name: "of", value: nameRefExpr(wfName) }]),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

export function pageForWorkflow(wf: Workflow): Page {
  return page({
    name: `${pascal(wf.name)}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    // Canonical body primitive — expands to Stack(Breadcrumbs,
    // Heading, Card(WorkflowForm(runs:))).
    body: callExpr("scaffoldWorkflowForm", [{ name: "runs", value: nameRefExpr(wf.name) }]),
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
    // Canonical body primitive — expands to Heading + QueryView
    // wrapping a Paper-framed Table over the view's projected rows.
    body: callExpr("scaffoldViewList", [{ name: "of", value: nameRefExpr(v.name) }]),
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

// Naming utilities — kept module-local so the helpers don't pull in
// the wider `util/naming` dep graph.

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
