// Scaffold expander (dark-launched behind env flag).
//
// Pure function from `(PageArchetypeIR, system context) → ExprIR`
// that synthesises a walker-stdlib body equivalent to what the
// scaffold archetype renderer would emit.  When
// `LOOM_SCAFFOLD_EXPAND=1` is set, `lowerSystem` post-processes
// every page whose `archetype` is recognised, replacing the
// page's `body: List(of: …)` (or similar) with the expanded form.
// The React emitter then routes through the walker instead of through
// the legacy archetype path.
//
// This pass is purely additive — with the flag off, baseline fixtures
// are unchanged.
//
// What's covered today:
//   - `aggregate-list`     → Stack + Breadcrumbs + Toolbar + QueryView
//                            + Paper + Table (matching acme-order-
//                            explicit.ddd's OrderList shape)
//   - `aggregate-new`      → Stack + Breadcrumbs + Heading + Card +
//                            Form(of:) (matching OrderNew shape)
//   - all other origin kinds return `null` so the legacy path
//     stays in use.
//
// Spillover:
//   - `aggregate-detail`   — needs operations / modals / KeyValueRow
//   - `workflow-form`      — needs workflow IR introspection
//   - `view-list`          — needs view IR introspection
//   - `home` / index pages — needs domain navigation primitives

import { humanize, plural, snake } from "../util/naming.js";
import type { AggregateIR, BoundedContextIR, ExprIR, SystemIR, UiIR } from "./loom-ir.js";

/** Inputs for the expander.  Carried as a struct so callers don't
 *  have to thread through the same handful of derived maps every
 *  call — `lowerSystem` builds these once at top-level. */
export interface WalkerExpandContext {
  ui: UiIR;
  /** Aggregate by name — pulled from every reachable bounded
   *  context across the system's modules.  Lets the expander look
   *  up an aggregate's field list (for column emission) and its
   *  display-marked field (for IdLink resolution). */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Owning bounded context per aggregate.  Used by the
   *  `Form(of:)` field-type dispatch (enums / value-objects live
   *  in the BC, not on the aggregate). */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Workflow by name.  Powers `workflow-form`
   *  expander coverage (`Form(runs: <wf>)` field dispatch). */
  workflowsByName: ReadonlyMap<string, import("./loom-ir.js").WorkflowIR>;
  /** View by name + per-view shape lookup. */
  viewsByName: ReadonlyMap<string, import("./loom-ir.js").ViewIR>;
}

/** Build the expander context from the system + a specific UI.
 *  Used by `lowerSystem`'s post-processing pass and by tests. */
export function buildExpandContext(sys: SystemIR, ui: UiIR): WalkerExpandContext {
  const aggregatesByName = new Map<string, AggregateIR>();
  const bcByAggregate = new Map<string, BoundedContextIR>();
  const workflowsByName = new Map<string, import("./loom-ir.js").WorkflowIR>();
  const viewsByName = new Map<string, import("./loom-ir.js").ViewIR>();
  for (const m of sys.modules) {
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

/** Recursively walk a page body and rewrite the two scaffold-family
 * inline body primitives into their expanded forms:
 *
 *   `scaffoldDetails(of: <Agg>)`    → Stack(Breadcrumbs, Heading,
 *                                     QueryView(of: api.X.byId(id),
 *                                       data: data => Card+related))
 *   `scaffoldOperations(of: <Agg>)` → Group(Modal × N)
 *
 * `scaffoldDetails` is self-contained — the QueryView wrapper is
 * inside, so the loading/error/empty lifecycle stays with the read
 * side.  `scaffoldOperations` lives at top level (sibling, no
 * `data` binding); each modal's Form uses the new
 * `Form(of: <Agg>, op: <name>)` shape which resolves the aggregate
 * id from the route — no loaded record required.
 *
 * Returns the rewritten ExprIR (new tree if anything changed; the
 * input reference otherwise).  Pure, no in-place mutation — the
 * caller assigns the result back. */
export function expandInlineScaffoldPrimitives(body: ExprIR, ctx: WalkerExpandContext): ExprIR {
  if (body.kind === "call") {
    // Aggregate-keyed scaffold primitives (single `of:` arg, ref to an aggregate).
    if (
      body.name === "scaffoldDetails" ||
      body.name === "scaffoldOperations" ||
      body.name === "scaffoldList" ||
      body.name === "scaffoldNewForm"
    ) {
      const argNames = body.argNames ?? [];
      const ofIdx = argNames.indexOf("of");
      const ofArg = ofIdx >= 0 ? body.args[ofIdx] : undefined;
      const aggRef = ofArg && ofArg.kind === "ref" ? ofArg.name : undefined;
      const agg = aggRef ? ctx.aggregatesByName.get(aggRef) : undefined;
      if (!agg) return body;
      if (body.name === "scaffoldDetails") return expandScaffoldDetails(agg, ctx);
      if (body.name === "scaffoldOperations") return expandScaffoldOperations(agg);
      if (body.name === "scaffoldList") return expandScaffoldList(agg, ctx);
      return expandScaffoldNewForm(agg);
    }
    // Workflow-keyed scaffold primitive (`runs:` arg, ref to a workflow).
    if (body.name === "scaffoldWorkflowForm") {
      const argNames = body.argNames ?? [];
      const runsIdx = argNames.indexOf("runs");
      const runsArg = runsIdx >= 0 ? body.args[runsIdx] : undefined;
      const wfRef = runsArg && runsArg.kind === "ref" ? runsArg.name : undefined;
      const wf = wfRef ? ctx.workflowsByName.get(wfRef) : undefined;
      if (!wf) return body;
      return expandScaffoldWorkflowForm(wf);
    }
    // View-keyed scaffold primitive (`of:` arg, ref to a view).
    if (body.name === "scaffoldViewList") {
      const argNames = body.argNames ?? [];
      const ofIdx = argNames.indexOf("of");
      const ofArg = ofIdx >= 0 ? body.args[ofIdx] : undefined;
      const viewRef = ofArg && ofArg.kind === "ref" ? ofArg.name : undefined;
      const view = viewRef ? ctx.viewsByName.get(viewRef) : undefined;
      if (!view) return body;
      return expandScaffoldViewList(view, ctx);
    }
    // Singleton sentinel bodies — Home / WorkflowsIndex / ViewsIndex.
    // Emitted by scaffold for the per-UI index pages; expand inline
    // to the same Stack/Card trees the archetype path used to
    // produce.
    if (body.name === "Home" && body.args.length === 0) {
      return expandScaffoldHome(ctx);
    }
    if (body.name === "WorkflowsIndex" && body.args.length === 0) {
      return expandScaffoldWorkflowsIndex(ctx);
    }
    if (body.name === "ViewsIndex" && body.args.length === 0) {
      return expandScaffoldViewsIndex(ctx);
    }
    // Recurse into args — they may themselves contain the primitives.
    // Flatten Stack-returning scaffold expansions when their parent
    // is itself a Stack (the only place scaffoldDetails currently
    // lives).  Avoids `<Stack><Stack>…</Stack>…</Stack>` nesting
    // around the read view: the inner Stack's children become
    // direct siblings of scaffoldOperations.
    //
    // Stays in lockstep with `argNames`: every push to `newArgs`
    // pushes a matching slot to `newArgNames` so the named-arg
    // resolver (e.g. `testid:` on the parent Stack) keeps its
    // index alignment after the splice.
    const flattenIntoParent = body.name === "Stack";
    const oldArgNames = body.argNames ?? [];
    const newArgs: ExprIR[] = [];
    const newArgNames: (string | undefined)[] = [];
    let changed = false;
    body.args.forEach((arg, i) => {
      const expanded = expandInlineScaffoldPrimitives(arg, ctx);
      if (expanded !== arg) changed = true;
      const isScaffoldCall =
        arg.kind === "call" &&
        (arg.name === "scaffoldDetails" || arg.name === "scaffoldOperations");
      if (
        flattenIntoParent &&
        isScaffoldCall &&
        expanded.kind === "call" &&
        expanded.name === "Stack" &&
        (expanded.argNames ?? []).every((n) => !n)
      ) {
        for (const inner of expanded.args) {
          newArgs.push(inner);
          newArgNames.push(undefined);
        }
        changed = true;
      } else {
        newArgs.push(expanded);
        newArgNames.push(oldArgNames[i]);
      }
    });
    if (!changed) return body;
    const hasNamed = newArgNames.some((n) => n !== undefined);
    return hasNamed
      ? { ...body, args: newArgs, argNames: newArgNames }
      : { ...body, args: newArgs };
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

// ---------------------------------------------------------------------------

/** Expand `scaffoldDetails(of: <Agg>)`: the full read-side detail
 * section — Breadcrumbs, Heading, QueryView wrapping the field
 * Card and related-entity Cards.  Self-contained (the QueryView is
 * inside) so the loading/error/empty lifecycle stays here; the
 * sibling `scaffoldOperations(of: <Agg>)` doesn't need the loaded
 * record. */
function expandScaffoldDetails(agg: AggregateIR, ctx: WalkerExpandContext): ExprIR {
  const apiHandle = findApiHandleFor(agg, ctx);
  const queryRoot = apiHandle ? member(ref(apiHandle), agg.name) : ref(agg.name);
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanAgg = humanize(agg.name);
  const cellVar = "data";
  const { card, related } = buildDataCardParts(agg, ctx, cellVar);
  const dataBody = related.length === 0 ? card : call("Stack", [card, ...related]);
  return call("Stack", [
    call("Breadcrumbs", [
      call("Anchor", [lit("Home")], [["to", lit("/")]]),
      call("Anchor", [lit(humanPlural)], [["to", lit(`/${slug}`)]]),
      call("Text", [lit("Detail")]),
    ]),
    call("Heading", [lit(`${humanAgg} detail`)], [["level", intLit(2)]]),
    call(
      "QueryView",
      [],
      [
        ["of", methodCall(queryRoot, "byId", [ref("id")])],
        ["single", boolLit(true)],
        ["loading", call("Skeleton", [], [["count", intLit(3)]])],
        ["error", call("Alert", [lit(`Couldn't load ${humanAgg.toLowerCase()}`)])],
        [
          "empty",
          call(
            "Alert",
            [lit(`No ${humanAgg.toLowerCase()} matches that id.`)],
            [["color", lit("yellow")]],
          ),
        ],
        ["data", lambda(cellVar, dataBody)],
      ],
    ),
  ]);
}

/** Expand `scaffoldOperations(of: <Agg>)`: one Modal per public
 * operation, each holding an `OperationForm(of: <Agg>, op: <opName>)`.
 * The flat shape avoids needing a loaded-record reference — the
 * mutation hook resolves the aggregate id from the route, so the
 * modals can live at top level rather than inside a QueryView
 * lambda. */
function expandScaffoldOperations(agg: AggregateIR): ExprIR {
  const slug = snake(plural(agg.name));
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  if (publicOps.length === 0) return call("Group", []);
  const opModals: ExprIR[] = publicOps.map((op, i) =>
    call(
      "Modal",
      [
        call(
          "OperationForm",
          [],
          [
            ["of", ref(agg.name)],
            ["op", ref(op.name)],
            ["testid", lit(`${slug}-op-${op.name}`)],
          ],
        ),
      ],
      [
        ["title", lit(humanize(op.name))],
        [
          "trigger",
          call(
            "Button",
            [lit(humanize(op.name))],
            [
              ["emphasis", lit(i === 0 ? "primary" : "secondary")],
              ["testid", lit(`${slug}-op-${op.name}`)],
            ],
          ),
        ],
      ],
    ),
  );
  return call("Group", opModals);
}

/** Expand `scaffoldList(of: <Agg>)`: the full list-page body — Breadcrumbs,
 *  Toolbar with a "New <agg>" button, QueryView wrapping a Paper-framed
 *  Table.  Mirrors what `expandAggregateList` produced for the
 *  archetype path; in fact the archetype wrapper delegates here so
 *  the two stay byte-equivalent. */
function expandScaffoldList(agg: AggregateIR, ctx: WalkerExpandContext): ExprIR {
  const apiHandle = findApiHandleFor(agg, ctx);
  const queryRoot = apiHandle ? member(ref(apiHandle), agg.name) : ref(agg.name);
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanLower = humanPlural.toLowerCase();
  const rowVar = "r";
  const cellVar = "o";

  const cols: ExprIR[] = [];
  cols.push(
    call("Column", [
      lit("ID"),
      lambda(cellVar, call("IdLink", [member(ref(cellVar), "id")], [["of", ref(agg.name)]])),
    ]),
  );
  for (const f of agg.fields) {
    const inner = f.type.kind === "optional" ? f.type.inner : f.type;
    if (inner.kind === "valueobject" || inner.kind === "array") continue;
    cols.push(
      call("Column", [
        lit(humanize(f.name)),
        lambda(cellVar, columnAccessorFor(f.name, f.type, cellVar)),
      ]),
    );
  }

  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], [["to", lit("/")]]),
        call("Text", [lit(humanPlural)]),
      ]),
      call("Toolbar", [
        call("Heading", [lit(humanPlural)], [["level", intLit(2)]]),
        call(
          "Button",
          [lit(`New ${singular(humanLower)}`)],
          [
            ["to", lit(`/${slug}/new`)],
            ["testid", lit(`${slug}-list-create`)],
          ],
        ),
      ]),
      call(
        "QueryView",
        [],
        [
          ["of", member(queryRoot, "all")],
          ["loading", call("Skeleton", [], [["count", intLit(5)]])],
          ["error", call("Alert", [lit(`Couldn't load ${humanLower}`)])],
          ["empty", call("Empty", [lit(`No ${humanLower} yet.`)])],
          [
            "data",
            lambda(
              "rows",
              call("Paper", [
                call(
                  "Table",
                  [...cols],
                  [
                    ["rows", ref("rows")],
                    ["striped", boolLit(true)],
                    ["highlight", boolLit(true)],
                    ["sticky", boolLit(true)],
                    [
                      "rowTestid",
                      lambda(rowVar, binary(lit(`${slug}-row-`), "+", member(ref(rowVar), "id"))),
                    ],
                  ],
                ),
              ]),
            ),
          ],
        ],
      ),
    ],
    [["testid", lit(`${slug}-list`)]],
  );
}

/** Expand `scaffoldNewForm(of: <Agg>)`: Stack(Breadcrumbs, Heading,
 *  Card(CreateForm(of: <Agg>))) — the wrapping page chrome around the
 *  named-leaf create form.  Emits `CreateForm` (new) rather than
 *  `Form(of:)` (legacy); both produce the same JSX through the body
 *  walker's shared field-preparer. */
function expandScaffoldNewForm(agg: AggregateIR): ExprIR {
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanAgg = humanize(agg.name);
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], [["to", lit("/")]]),
        call("Anchor", [lit(humanPlural)], [["to", lit(`/${slug}`)]]),
        call("Text", [lit("New")]),
      ]),
      call("Heading", [lit(`Create ${humanAgg.toLowerCase()}`)], [["level", intLit(2)]]),
      call("Card", [
        call(
          "CreateForm",
          [],
          [
            ["of", ref(agg.name)],
            ["testid", lit(`${slug}-new`)],
          ],
        ),
      ]),
    ],
    [["testid", lit(`${slug}-new-page`)]],
  );
}

/** Expand `scaffoldWorkflowForm(runs: <Wf>)`: Stack(Breadcrumbs,
 *  Heading, Card(WorkflowForm(runs: <Wf>))).  Emits `WorkflowForm`
 *  (new named primitive) rather than `Form(runs:)` (legacy). */
function expandScaffoldWorkflowForm(wf: import("./loom-ir.js").WorkflowIR): ExprIR {
  const wfSlug = snake(wf.name);
  const humanWf = humanize(wf.name);
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], [["to", lit("/")]]),
        call("Anchor", [lit("Workflows")], [["to", lit("/workflows")]]),
        call("Text", [lit(humanWf)]),
      ]),
      call("Heading", [lit(humanWf)], [["level", intLit(2)]]),
      call("Card", [
        call(
          "WorkflowForm",
          [],
          [
            ["runs", ref(wf.name)],
            ["testid", lit(`workflow-${wfSlug}`)],
          ],
        ),
      ]),
    ],
    [["testid", lit(`workflow-${wfSlug}-page`)]],
  );
}

/** Expand `scaffoldViewList(of: <View>)`: Heading + QueryView wrapping
 *  a Paper-framed Table over the view's projected rows.  Mirrors the
 *  archetype-driven `expandViewList`; the archetype wrapper delegates
 *  here so the two stay byte-equivalent. */
function expandScaffoldViewList(
  view: import("./loom-ir.js").ViewIR,
  ctx: WalkerExpandContext,
): ExprIR {
  const humanView = humanize(view.name);

  let fields: Array<{ name: string; type: import("./loom-ir.js").TypeIR }> = [];
  if (view.output) {
    fields = view.output.fields;
  } else {
    const sourceAgg = ctx.aggregatesByName.get(view.aggregateName);
    if (sourceAgg) fields = sourceAgg.fields;
  }
  const cellVar = "o";
  const cols: ExprIR[] = [];
  for (const f of fields) {
    const inner = f.type.kind === "optional" ? f.type.inner : f.type;
    if (inner.kind === "valueobject" || inner.kind === "array") continue;
    cols.push(
      call("Column", [
        lit(humanize(f.name)),
        lambda(cellVar, columnAccessorFor(f.name, f.type, cellVar)),
      ]),
    );
  }

  return call(
    "Stack",
    [
      call("Heading", [lit(humanView)], [["level", intLit(2)]]),
      call(
        "QueryView",
        [],
        [
          ["of", member(ref("Views"), view.name)],
          ["loading", call("Skeleton", [], [["count", intLit(5)]])],
          ["error", call("Alert", [lit(`Couldn't load ${humanView.toLowerCase()}`)])],
          ["empty", call("Empty", [lit("No rows.")])],
          [
            "data",
            lambda(
              "rows",
              call("Paper", [
                call(
                  "Table",
                  [...cols],
                  [
                    ["rows", ref("rows")],
                    ["striped", boolLit(true)],
                    ["highlight", boolLit(true)],
                    ["sticky", boolLit(true)],
                    ["keyExpr", lit("idx")],
                  ],
                ),
              ]),
            ),
          ],
        ],
      ),
    ],
    [["testid", lit(`view-${snake(view.name)}`)]],
  );
}

/** Expand the `Home()` sentinel body into the welcome page Stack
 *  with one summary Card per reachable section (aggregates,
 *  workflows, views).  Emitted by scaffold for the singleton Home
 *  page; recognised inline by `expandInlineScaffoldPrimitives`. */
function expandScaffoldHome(ctx: WalkerExpandContext): ExprIR {
  const aggCount = ctx.aggregatesByName.size;
  const wfCount = ctx.workflowsByName.size;
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

/** Bundled form of the read-side data section: the main field
 * card folded together with all related-entity cards in a single
 * nested Stack.  Returns a bare Card when there are no relations.
 *
 * Kept for the archetype-driven `expandAggregateDetail` path (which
 * interleaves the operations Group between card and related cards
 * — see `buildDataCardParts`).  The new
 * `scaffoldDetails(of:)` / `scaffoldOperations(of:)` primitives go
 * through their own dedicated `expandScaffoldDetails` /
 * `expandScaffoldOperations` helpers above. */
export function buildDataCardSection(
  agg: AggregateIR,
  ctx: WalkerExpandContext,
  cellVar: string,
): ExprIR {
  const { card, related } = buildDataCardParts(agg, ctx, cellVar);
  if (related.length === 0) return card;
  return call("Stack", [card, ...related]);
}

/** Split form: returns the main field Card and the related-entity
 * cards as separate pieces so a caller composing the loaded-record
 * body can interleave the operation Group between them (matches the
 * original archetype layout: card → operations → related). */
function buildDataCardParts(
  agg: AggregateIR,
  ctx: WalkerExpandContext,
  cellVar: string,
): { card: ExprIR; related: ExprIR[] } {
  const slug = snake(plural(agg.name));
  const rows: ExprIR[] = [];
  for (const f of agg.fields) {
    const inner = f.type.kind === "optional" ? f.type.inner : f.type;
    if (inner.kind === "array") continue;
    if (inner.kind === "valueobject") {
      rows.push(
        ...valueObjectRows(
          member(ref(cellVar), f.name),
          humanize(f.name),
          inner.name,
          ctx,
          agg.name,
        ),
      );
      continue;
    }
    rows.push(
      call(
        "KeyValueRow",
        [lit(humanize(f.name)), cellAccessorFor(f.name, f.type, cellVar)],
        [["testid", lit(`${slug}-detail-${f.name}`)]],
      ),
    );
  }

  const relatedCards: ExprIR[] = [];
  for (const c of agg.contains) {
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) continue;
    const humanPart = humanize(c.name);
    if (c.collection) {
      const partRowVar = "row";
      const cols: ExprIR[] = [];
      for (const f of part.fields) {
        const inner = f.type.kind === "optional" ? f.type.inner : f.type;
        if (inner.kind === "valueobject" || inner.kind === "array") continue;
        cols.push(
          call("Column", [
            lit(humanize(f.name)),
            lambda(partRowVar, columnAccessorFor(f.name, f.type, partRowVar)),
          ]),
        );
      }
      relatedCards.push(
        call(
          "Card",
          [
            call("Stack", [
              call("Heading", [lit(humanPart)], [["level", intLit(4)]]),
              call(
                "Table",
                [...cols],
                [
                  ["rows", member(ref(cellVar), c.name)],
                  ["striped", boolLit(true)],
                  ["highlight", boolLit(true)],
                  ["keyExpr", lit("idx")],
                ],
              ),
            ]),
          ],
          [["testid", lit(`${slug}-detail-${snake(c.name)}`)]],
        ),
      );
    } else {
      const singleRows: ExprIR[] = [];
      for (const f of part.fields) {
        const inner = f.type.kind === "optional" ? f.type.inner : f.type;
        if (inner.kind === "valueobject" || inner.kind === "array") continue;
        singleRows.push(
          call("KeyValueRow", [
            lit(humanize(f.name)),
            cellAccessorFor(`${c.name}.${f.name}`, f.type, cellVar),
          ]),
        );
      }
      relatedCards.push(
        call(
          "Card",
          [
            call("Stack", [
              call("Heading", [lit(humanPart)], [["level", intLit(4)]]),
              call("Stack", singleRows),
            ]),
          ],
          [["testid", lit(`${slug}-detail-${snake(c.name)}`)]],
        ),
      );
    }
  }

  const card = call("Card", [call("Stack", rows)]);
  return { card, related: relatedCards };
}

/** Build the operation-modal Group for an aggregate detail page:
 * one Modal per public operation, each holding
 * `Form(<cellVar>.<op>)`.  First op renders `emphasis: primary`,
 * the rest `emphasis: secondary` (design packs translate emphasis
 * into their own button variant).  Returns null if no public ops.
 *
 * Exported so the inline `scaffoldOperations(of:)` body primitive
 * can reuse it and stay byte-equivalent with the archetype path. */
export function buildOperationsSection(agg: AggregateIR, cellVar: string): ExprIR | null {
  const slug = snake(plural(agg.name));
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  if (publicOps.length === 0) return null;
  const opModals: ExprIR[] = publicOps.map((op, i) =>
    call(
      "Modal",
      [
        call(
          "OperationForm",
          [member(ref(cellVar), op.name)],
          [["testid", lit(`${slug}-op-${op.name}`)]],
        ),
      ],
      [
        ["title", lit(humanize(op.name))],
        [
          "trigger",
          call(
            "Button",
            [lit(humanize(op.name))],
            [
              ["emphasis", lit(i === 0 ? "primary" : "secondary")],
              ["testid", lit(`${slug}-op-${op.name}`)],
            ],
          ),
        ],
      ],
    ),
  );
  return call("Group", opModals);
}

/** Field-accessor for a detail-page row.  Same dispatch table as
 *  the list expander uses, but rooted on `data.<field>` instead
 *  of `o.<field>`.  Skips the IdLink wrapper for plain string ids
 *  (those are already typed as `string` and don't have a target
 *  aggregate to link to). */
function cellAccessorFor(
  fieldName: string,
  type: import("./loom-ir.js").TypeIR,
  rowVar: string,
): ExprIR {
  return typedCellFor(member(ref(rowVar), fieldName), type);
}

/** Type-dispatched cell renderer rooted at an arbitrary receiver
 *  expression (vs `cellAccessorFor`, which roots at
 *  `<rowVar>.<fieldName>`).  Lets value-object leaves render through
 *  a nested member chain (`data.shipTo.city`) built from real
 *  member IR nodes — so React emits `data.shipTo.city` and Phoenix
 *  emits `@data.ship_to.city` correctly (a dotted member string
 *  would mis-snake on the Phoenix HEEx walker). */
function typedCellFor(receiver: ExprIR, type: import("./loom-ir.js").TypeIR): ExprIR {
  const inner = type.kind === "optional" ? type.inner : type;
  if (inner.kind === "id") {
    return call("IdLink", [receiver], [["of", ref(inner.targetName)]]);
  }
  if (inner.kind === "primitive") {
    if (inner.name === "datetime") {
      return call("DateDisplay", [receiver]);
    }
    if (
      inner.name === "decimal" ||
      inner.name === "money" ||
      inner.name === "int" ||
      inner.name === "long"
    ) {
      return call("Text", [receiver]);
    }
  }
  if (inner.kind === "enum") {
    return call("EnumBadge", [receiver]);
  }
  return call("Text", [receiver]);
}

/** Flatten a value-object–typed aggregate field into one
 *  `KeyValueRow` per leaf, recursing through nested value objects.
 *  `receiver` is the member chain to the VO instance
 *  (`data.<field>`); `labelPrefix` is the humanised path so far.
 *  Array leaves are skipped (no scalar cell renderer — same rule
 *  as the top-level field loop).  Restores the legacy
 *  detail-preparer behaviour where value objects rendered as
 *  nested labelled field groups instead of being dropped. */
function valueObjectRows(
  receiver: ExprIR,
  labelPrefix: string,
  voName: string,
  ctx: WalkerExpandContext,
  aggregateName: string,
): ExprIR[] {
  const bc = ctx.bcByAggregate.get(aggregateName);
  const vo = bc?.valueObjects.find((v) => v.name === voName);
  if (!vo) return [];
  const out: ExprIR[] = [];
  for (const lf of vo.fields) {
    const li = lf.type.kind === "optional" ? lf.type.inner : lf.type;
    if (li.kind === "array") continue;
    const leafReceiver = member(receiver, lf.name);
    const label = `${labelPrefix} ${humanize(lf.name)}`;
    if (li.kind === "valueobject") {
      out.push(...valueObjectRows(leafReceiver, label, li.name, ctx, aggregateName));
      continue;
    }
    out.push(call("KeyValueRow", [lit(label), typedCellFor(leafReceiver, lf.type)]));
  }
  return out;
}

/** `methodCall` ExprIR helper.  The detail expander
 *  needs to synthesise `<api>.<Agg>.byId(id)` which is a method
 *  call (vs `<api>.<Agg>.all` which is plain member access).  The
 *  walker's `tryDetectApiHook` recognises this shape and lifts it
 *  to `useByIdAggregate(id)`. */
function methodCall(receiver: ExprIR, member: string, args: ExprIR[]): ExprIR {
  return {
    kind: "method-call",
    receiver,
    member,
    args,
    receiverType: PLACEHOLDER_TYPE,
    isCollectionOp: false,
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// IR constructors
// ---------------------------------------------------------------------------

// IR construction helpers.  The walker / React emitter doesn't
// consult `callKind` / `refKind` / `receiverType` / `memberType`
// for these synthesised primitives — they're informational fields
// lowering fills with type-resolution data, which we'd otherwise
// have to recompute.  Placeholder values (always `"free"` /
// `"unknown"` / a primitive string TypeIR) keep the shapes valid
// without inventing fake type info that downstream might trust.
const PLACEHOLDER_TYPE: import("./loom-ir.js").TypeIR = {
  kind: "primitive",
  name: "string",
};

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

function boolLit(value: boolean): ExprIR {
  return { kind: "literal", lit: "bool", value: value ? "true" : "false" };
}

function ref(name: string): ExprIR {
  return { kind: "ref", name, refKind: "unknown" };
}

function member(receiver: ExprIR, memberName: string): ExprIR {
  return {
    kind: "member",
    receiver,
    member: memberName,
    receiverType: PLACEHOLDER_TYPE,
    memberType: PLACEHOLDER_TYPE,
  };
}

function lambda(param: string, body: ExprIR): ExprIR {
  return { kind: "lambda", param, body };
}

function binary(left: ExprIR, op: import("./loom-ir.js").BinOp, right: ExprIR): ExprIR {
  return { kind: "binary", op, left, right };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pick the right walker primitive for a list-cell accessor based
 *  on the field's TypeIR.  Mirrors the scaffold cell-* templates'
 *  type-driven dispatch. */
function columnAccessorFor(
  fieldName: string,
  type: import("./loom-ir.js").TypeIR,
  rowVar: string,
): ExprIR {
  // Strip the optional wrapper — display dispatch ignores
  // optionality (empty values surface via per-pack helpers).
  const inner = type.kind === "optional" ? type.inner : type;
  if (inner.kind === "id") {
    return call("IdLink", [member(ref(rowVar), fieldName)], [["of", ref(inner.targetName)]]);
  }
  if (inner.kind === "primitive") {
    if (inner.name === "datetime") {
      return call("DateDisplay", [member(ref(rowVar), fieldName)]);
    }
    if (
      inner.name === "decimal" ||
      inner.name === "money" ||
      inner.name === "int" ||
      inner.name === "long"
    ) {
      return call("Text", [member(ref(rowVar), fieldName)]);
    }
  }
  if (inner.kind === "enum") {
    return call("EnumBadge", [member(ref(rowVar), fieldName)]);
  }
  // String / fallback: render as plain text.
  return call("Text", [member(ref(rowVar), fieldName)]);
}

/** Find the UI-level api param handle whose api covers the
 *  aggregate's owning module.  Returns the handle name (used as
 *  the receiver in `<handle>.<Agg>.all` body refs) or `null` when
 *  no matching api param exists. */
function findApiHandleFor(agg: AggregateIR, ctx: WalkerExpandContext): string | null {
  const bc = ctx.bcByAggregate.get(agg.name);
  if (!bc) return null;
  // The bcByAggregate map is keyed by aggregate, but the BC
  // doesn't store its module name directly.  We have to scan the
  // system's modules for the owning module.
  // Caller wires `ctx.ui.apiParams` (handle → apiName) and `sys.apis`
  // (apiName → sourceModule).  `lowerSystem`'s post-processing
  // path is responsible for plumbing those; here we delegate to
  // a heuristic: the FIRST api param wins.  The acme-order-
  // explicit.ddd shape uses exactly one param per UI, which is
  // the realistic case for v0 — multi-api UIs are handled later,
  // once the validator can prove which api owns which agg.
  const first = ctx.ui.apiParams[0];
  return first?.name ?? null;
}

/** Best-effort English singularisation: trims a trailing `s` on
 *  a humanised plural so "New orders" reads as "New order".  Used
 *  only for the toolbar Button label. */
function singular(humanLower: string): string {
  if (humanLower.endsWith("ies")) return humanLower.slice(0, -3) + "y";
  if (humanLower.endsWith("s")) return humanLower.slice(0, -1);
  return humanLower;
}

// Suppress unused-import lints when the module's helpers shrink
// during a refactor.  Each helper is referenced above; the unused
// suppressions below keep the import block minimal.
