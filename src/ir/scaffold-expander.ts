// Slice C1 — scaffold expander (dark-launched behind env flag).
//
// Pure function from `(ScaffoldOriginIR, system context) → ExprIR`
// that synthesises a walker-stdlib body equivalent to what the
// scaffold archetype renderer would emit.  When
// `LOOM_SCAFFOLD_EXPAND=1` is set, `lowerSystem` post-processes
// every page whose `scaffoldOrigin` is recognised, replacing the
// page's `body: List(of: …)` (or similar) with the expanded form.
// The React emitter then routes through the walker (Slice 11.3 +
// the Phase A primitive expansion) instead of through the legacy
// archetype path.
//
// This slice is purely additive — flag default off, baseline
// fixture unchanged.  Slice C2 flips the default and re-baselines
// the fixture; D1 deletes the archetype path entirely.
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
// Spillover (A10+):
//   - `aggregate-detail`   — needs operations / modals / KeyValueRow
//   - `workflow-form`      — needs workflow IR introspection
//   - `view-list`          — needs view IR introspection
//   - `home` / index pages — needs domain navigation primitives

import { camel, humanize, plural, snake } from "../util/naming.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ScaffoldOriginIR,
  SystemIR,
  UiIR,
} from "./loom-ir.js";

/** Inputs for the expander.  Carried as a struct so callers don't
 *  have to thread through the same handful of derived maps every
 *  call — `lowerSystem` builds these once at top-level. */
export interface ScaffoldExpandContext {
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
  /** Slice A12 — workflow by name.  Powers `workflow-form`
   *  expander coverage (`Form(runs: <wf>)` field dispatch). */
  workflowsByName: ReadonlyMap<string, import("./loom-ir.js").WorkflowIR>;
  /** Slice A13 — view by name + per-view shape lookup. */
  viewsByName: ReadonlyMap<string, import("./loom-ir.js").ViewIR>;
}

/** Build the expander context from the system + a specific UI.
 *  Used by `lowerSystem`'s post-processing pass and by tests. */
export function buildExpandContext(sys: SystemIR, ui: UiIR): ScaffoldExpandContext {
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

/** Public entry point.  Returns the expanded body `ExprIR` for an
 *  origin we know how to handle, or `null` to fall back to the
 *  legacy archetype path. */
export function expandScaffoldToExplicitBody(
  origin: ScaffoldOriginIR,
  ctx: ScaffoldExpandContext,
): ExprIR | null {
  switch (origin.kind) {
    case "aggregate-list":
      return expandAggregateList(origin.aggregateName, ctx);
    case "aggregate-new":
      return expandAggregateNew(origin.aggregateName, ctx);
    case "aggregate-detail":
      return expandAggregateDetail(origin.aggregateName, ctx);
    case "workflow-form":
      return expandWorkflowForm(origin.workflowName, ctx);
    case "view-list":
      return expandViewList(origin.viewName, ctx);
    case "workflows-index":
      return expandWorkflowsIndex(ctx);
    case "views-index":
      return expandViewsIndex(ctx);
    case "home":
      return expandHome(ctx);
  }
}

// ---------------------------------------------------------------------------
// Aggregate-list expansion
// ---------------------------------------------------------------------------

function expandAggregateList(aggregateName: string, ctx: ScaffoldExpandContext): ExprIR | null {
  const agg = ctx.aggregatesByName.get(aggregateName);
  if (!agg) return null;
  // Slice D1 — when the UI has an api parameter, route hook
  // detection through `<handle>.<agg>.all` (Pattern A).  When
  // not, drop the handle prefix → `<agg>.all` (Pattern D) so
  // legacy `scaffold modules: M` deployables without explicit
  // api params still get auto-injected hooks.
  const apiHandle = findApiHandleFor(agg, ctx);
  const queryRoot = apiHandle ? member(ref(apiHandle), agg.name) : ref(agg.name);
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanLower = humanPlural.toLowerCase();
  const rowVar = "r";
  const cellVar = "o";

  // One Column per non-collection aggregate field.  Collection
  // fields (`contains lines: OrderLine[]`) belong on the detail
  // page, not in a list table — we skip them here to match the
  // scaffold builder's behaviour.
  const cols: ExprIR[] = [];
  cols.push(
    call("Column", [
      lit("ID"),
      lambda(
        cellVar,
        call("IdLink", [member(ref(cellVar), "id")], undefined, [["of", ref(agg.name)]]),
      ),
    ]),
  );
  for (const f of agg.fields) {
    // Slice C2 — value-object fields don't render cleanly as a
    // single cell (they're a struct, not a scalar).  Scaffold's
    // archetype renderer flattens them into one column per leaf
    // field; replicating that here needs more primitive surface
    // (FlatColumns?) than B1 provides.  Skip for now — the column
    // surface is a v0 superset of what's strictly required for
    // tsc-clean output.
    const inner = f.type.kind === "optional" ? f.type.inner : f.type;
    if (inner.kind === "valueobject" || inner.kind === "array") continue;
    cols.push(
      call("Column", [
        lit(humanize(f.name)),
        lambda(cellVar, columnAccessorFor(f.name, f.type, cellVar)),
      ]),
    );
  }

  // Stack(...children, testid: "<slug>-list")
  return call(
    "Stack",
    [
      // Breadcrumbs
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], undefined, [["to", lit("/")]]),
        call("Text", [lit(humanPlural)]),
      ]),
      // Toolbar(Heading, Button)
      call("Toolbar", [
        call("Heading", [lit(humanPlural)], undefined, [["level", intLit(2)]]),
        call("Button", [lit(`New ${singular(humanLower)}`)], undefined, [
          ["to", lit(`/${slug}/new`)],
          ["testid", lit(`${slug}-list-create`)],
        ]),
      ]),
      // QueryView(of: api.Agg.all, loading, error, empty, data: rows => Paper(Table(...)))
      call("QueryView", [], undefined, [
        ["of", member(queryRoot, "all")],
        ["loading", call("Skeleton", [], undefined, [["count", intLit(5)]])],
        ["error", call("Alert", [lit(`Couldn't load ${humanLower}`)])],
        ["empty", call("Empty", [lit(`No ${humanLower} yet.`)])],
        [
          "data",
          lambda(
            "rows",
            call("Paper", [
              call("Table", [...cols], undefined, [
                ["rows", ref("rows")],
                ["striped", boolLit(true)],
                ["highlight", boolLit(true)],
                ["sticky", boolLit(true)],
                [
                  "rowTestid",
                  lambda(rowVar, binary(lit(`${slug}-row-`), "+", member(ref(rowVar), "id"))),
                ],
              ]),
            ]),
          ),
        ],
      ]),
    ],
    undefined,
    [["testid", lit(`${slug}-list`)]],
  );
}

// ---------------------------------------------------------------------------
// Aggregate-detail expansion
// ---------------------------------------------------------------------------

function expandAggregateDetail(aggregateName: string, ctx: ScaffoldExpandContext): ExprIR | null {
  const agg = ctx.aggregatesByName.get(aggregateName);
  if (!agg) return null;
  // Slice D1 — see expandAggregateList for the no-api-handle
  // fallback rationale.
  const apiHandle = findApiHandleFor(agg, ctx);
  const queryRoot = apiHandle ? member(ref(apiHandle), agg.name) : ref(agg.name);
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanAgg = humanize(agg.name);
  const cellVar = "data";

  // One KeyValueRow per scalar aggregate field.  Value-object fields
  // are flattened into one nested KeyValueRow per leaf (legacy
  // detail-preparer parity — they were previously dropped).  Array
  // fields still have no scalar cell renderer; collection
  // containments render below as their own nested-table section.
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
        undefined,
        [["testid", lit(`${slug}-detail-${f.name}`)]],
      ),
    );
  }

  // Related-entity lists.  Each `contains <name>: <Part>[]` collection
  // becomes a titled Card holding a Table over `data.<name>`, one
  // Column per part field (same type-driven accessor the list
  // expander uses for aggregate columns).  Non-collection (single)
  // containments render as a small KeyValueRow card so the nested
  // record is still visible without a JSON-dump primitive.
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
              call("Heading", [lit(humanPart)], undefined, [["level", intLit(4)]]),
              call("Table", [...cols], undefined, [
                ["rows", member(ref(cellVar), c.name)],
                ["striped", boolLit(true)],
                ["highlight", boolLit(true)],
                ["keyExpr", lit("idx")],
              ]),
            ]),
          ],
          undefined,
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
              call("Heading", [lit(humanPart)], undefined, [["level", intLit(4)]]),
              call("Stack", singleRows),
            ]),
          ],
          undefined,
          [["testid", lit(`${slug}-detail-${snake(c.name)}`)]],
        ),
      );
    }
  }

  // Operation controls.  Each public operation becomes a Modal
  // whose trigger Button opens an auto-generated form bound to the
  // `use<Op><Agg>` mutation hook.  The first op is the primary
  // action, the rest secondary — expressed as a platform-neutral
  // `emphasis:` token (each design pack maps it to its own button
  // vocabulary; the IR carries intent, never a pack-specific
  // variant string).
  const opModals: ExprIR[] = [];
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  publicOps.forEach((op, i) => {
    opModals.push(
      call(
        "Modal",
        [
          // Instance-qualified operation form: the operation is
          // referenced through the loaded record (`data.<op>`), which
          // carries the aggregate type and id.  On a Detail page the
          // record is a QueryView lambda binding, so the mutation hook
          // falls back to the route `id` (data.id === id here).
          call("Form", [member(ref(cellVar), op.name)], undefined, [
            ["testid", lit(`${slug}-op-${op.name}`)],
          ]),
        ],
        undefined,
        [
          ["title", lit(humanize(op.name))],
          [
            "trigger",
            call("Button", [lit(humanize(op.name))], undefined, [
              ["emphasis", lit(i === 0 ? "primary" : "secondary")],
              ["testid", lit(`${slug}-op-${op.name}`)],
            ]),
          ],
        ],
      ),
    );
  });

  // Compose the loaded-record body: the field card, then the
  // operation-button row, then the related-entity lists.
  const dataSections: ExprIR[] = [call("Card", [call("Stack", rows)])];
  if (opModals.length > 0) dataSections.push(call("Group", opModals));
  dataSections.push(...relatedCards);
  const dataBody = dataSections.length > 1 ? call("Stack", dataSections) : dataSections[0]!;

  return call(
    "Stack",
    [
      // Breadcrumbs(Anchor("Home", to: "/"), Anchor(<Plural>, to: …), Text("Detail"))
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], undefined, [["to", lit("/")]]),
        call("Anchor", [lit(humanPlural)], undefined, [["to", lit(`/${slug}`)]]),
        call("Text", [lit("Detail")]),
      ]),
      // Heading(<HumanAgg> + " detail", level: 2)
      call("Heading", [lit(`${humanAgg} detail`)], undefined, [["level", intLit(2)]]),
      // QueryView(of: api.Agg.byId(id), single: true, loading, error, empty: not-found, data: data => Card(Stack(...rows)))
      call("QueryView", [], undefined, [
        ["of", methodCall(queryRoot, "byId", [ref("id")])],
        ["single", boolLit(true)],
        ["loading", call("Skeleton", [], undefined, [["count", intLit(3)]])],
        ["error", call("Alert", [lit(`Couldn't load ${humanAgg.toLowerCase()}`)])],
        [
          "empty",
          call("Alert", [lit(`No ${humanAgg.toLowerCase()} matches that id.`)], undefined, [
            ["color", lit("yellow")],
          ]),
        ],
        ["data", lambda(cellVar, dataBody)],
      ]),
    ],
    undefined,
    [["testid", lit(`${slug}-detail`)]],
  );
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
    return call("IdLink", [receiver], undefined, [["of", ref(inner.targetName)]]);
  }
  if (inner.kind === "primitive") {
    if (inner.name === "datetime") {
      return call("DateDisplay", [receiver]);
    }
    if (inner.name === "decimal" || inner.name === "int" || inner.name === "long") {
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
  ctx: ScaffoldExpandContext,
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

/** Slice A11 — `methodCall` ExprIR helper.  The detail expander
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
// Aggregate-new expansion
// ---------------------------------------------------------------------------

function expandAggregateNew(aggregateName: string, ctx: ScaffoldExpandContext): ExprIR | null {
  const agg = ctx.aggregatesByName.get(aggregateName);
  if (!agg) return null;
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanAgg = humanize(agg.name);
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], undefined, [["to", lit("/")]]),
        call("Anchor", [lit(humanPlural)], undefined, [["to", lit(`/${slug}`)]]),
        call("Text", [lit("New")]),
      ]),
      call("Heading", [lit(`Create ${humanAgg.toLowerCase()}`)], undefined, [["level", intLit(2)]]),
      call("Card", [
        call("Form", [], undefined, [
          ["of", ref(agg.name)],
          ["testid", lit(`${slug}-new`)],
        ]),
      ]),
    ],
    undefined,
    [["testid", lit(`${slug}-new-page`)]],
  );
}

// ---------------------------------------------------------------------------
// Workflow-form expansion
// ---------------------------------------------------------------------------

function expandWorkflowForm(workflowName: string, ctx: ScaffoldExpandContext): ExprIR | null {
  const wf = ctx.workflowsByName.get(workflowName);
  if (!wf) return null;
  const wfSlug = snake(wf.name);
  const humanWf = humanize(wf.name);
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], undefined, [["to", lit("/")]]),
        call("Anchor", [lit("Workflows")], undefined, [["to", lit("/workflows")]]),
        call("Text", [lit(humanWf)]),
      ]),
      call("Heading", [lit(humanWf)], undefined, [["level", intLit(2)]]),
      call("Card", [
        call("Form", [], undefined, [
          ["runs", ref(wf.name)],
          ["testid", lit(`workflow-${wfSlug}`)],
        ]),
      ]),
    ],
    undefined,
    [["testid", lit(`workflow-${wfSlug}-page`)]],
  );
}

// ---------------------------------------------------------------------------
// View-list expansion
// ---------------------------------------------------------------------------

function expandViewList(viewName: string, ctx: ScaffoldExpandContext): ExprIR | null {
  const view = ctx.viewsByName.get(viewName);
  if (!view) return null;
  const humanView = humanize(view.name);
  const viewSlug = snake(view.name);

  // Row fields come from one of two sources:
  //   - Custom output (full-form view): `view.output.fields`
  //   - Shorthand:                       source aggregate's fields
  // Either way, we project them as Column accessors using the
  // same type-driven dispatch the list expander uses.
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
      call("Heading", [lit(humanView)], undefined, [["level", intLit(2)]]),
      call("QueryView", [], undefined, [
        // `Views.<name>` is the view-hook reference — walker
        // detects this Pattern C and lifts to `useXxxView()`.
        ["of", member(ref("Views"), view.name)],
        ["loading", call("Skeleton", [], undefined, [["count", intLit(5)]])],
        ["error", call("Alert", [lit(`Couldn't load ${humanView.toLowerCase()}`)])],
        ["empty", call("Empty", [lit("No rows.")])],
        [
          "data",
          lambda(
            "rows",
            call("Paper", [
              call("Table", [...cols], undefined, [
                ["rows", ref("rows")],
                ["striped", boolLit(true)],
                ["highlight", boolLit(true)],
                ["sticky", boolLit(true)],
                // Custom-output views don't have a stable `id`
                // field on row, so key by index.  Shorthand views
                // do have `id` (rows are aggregate responses) but
                // index-by-key still works correctly there.
                ["keyExpr", lit("idx")],
              ]),
            ]),
          ),
        ],
      ]),
    ],
    undefined,
    [["testid", lit(`view-${viewSlug}`)]],
  );
}

// ---------------------------------------------------------------------------
// Home + index expansions
// ---------------------------------------------------------------------------

function expandHome(ctx: ScaffoldExpandContext): ExprIR {
  // Walker stdlib doesn't ship `SimpleGrid` (Mantine-specific
  // responsive grid) yet; use a plain Stack of summary cards.
  // Counts come from the expander's reachable-context maps.
  const aggCount = ctx.aggregatesByName.size;
  const wfCount = ctx.workflowsByName.size;
  const viewCount = ctx.viewsByName.size;
  const cards: ExprIR[] = [];
  if (aggCount > 0) {
    cards.push(
      call("Card", [
        call("Heading", [lit(pluralize(aggCount, "aggregate", "aggregates"))], undefined, [
          ["level", intLit(4)],
        ]),
        call("Text", [lit("Manage records of each kind from the sidebar.")]),
      ]),
    );
  }
  if (wfCount > 0) {
    cards.push(
      call("Card", [
        call("Heading", [lit(pluralize(wfCount, "workflow", "workflows"))], undefined, [
          ["level", intLit(4)],
        ]),
        call("Anchor", [lit("Open workflows →")], undefined, [["to", lit("/workflows")]]),
      ]),
    );
  }
  if (viewCount > 0) {
    cards.push(
      call("Card", [
        call("Heading", [lit(pluralize(viewCount, "view", "views"))], undefined, [
          ["level", intLit(4)],
        ]),
        call("Anchor", [lit("Open views →")], undefined, [["to", lit("/views")]]),
      ]),
    );
  }
  return call(
    "Stack",
    [
      call("Heading", [lit("Welcome")], undefined, [["level", intLit(2)]]),
      call("Text", [lit("Pick a section from the sidebar to start, or jump straight in below.")]),
      call("Stack", cards),
    ],
    undefined,
    [["testid", lit("home")]],
  );
}

function expandWorkflowsIndex(ctx: ScaffoldExpandContext): ExprIR {
  const cards: ExprIR[] = [];
  for (const wf of ctx.workflowsByName.values()) {
    const slug = snake(wf.name);
    cards.push(
      call(
        "Card",
        [
          call("Heading", [lit(humanize(wf.name))], undefined, [["level", intLit(4)]]),
          call("Anchor", [lit("Run →")], undefined, [
            ["to", lit(`/workflows/${slug}`)],
            ["testid", lit(`workflow-${slug}-run`)],
          ]),
        ],
        undefined,
        [["testid", lit(`workflow-card-${slug}`)]],
      ),
    );
  }
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], undefined, [["to", lit("/")]]),
        call("Text", [lit("Workflows")]),
      ]),
      call("Heading", [lit("Workflows")], undefined, [["level", intLit(2)]]),
      call("Text", [lit("System-level orchestrations.  Pick one to run.")]),
      call("Stack", cards),
    ],
    undefined,
    [["testid", lit("workflows-index")]],
  );
}

function expandViewsIndex(ctx: ScaffoldExpandContext): ExprIR {
  const cards: ExprIR[] = [];
  for (const view of ctx.viewsByName.values()) {
    const slug = snake(view.name);
    cards.push(
      call(
        "Card",
        [
          call("Heading", [lit(humanize(view.name))], undefined, [["level", intLit(4)]]),
          call("Anchor", [lit("Open →")], undefined, [
            ["to", lit(`/views/${slug}`)],
            ["testid", lit(`view-${slug}-open`)],
          ]),
        ],
        undefined,
        [["testid", lit(`view-card-${slug}`)]],
      ),
    );
  }
  return call(
    "Stack",
    [
      call("Breadcrumbs", [
        call("Anchor", [lit("Home")], undefined, [["to", lit("/")]]),
        call("Text", [lit("Views")]),
      ]),
      call("Heading", [lit("Views")], undefined, [["level", intLit(2)]]),
      call("Text", [lit("Saved queries.  Open one to inspect rows.")]),
      call("Stack", cards),
    ],
    undefined,
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
// have to recompute.  Placeholder values (always `"free"` /
// `"unknown"` / a primitive string TypeIR) keep the shapes valid
// without inventing fake type info that downstream might trust.
const PLACEHOLDER_TYPE: import("./loom-ir.js").TypeIR = {
  kind: "primitive",
  name: "string",
};

function call(
  name: string,
  positionals: ExprIR[],
  _ignore: undefined = undefined,
  named: Array<[string, ExprIR]> = [],
): ExprIR {
  void _ignore;
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
    return call("IdLink", [member(ref(rowVar), fieldName)], undefined, [
      ["of", ref(inner.targetName)],
    ]);
  }
  if (inner.kind === "primitive") {
    if (inner.name === "datetime") {
      return call("DateDisplay", [member(ref(rowVar), fieldName)]);
    }
    if (inner.name === "decimal" || inner.name === "int" || inner.name === "long") {
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
function findApiHandleFor(agg: AggregateIR, ctx: ScaffoldExpandContext): string | null {
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
  // the realistic case for v0 — multi-api UIs land in a future
  // slice when the validator can prove which api owns which agg.
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
void camel;
