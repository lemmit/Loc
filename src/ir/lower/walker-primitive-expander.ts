// Singleton index-page sentinel expander — phase ⑤c of the lowering pipeline.
//
// Pure function from `(page body with a `Home()` / `WorkflowsIndex()` /
// `ViewsIndex()` sentinel call, system context) → ExprIR` that rewrites each
// singleton index-page sentinel into the full walker-stdlib `ExprIR` it
// expands to.  Called from `lowerSystem` (see `lower.ts`, near the end of
// `lowerSystem`); downstream phases (enrichment, validate, every backend)
// never see the un-expanded sentinel.
//
// The scaffold macro emits the per-UI Home / Workflows / Views index pages
// with a bare sentinel-call body (`body: Home`); their full tree is derived
// here from the system shape (how many aggregates / workflows / views are
// reachable) rather than spelled out in the macro.  The aggregate / workflow
// / view scaffold *body* primitives (`scaffold*(of:)`) were removed — those
// pages now carry their full body tree directly from the macro's
// `_body-builders.ts` scaffolders, so there is nothing inline to expand for
// them.

import { humanize, snake } from "../../util/naming.js";
import type { AggregateIR, BoundedContextIR, ExprIR, SystemIR, UiIR } from "../types/loom-ir.js";
import { workflowEmitsCommandRoute } from "../types/loom-ir.js";

/** Inputs for the expander.  Carried as a struct so callers don't
 *  have to thread through the same handful of derived maps every
 *  call — `lowerSystem` builds these once at top-level. */
export interface WalkerExpandContext {
  ui: UiIR;
  /** Aggregate by name — pulled from every reachable bounded
   *  context across the system's modules.  Powers the Home-page
   *  aggregate count and the per-aggregate conventional emit paths. */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Owning bounded context per aggregate. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Workflow by name — powers the Home / WorkflowsIndex counts and
   *  the per-workflow conventional emit paths. */
  workflowsByName: ReadonlyMap<string, import("../types/loom-ir.js").WorkflowIR>;
  /** View by name — powers the Home / ViewsIndex counts and the
   *  per-view conventional emit paths. */
  viewsByName: ReadonlyMap<string, import("../types/loom-ir.js").ViewIR>;
}

/** Build the expander context from the system + a specific UI.
 *  Used by `lowerSystem`'s post-processing pass and by tests. */
export function buildExpandContext(sys: SystemIR, ui: UiIR): WalkerExpandContext {
  const aggregatesByName = new Map<string, AggregateIR>();
  const bcByAggregate = new Map<string, BoundedContextIR>();
  const workflowsByName = new Map<string, import("../types/loom-ir.js").WorkflowIR>();
  const viewsByName = new Map<string, import("../types/loom-ir.js").ViewIR>();
  for (const m of sys.subdomains) {
    for (const ctx of m.contexts) {
      for (const agg of ctx.aggregates) {
        aggregatesByName.set(agg.name, agg);
        bcByAggregate.set(agg.name, ctx);
      }
      for (const wf of ctx.workflows) {
        workflowsByName.set(wf.name, wf);
      }
      for (const v of ctx.views) {
        viewsByName.set(v.name, v);
      }
    }
  }
  return {
    ui,
    aggregatesByName,
    bcByAggregate,
    workflowsByName,
    viewsByName,
  };
}

/** Recursively walk a page body and rewrite the three singleton
 *  index-page sentinels — `Home()` / `WorkflowsIndex()` /
 *  `ViewsIndex()` — into their expanded `Stack(...)` trees.  Returns
 *  the rewritten ExprIR (new tree if anything changed; the input
 *  reference otherwise).  Pure, no in-place mutation — the caller
 *  assigns the result back. */
export function expandInlineScaffoldPrimitives(body: ExprIR, ctx: WalkerExpandContext): ExprIR {
  if (body.kind === "call") {
    if (body.name === "Home" && body.args.length === 0) {
      return expandScaffoldHome(ctx);
    }
    if (body.name === "WorkflowsIndex" && body.args.length === 0) {
      return expandScaffoldWorkflowsIndex(ctx);
    }
    if (body.name === "ViewsIndex" && body.args.length === 0) {
      return expandScaffoldViewsIndex(ctx);
    }
    // Recurse into args — they may themselves contain a sentinel.
    const newArgs = body.args.map((a) => expandInlineScaffoldPrimitives(a, ctx));
    const changed = newArgs.some((a, i) => a !== body.args[i]);
    return changed ? { ...body, args: newArgs } : body;
  }
  if (body.kind === "lambda") {
    if (body.body) {
      const newBody = expandInlineScaffoldPrimitives(body.body, ctx);
      return newBody === body.body ? body : { ...body, body: newBody };
    }
    return body;
  }
  if (body.kind === "member") {
    const newReceiver = expandInlineScaffoldPrimitives(body.receiver, ctx);
    return newReceiver === body.receiver ? body : { ...body, receiver: newReceiver };
  }
  if (body.kind === "method-call") {
    const newReceiver = expandInlineScaffoldPrimitives(body.receiver, ctx);
    const newArgs = body.args.map((a) => expandInlineScaffoldPrimitives(a, ctx));
    const recvChanged = newReceiver !== body.receiver;
    const argsChanged = newArgs.some((a, i) => a !== body.args[i]);
    return recvChanged || argsChanged ? { ...body, receiver: newReceiver, args: newArgs } : body;
  }
  return body;
}

// ---------------------------------------------------------------------------

/** Expand the `Home()` sentinel body into the welcome page Stack
 *  with one summary Card per reachable section (aggregates,
 *  workflows, views).  Emitted by scaffold for the singleton Home
 *  page; recognised inline by `expandInlineScaffoldPrimitives`. */
function expandScaffoldHome(ctx: WalkerExpandContext): ExprIR {
  const aggCount = ctx.aggregatesByName.size;
  // Only workflows that emit a command route get a scaffolded page (an
  // event-triggered-only workflow has no `/workflows/<wf>` route and no
  // `/workflows` index — #1029).  The home "Open workflows → /workflows" link
  // must count *those*, or it dangles to a non-existent route and fails the
  // Phoenix `~p` verified-route check under --warnings-as-errors.
  const wfCount = [...ctx.workflowsByName.values()].filter(workflowEmitsCommandRoute).length;
  const viewCount = ctx.viewsByName.size;
  const cards: ExprIR[] = [];
  if (aggCount > 0) {
    cards.push(
      call("Card", [
        call(
          "Heading",
          [lit(pluralize(aggCount, "aggregate", "aggregates"))],
          [["level", intLit(4)]],
        ),
        call("Text", [lit("Manage records of each kind from the sidebar.")]),
      ]),
    );
  }
  if (wfCount > 0) {
    cards.push(
      call("Card", [
        call("Heading", [lit(pluralize(wfCount, "workflow", "workflows"))], [["level", intLit(4)]]),
        call("Anchor", [lit("Open workflows →")], [["to", lit("/workflows")]]),
      ]),
    );
  }
  if (viewCount > 0) {
    cards.push(
      call("Card", [
        call("Heading", [lit(pluralize(viewCount, "view", "views"))], [["level", intLit(4)]]),
        call("Anchor", [lit("Open views →")], [["to", lit("/views")]]),
      ]),
    );
  }
  return call(
    "Stack",
    [
      call("Heading", [lit("Welcome")], [["level", intLit(2)]]),
      call("Text", [lit("Pick a section from the sidebar to start, or jump straight in below.")]),
      call("Stack", cards),
    ],
    [["testid", lit("home")]],
  );
}

/** Expand the `WorkflowsIndex()` sentinel body into the index page —
 *  Breadcrumbs + Heading + one Card per registered workflow. */
function expandScaffoldWorkflowsIndex(ctx: WalkerExpandContext): ExprIR {
  const cards: ExprIR[] = [];
  for (const wf of ctx.workflowsByName.values()) {
    const slug = snake(wf.name);
    cards.push(
      call(
        "Card",
        [
          call("Heading", [lit(humanize(wf.name))], [["level", intLit(4)]]),
          call(
            "Anchor",
            [lit("Run →")],
            [
              ["to", lit(`/workflows/${slug}`)],
              ["testid", lit(`workflow-${slug}-run`)],
            ],
          ),
        ],
        [["testid", lit(`workflow-card-${slug}`)]],
      ),
    );
  }
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], [["to", lit("/")]]),
        call("Text", [lit("Workflows")]),
      ]),
      call("Heading", [lit("Workflows")], [["level", intLit(2)]]),
      call("Text", [lit("System-level orchestrations.  Pick one to run.")]),
      call("Stack", cards),
    ],
    [["testid", lit("workflows-index")]],
  );
}

/** Expand the `ViewsIndex()` sentinel body — Breadcrumbs + Heading
 *  + one Card per registered view. */
function expandScaffoldViewsIndex(ctx: WalkerExpandContext): ExprIR {
  const cards: ExprIR[] = [];
  for (const view of ctx.viewsByName.values()) {
    const slug = snake(view.name);
    cards.push(
      call(
        "Card",
        [
          call("Heading", [lit(humanize(view.name))], [["level", intLit(4)]]),
          call(
            "Anchor",
            [lit("Open →")],
            [
              ["to", lit(`/views/${slug}`)],
              ["testid", lit(`view-${slug}-open`)],
            ],
          ),
        ],
        [["testid", lit(`view-card-${slug}`)]],
      ),
    );
  }
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], [["to", lit("/")]]),
        call("Text", [lit("Views")]),
      ]),
      call("Heading", [lit("Views")], [["level", intLit(2)]]),
      call("Text", [lit("Saved queries.  Open one to inspect rows.")]),
      call("Stack", cards),
    ],
    [["testid", lit("views-index")]],
  );
}

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// IR constructors
// ---------------------------------------------------------------------------

// IR construction helpers.  The walker / React emitter doesn't
// consult `callKind` / `refKind` / `receiverType` / `memberType`
// for these synthesised primitives — they're informational fields
// lowering fills with type-resolution data, which we'd otherwise
// have to recompute.  Placeholder values keep the shapes valid
// without inventing fake type info that downstream might trust.

function call(name: string, positionals: ExprIR[], named: Array<[string, ExprIR]> = []): ExprIR {
  const args: ExprIR[] = [...positionals];
  const argNames: (string | undefined)[] = positionals.map(() => undefined);
  for (const [n, v] of named) {
    args.push(v);
    argNames.push(n);
  }
  return { kind: "call", callKind: "free", name, args, argNames };
}

function lit(value: string): ExprIR {
  return { kind: "literal", lit: "string", value };
}

function intLit(value: number): ExprIR {
  return { kind: "literal", lit: "int", value: String(value) };
}
