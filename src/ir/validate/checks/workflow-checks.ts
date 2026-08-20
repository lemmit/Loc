// -------------------------------------------------------------------------
// Workflow checks — correlation typing, workflow-body legality, and
// resource-op expressions.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { createInputFields, omittableCreateInputs } from "../../enrich/wire-projection.js";
import { verbsForKind } from "../../resource-verbs.js";
import type {
  BoundedContextIR,
  EventIR,
  ExprIR,
  TypeIR,
  WorkflowIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import { findUsesCurrentUser } from "../../types/loom-ir.js";
import { walkExprDeep, walkStmtExprsDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Workflow validation.
//
// A `workflow` is a context-level orchestration of aggregate operations.
// The grammar reuses operation-body Statement rules; this validator
// constrains the surface to what workflow lowering supports:
//
//   - factory-let (`let x = Agg.create({...})`)
//   - repo-let (`let x = Repo.method(args)`) returning a single
//     non-nullable aggregate
//   - op-call (`name.op(args)` on a let binding)
//   - precondition / emit
//
// Mutation forms (`:=`, `+=`, `-=`), bare-call statements, deep paths,
// nullable / array repo returns, and op-calls on non-aggregate
// bindings all surface as errors here.
// ---------------------------------------------------------------------------

// System-wide: a workflow event consumer (`on(e: Event)` reactor /
// event-triggered `create(e: Event) by` starter) whose event no `channel`
// anywhere carries can never be dispatched — in-process delivery is
// channel-routed (channels.md).  Almost always a mistake (a reactor written
// before its channel was declared), so warn.  Cross-context-safe: a channel
// only carries events of its own context, but the reactor may live elsewhere,
// so the carried-event set is gathered across the whole model rather than per
// context.  A warning (not an error) so a model mid-construction — or one that
// reaches the consumer by a transport other than the in-process dispatcher —
// still builds.
// A workflow's event consumers — `on(e: Event)` reactors and event-triggered
// `create(e: Event) by` starters — as `{ event, label }` pairs.  Shared by the
// channel-routing checks (`reactor-event-uncarried`, `reactor-channel-ambiguous`).
function eventConsumersOf(wf: WorkflowIR): { event: string; label: string }[] {
  return [
    ...(wf.subscriptions ?? []).map((s) => ({ event: s.event, label: `on(${s.event})` })),
    ...(wf.creates ?? [])
      .filter((cr) => cr.triggerKind === "event" && !!cr.eventRef)
      .map((cr) => ({
        event: cr.eventRef as string,
        label: `create(${cr.eventBinding ?? "_"}: ${cr.eventRef})`,
      })),
  ];
}

export function validateEventConsumersCarried(
  contexts: BoundedContextIR[],
  diags: LoomDiagnostic[],
): void {
  const carried = new Set<string>();
  for (const c of contexts)
    for (const ch of c.channels) for (const ev of ch.carries) carried.add(ev);
  for (const c of contexts) {
    for (const wf of c.workflows) {
      for (const cons of eventConsumersOf(wf)) {
        if (!carried.has(cons.event)) {
          diags.push({
            severity: "warning",
            code: "loom.reactor-event-uncarried",
            message: diagMessage("loom.reactor-event-uncarried", {
              name: wf.name,
              label: cons.label,
              event: cons.event,
            }),
            source: `${c.name}/${wf.name}`,
          });
        }
      }
    }
    // A projection folds FOREIGN events, delivered through the same
    // channel-routed in-process dispatch as a workflow reactor (projection.md
    // `loom.projection-event-uncarried`, "reuses `loom.reactor-event-uncarried`").
    // A fold whose event no channel carries never receives an event — its
    // read-model row is never written.  Warn (not error), like the reactor twin:
    // a model mid-construction, or one whose event arrives by a non-in-process
    // transport, still builds.  Query-time projections have no folds, so this
    // never fires for them.
    for (const proj of c.projections) {
      for (const h of proj.handlers) {
        if (!carried.has(h.event)) {
          diags.push({
            severity: "warning",
            code: "loom.projection-event-uncarried",
            message: diagMessage("loom.projection-event-uncarried", {
              name: proj.name,
              param: h.param,
              event: h.event,
            }),
            source: `${c.name}/${proj.name}`,
          });
        }
      }
    }
  }
}

// A workflow event consumer whose event is carried by MORE THAN ONE channel in
// its context has an ambiguous channel binding: the in-process dispatch enrich
// (`deriveEventSubscriptions`) records the first channel by declaration order.
// In-process delivery routes by event *type*, so the consumer still fires
// exactly once today — but once channels bind distinct transports (via
// `channelSource`), the routing is genuinely ambiguous.  There's no `via
// <Channel>` disambiguator in the grammar yet, so warn (don't block): carry the
// event on a single channel to make routing explicit.  Counted per context,
// matching the enrich's routing scope (`deriveEventSubscriptions(ctx.channels,
// …)`).
export function validateEventChannelAmbiguous(
  contexts: BoundedContextIR[],
  diags: LoomDiagnostic[],
): void {
  for (const c of contexts) {
    for (const wf of c.workflows) {
      for (const cons of eventConsumersOf(wf)) {
        const carriers = c.channels
          .filter((ch) => ch.carries.includes(cons.event))
          .map((ch) => ch.name);
        if (carriers.length > 1) {
          diags.push({
            severity: "warning",
            code: "loom.reactor-channel-ambiguous",
            message: diagMessage("loom.reactor-channel-ambiguous", {
              name: wf.name,
              label: cons.label,
              event: cons.event,
              length: carriers.length,
              carriers: carriers.join(", "),
              carriers2: carriers[0],
            }),
            source: `${c.name}/${wf.name}`,
          });
        }
      }
    }
  }
}

export function validateWorkflows(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  allEvents?: EventIR[],
): void {
  // Reserved-name guard: workflows share the context namespace with
  // aggregates, value objects, enums, events, repositories.
  const namesUsed = new Map<string, string>();
  for (const a of ctx.aggregates) namesUsed.set(a.name, "aggregate");
  for (const v of ctx.valueObjects) namesUsed.set(v.name, "value object");
  for (const e of ctx.enums) namesUsed.set(e.name, "enum");
  for (const ev of ctx.events) namesUsed.set(ev.name, "event");
  for (const r of ctx.repositories) namesUsed.set(r.name, "repository");
  const seenWorkflowNames = new Set<string>();
  for (const wf of ctx.workflows) {
    if (seenWorkflowNames.has(wf.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-workflow",
        message: diagMessage("loom.duplicate-workflow", { name: ctx.name, wfName: wf.name }),
        source: `${ctx.name}/${wf.name}`,
      });
    } else {
      seenWorkflowNames.add(wf.name);
    }
    const clash = namesUsed.get(wf.name);
    if (clash) {
      diags.push({
        severity: "error",
        code: "loom.workflow-name-collision",
        message: diagMessage("loom.workflow-name-collision", {
          name: ctx.name,
          wfName: wf.name,
          clash,
        }),
        source: `${ctx.name}/${wf.name}`,
      });
    }
    validateWorkflowBody(ctx, wf, diags);
    validateWorkflowCorrelation(ctx, wf, diags, allEvents);
    validateWorkflowCreates(wf, diags, ctx.name);
    validateWorkflowFunctions(wf, diags, ctx.name);
  }
}

// A workflow `function` is emitted as a per-workflow-scoped MODULE helper (a
// workflow body is not a class), so it has no `this` at its emission site: it
// must be pure over its PARAMETERS and may not read the workflow's own state
// fields.  A body that references `this` / a state field would render an
// undefined `this` at module scope, so reject it here
// (`loom.workflow-function-uses-state`).  Pass the value in as a parameter
// instead.  (Sibling workflow-function calls are fine — they are module helpers
// too.)
function validateWorkflowFunctions(wf: WorkflowIR, diags: LoomDiagnostic[], ctxName: string): void {
  const readsState = (node: ExprIR): boolean =>
    node.kind === "this" ||
    (node.kind === "ref" &&
      (node.refKind === "this-prop" ||
        node.refKind === "this-vo-prop" ||
        node.refKind === "this-derived"));
  for (const fn of wf.functions ?? []) {
    let usesState = false;
    const visit = (node: ExprIR): void => {
      if (readsState(node)) usesState = true;
    };
    // Both forms: the expression body, or every expression reachable from the
    // pure block body's statements (let / precondition / return).
    if ("expr" in fn.body) walkExprDeep(fn.body.expr, visit);
    else for (const s of fn.body.stmts) walkStmtExprsDeep(s, visit);
    if (usesState) {
      diags.push({
        severity: "error",
        code: "loom.workflow-function-uses-state",
        message: diagMessage("loom.workflow-function-uses-state", {
          ctxName,
          name: wf.name,
          fnName: fn.name,
        }),
        source: `${ctxName}/${wf.name}`,
      });
    }
  }
}

// Workflow create-declaration well-formedness (workflow-and-applier.md A2-S5f,
// validation rules 21–23).  A workflow may declare several `create` starters —
// one per entry point.  These checks keep that set unambiguous so the runtime
// can route a command (or inbound event) to exactly one starter, and so the
// deprecated `params`/`statements` facade has a single, well-defined primary
// create to project from (it picks the unnamed command-triggered create).
//
//   - rule 21 (`loom.canonical-create-duplicate-workflow`) — at most one
//     unnamed (canonical) create; extra entry points must be named.
//   - rule 22 (`loom.create-name-conflict-workflow`)       — no two creates
//     share a name.
//   - rule 23 (`loom.event-create-overlap-workflow`)       — no two
//     event-triggered creates start on the same event.
//
// Rule 24 (create-vs-on correlation agreement) is not a check of its own: an
// event-triggered create's `by` clause is validated against the single
// correlation field by `validateWorkflowCorrelation`, exactly like a reactor,
// so a `create` and an `on` for one event necessarily agree.  (Both rules 23
// and 24 are now expressible: `CreateIR.eventRef` / `correlation` are derived
// for event-triggered creates.)
function validateWorkflowCreates(wf: WorkflowIR, diags: LoomDiagnostic[], ctxName: string): void {
  const src = `${ctxName}/${wf.name}`;
  const creates = wf.creates ?? [];

  // rule 21 — at most one canonical (unnamed) create.
  const canonical = creates.filter((c) => c.name === null);
  if (canonical.length > 1) {
    diags.push({
      severity: "error",
      code: "loom.canonical-create-duplicate-workflow",
      message: diagMessage("loom.canonical-create-duplicate-workflow", {
        name: wf.name,
        length: canonical.length,
      }),
      source: src,
    });
  }

  // rule 22 — no two creates share a name.
  const nameCounts = new Map<string, number>();
  for (const c of creates) {
    if (c.name === null) continue;
    nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      diags.push({
        severity: "error",
        code: "loom.create-name-conflict-workflow",
        message: diagMessage("loom.create-name-conflict-workflow", {
          name: wf.name,
          count,
          name2: name,
        }),
        source: src,
      });
    }
  }

  // rule 23 — no two event-triggered creates start on the same event.  The
  // runtime allocates one workflow instance per inbound event, so two starters
  // on the same event leave it unable to choose which to allocate.  (Now
  // checkable: `CreateIR.eventRef` is derived for event-triggered creates.)
  const eventCreateCounts = new Map<string, number>();
  for (const c of creates) {
    if (c.triggerKind === "event" && c.eventRef) {
      eventCreateCounts.set(c.eventRef, (eventCreateCounts.get(c.eventRef) ?? 0) + 1);
    }
  }
  for (const [event, count] of eventCreateCounts) {
    if (count > 1) {
      diags.push({
        severity: "error",
        code: "loom.event-create-overlap-workflow",
        message: diagMessage("loom.event-create-overlap-workflow", { name: wf.name, count, event }),
        source: src,
      });
    }
  }
}

/** The resolved type a `by <expr>` correlation expression yields — a member
 *  access carries `memberType`, a bare ref carries `type`. */
function correlationExprType(e: ExprIR): TypeIR | undefined {
  if (e.kind === "member") return e.memberType;
  if (e.kind === "ref") return e.type;
  return undefined;
}

const idTarget = (t: TypeIR | undefined): string | undefined =>
  t && t.kind === "id" ? t.targetName : undefined;

// Correlation-field rules (workflow-and-applier.md A2-S2 + A2-S3).  A workflow
// with event consumers — `on(e: Event)` reactors *and* event-triggered
// `create(e: Event) by` starters — routes each inbound event to exactly one
// id-shaped state field, the correlation field.
//
//   - rule 10 (`loom.workflow-correlation-required`) — no id-shaped field.
//   - rule 19 (`loom.correlation-field-ambiguous`)   — more than one.
//   - rule 12 (`loom.correlation-type-mismatch`)     — a `by <expr>` yields a
//     value of a different id type than the correlation field.
//   - (`loom.correlation-uninferrable`) — a consumer omits `by` but its event
//     has no field whose name matches the correlation field, so routing can't
//     be inferred by name-match.
//
// Applying these uniformly to reactors AND event-creates also subsumes rule 24
// (create-vs-on correlation agreement): both are checked against the same
// correlation field, so a `create` and an `on` for one event necessarily agree.
function validateWorkflowCorrelation(
  ctx: BoundedContextIR,
  wf: WorkflowIR,
  diags: LoomDiagnostic[],
  allEvents?: EventIR[],
): void {
  // Unified event-consumer list: `on` reactors + event-triggered creates.  Each
  // carries the subscribed event, its optional `by <expr>` routing, and a label
  // for diagnostics.
  const consumers: { event: string; correlation?: ExprIR; label: string }[] = [
    ...(wf.subscriptions ?? []).map((s) => ({
      event: s.event,
      correlation: s.correlation,
      label: `on(${s.event})`,
    })),
    ...(wf.creates ?? [])
      .filter((c) => c.triggerKind === "event" && !!c.eventRef)
      .map((c) => ({
        event: c.eventRef as string,
        correlation: c.correlation,
        label: `create(${c.eventBinding ?? "_"}: ${c.eventRef})`,
      })),
  ];
  if (consumers.length === 0) return;
  const src = `${ctx.name}/${wf.name}`;
  const idFields = (wf.stateFields ?? []).filter((f) => f.type.kind === "id");
  if (idFields.length === 0) {
    diags.push({
      severity: "error",
      message: diagMessage("loom.workflow-correlation-required", { name: wf.name }),
      source: src,
      code: "loom.workflow-correlation-required",
    });
    return;
  }
  if (idFields.length > 1) {
    diags.push({
      severity: "error",
      message: diagMessage("loom.correlation-field-ambiguous", {
        name: wf.name,
        length: idFields.length,
        idFields: idFields.map((f) => f.name).join(", "),
      }),
      source: src,
      code: "loom.correlation-field-ambiguous",
    });
    return;
  }
  // Exactly one correlation field — type-check each consumer's routing.
  const corr = idFields[0];
  const corrTarget = idTarget(corr.type);
  for (const sub of consumers) {
    if (sub.correlation) {
      const byTarget = idTarget(correlationExprType(sub.correlation));
      if (byTarget !== corrTarget) {
        diags.push({
          severity: "error",
          message: diagMessage("loom.correlation-type-mismatch", {
            name: wf.name,
            label: sub.label,
            byTarget: byTarget ? `'${byTarget} id'` : "a non-id value",
            corrName: corr.name,
            corrTarget,
          }),
          source: src,
          code: "loom.correlation-type-mismatch",
        });
      }
    } else {
      // Omitted `by` — route by name-match: the event must carry a field of
      // the correlation field's name.
      // Cross-context reactors (M-T4.4): a foreign event consumed through a
      // wired channel isn't in ctx.events — fall back to the model-wide list.
      const ev =
        ctx.events.find((e) => e.name === sub.event) ??
        allEvents?.find((e) => e.name === sub.event);
      const hasMatch = ev?.fields.some((f) => f.name === corr.name) ?? false;
      if (!hasMatch) {
        diags.push({
          severity: "error",
          message: diagMessage("loom.correlation-uninferrable", {
            name: wf.name,
            label: sub.label,
            event: sub.event,
            corrName: corr.name,
          }),
          source: src,
          code: "loom.correlation-uninferrable",
        });
      }
    }
  }
}

function validateWorkflowBody(
  ctx: BoundedContextIR,
  wf: {
    name: string;
    statements: import("../../types/loom-ir.js").WorkflowStmtIR[];
    transactional: boolean;
    eventSourced?: boolean;
    isolation?: import("../../types/loom-ir.js").IsolationLevel;
    params: import("../../types/loom-ir.js").ParamIR[];
  },
  diags: LoomDiagnostic[],
): void {
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const reposByName = new Map(ctx.repositories.map((r) => [r.name, r] as const));
  const eventsByName = new Map(ctx.events.map((e) => [e.name, e] as const));
  const bindingAgg = new Map<string, string>(); // bindingName -> aggName
  const arrayBindingAgg = new Map<string, string>(); // repo-run binding -> element aggName
  let mutated = false;

  for (const st of wf.statements) {
    switch (st.kind) {
      case "precondition":
      case "requires":
        // Type-check happens at lowering via `inferExprType`; we'd
        // need the AST node to re-check here.  Trust the lowered IR
        // and emit a warning if the expression looks degenerate
        // (kind === "ref" with refKind "unknown").
        if (st.expr.kind === "ref" && st.expr.refKind === "unknown") {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-name",
            message: diagMessage("loom.workflow-unknown-name", {
              name: wf.name,
              kind: st.kind,
              exprName: st.expr.name,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
        }
        break;
      case "emit": {
        const ev = eventsByName.get(st.eventName);
        if (!ev) {
          diags.push({
            severity: "error",
            code: "loom.workflow-emit-unknown-event",
            message: diagMessage("loom.workflow-emit-unknown-event", {
              name: wf.name,
              eventName: st.eventName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const declared = new Set(ev.fields.map((f) => f.name));
        const provided = new Set(st.fields.map((f) => f.name));
        for (const f of declared) {
          if (!provided.has(f)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-emit-missing-field",
              message: diagMessage("loom.workflow-emit-missing-field", {
                name: wf.name,
                evName: ev.name,
                f,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        for (const f of provided) {
          if (!declared.has(f)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-emit-unknown-field",
              message: diagMessage("loom.workflow-emit-unknown-field", {
                name: wf.name,
                evName: ev.name,
                f,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        mutated = true;
        break;
      }
      case "factory-let": {
        const agg = aggsByName.get(st.aggName);
        if (!agg) {
          diags.push({
            severity: "error",
            code: "loom.workflow-create-unknown-aggregate",
            message: diagMessage("loom.workflow-create-unknown-aggregate", {
              name: wf.name,
              aggName: st.aggName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // A workflow `Agg.create({...})` invokes the canonical create,
        // which is parameterized by the aggregate's *create-input* fields
        // — `forCreateInput` drops the server-populated roles
        // (`managed`/`token`/`internal`) and the required subset further
        // drops fields the client may omit (optional, `= default`, bare
        // `bool`).  Validate against that contract, the same set the
        // backends' create-call emitters consume, rather than the raw
        // field list: a `managed` timestamp is neither required here nor a
        // legal argument (passing one would fail the backend create-call).
        const omittable = omittableCreateInputs(agg);
        const inputFields = createInputFields(agg).map((f) => f.name);
        const required = inputFields.filter((n) => !omittable.has(n));
        const provided = new Set(st.fields.map((f) => f.name));
        for (const r of required) {
          if (!provided.has(r)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-create-missing-field",
              message: diagMessage("loom.workflow-create-missing-field", {
                name: wf.name,
                aggName: st.aggName,
                r,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        const allowed = new Set(inputFields);
        for (const p of provided) {
          if (!allowed.has(p)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-create-unknown-field",
              message: diagMessage("loom.workflow-create-unknown-field", {
                name: wf.name,
                aggName: st.aggName,
                p,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        bindingAgg.set(st.name, st.aggName);
        mutated = true;
        break;
      }
      case "repo-let": {
        const repo = reposByName.get(st.repoName);
        if (!repo) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-repository",
            message: diagMessage("loom.workflow-unknown-repository", {
              name: wf.name,
              repoName: st.repoName,
              method: st.method,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (st.method !== "getById" && !repo.finds.some((f) => f.name === st.method)) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-repository-method",
            message: diagMessage("loom.workflow-unknown-repository-method", {
              name: wf.name,
              repoName: st.repoName,
              method: st.method,
              finds: repo.finds.map((f) => f.name).join(", ") || "(no declared finds)",
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // A workflow can't call a find whose where clause references
        // currentUser — the workflow handler doesn't inject
        // ICurrentUserAccessor, and threading the user through saves +
        // ops would be a larger reshape.  Surface a friendly error
        // pointing at the alternative (load by id).
        const calledFind = repo.finds.find((f) => f.name === st.method);
        if (calledFind && findUsesCurrentUser(calledFind)) {
          diags.push({
            severity: "error",
            code: "loom.workflow-currentuser-find",
            message: diagMessage("loom.workflow-currentuser-find", {
              name: wf.name,
              repoName: st.repoName,
              method: st.method,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // Reject array / nullable returns — workflow body has no
        // iteration / null-handling vocab in v1.  getById is always
        // a single non-nullable aggregate (the impl throws on miss).
        if (st.method !== "getById") {
          if (st.returnType.kind === "array") {
            diags.push({
              severity: "error",
              code: "loom.workflow-load-array-unsupported",
              message: diagMessage("loom.workflow-load-array-unsupported", {
                name: wf.name,
                repoName: st.repoName,
                method: st.method,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          if (st.returnType.kind === "optional") {
            diags.push({
              severity: "error",
              code: "loom.workflow-load-nullable-unsupported",
              message: diagMessage("loom.workflow-load-nullable-unsupported", {
                name: wf.name,
                repoName: st.repoName,
                method: st.method,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
        }
        bindingAgg.set(st.name, st.aggName);
        break;
      }
      case "repo-run": {
        // `let xs = Repo.findAll(<Criterion>, page?)` (criterion.md, use
        // site 3) lowered to a `synthCriterion`-marked repo-run.  Validate the
        // criterion directly (clear errors before the enrich-synthesised
        // `findAllBy<Criterion>` retrieval would otherwise mislead the generic
        // run checks below), then record the array binding and stop.
        if (st.synthCriterion) {
          const repo = reposByName.get(st.repoName);
          if (!repo) {
            diags.push({
              severity: "error",
              code: "loom.workflow-run-unknown-repository",
              message: diagMessage(
                "loom.workflow-run-unknown-repository#workflow-a-criterion-query",
                { name: wf.name, repoName: st.repoName },
              ),
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          const critName = st.synthCriterion.name;
          const crit = ctx.criteria.find((c) => c.name === critName);
          if (!crit) {
            diags.push({
              severity: "error",
              code: "loom.findall-unknown-criterion",
              message: diagMessage("loom.findall-unknown-criterion", {
                name: wf.name,
                repoName: st.repoName,
                critName,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          const candidate = crit.targetType.kind === "entity" ? crit.targetType.name : "";
          if (candidate !== st.aggName) {
            diags.push({
              severity: "error",
              code: "loom.findall-criterion-mismatch",
              message: diagMessage("loom.findall-criterion-mismatch", {
                name: wf.name,
                critName,
                candidate: candidate || "bool",
                repoName: st.repoName,
                aggName: st.aggName,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          if (st.retrievalArgs.length !== crit.params.length) {
            diags.push({
              severity: "error",
              code: "loom.findall-criterion-arity",
              message: diagMessage("loom.findall-criterion-arity", {
                name: wf.name,
                critName,
                length: crit.params.length,
                repoName: st.repoName,
                retrievalArgsLength: st.retrievalArgs.length,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          if (!st.page) {
            diags.push({
              severity: "warning",
              code: "loom.findall-no-page",
              message: diagMessage("loom.findall-no-page", {
                name: wf.name,
                critName,
                repoName: st.repoName,
              }),
              source: `${ctx.name}/${wf.name}`,
            });
          }
          arrayBindingAgg.set(st.name, st.aggName);
          break;
        }
        // `let xs = Repo.run(<Retrieval>(args), page?)` — the bound
        // result is an aggregate array, consumable only by a `for-each`.
        const repo = reposByName.get(st.repoName);
        if (!repo) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-unknown-repository",
            message: diagMessage("loom.workflow-run-unknown-repository#workflow-run-references", {
              name: wf.name,
              repoName: st.repoName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const retrieval = ctx.retrievals.find((r) => r.name === st.retrievalName);
        if (!retrieval) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-unknown-retrieval",
            message: diagMessage("loom.workflow-run-unknown-retrieval", {
              name: wf.name,
              repoName: st.repoName,
              retrievalName: st.retrievalName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const target = retrieval.targetType.kind === "entity" ? retrieval.targetType.name : "";
        if (target !== st.aggName) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-retrieval-mismatch",
            message: diagMessage("loom.workflow-run-retrieval-mismatch", {
              name: wf.name,
              retrievalName: st.retrievalName,
              target,
              repoName: st.repoName,
              aggName: st.aggName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
        }
        // Record the array binding so a `for-each` over it resolves the
        // element aggregate.
        arrayBindingAgg.set(st.name, st.aggName);
        break;
      }
      case "for-each": {
        // The iterable must be an aggregate array (today: a `repo-run`
        // result).  Bind the loop var to the element aggregate so body
        // op-calls resolve, then validate the body op-calls.
        // The iterable should be a `repo-run` array binding (the only
        // aggregate-array producer in v1).  A bare `ref` to such a
        // binding is the supported shape.
        const iterableBinding = st.iterable.kind === "ref" ? st.iterable.name : undefined;
        const isArrayBinding = iterableBinding ? arrayBindingAgg.has(iterableBinding) : false;
        if (st.varAggName === "Unknown" || !isArrayBinding) {
          diags.push({
            severity: "error",
            code: "loom.workflow-foreach-source",
            message: diagMessage("loom.workflow-foreach-source", { name: wf.name, var: st.var }),
            source: `${ctx.name}/${wf.name}`,
          });
        }
        bindingAgg.set(st.var, st.varAggName);
        for (const inner of st.body) {
          if (inner.kind === "op-call") {
            mutated = true;
            if (!bindingAgg.get(inner.target)) {
              diags.push({
                severity: "error",
                code: "loom.workflow-foreach-unknown-binding",
                message: diagMessage(
                  "loom.workflow-foreach-unknown-binding#workflow-in-for-references",
                  { name: wf.name, var: st.var, target: inner.target, op: inner.op },
                ),
                source: `${ctx.name}/${wf.name}`,
              });
            }
          }
        }
        break;
      }
      case "if-let": {
        // `if let <var> = Repo.find(<Criterion>) { … } else { … }`
        // (criterion.md, use site 3).  Validate the criterion query (the same
        // checks as the repo-run/findAll path; no page warning — a single
        // result is never paginated), then shallow-check the branch op-call
        // bindings the way `for-each` does.  `var` is in scope only in the
        // then-branch.
        if (!st.synthCriterion.name) {
          diags.push({
            severity: "error",
            code: "loom.iflet-bad-source",
            message: diagMessage("loom.iflet-bad-source", { name: wf.name, var: st.var }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const repo = reposByName.get(st.repoName);
        if (!repo) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-unknown-repository",
            message: diagMessage(
              "loom.workflow-run-unknown-repository#workflow-a-criterion-query",
              { name: wf.name, repoName: st.repoName },
            ),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const critName = st.synthCriterion.name;
        const crit = ctx.criteria.find((c) => c.name === critName);
        if (!crit) {
          diags.push({
            severity: "error",
            code: "loom.findall-unknown-criterion",
            message: diagMessage("loom.findall-unknown-criterion", {
              name: wf.name,
              repoName: st.repoName,
              critName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const candidate = crit.targetType.kind === "entity" ? crit.targetType.name : "";
        if (candidate !== st.aggName) {
          diags.push({
            severity: "error",
            code: "loom.findall-criterion-mismatch",
            message: diagMessage("loom.findall-criterion-mismatch", {
              name: wf.name,
              critName,
              candidate: candidate || "bool",
              repoName: st.repoName,
              aggName: st.aggName,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (st.retrievalArgs.length !== crit.params.length) {
          diags.push({
            severity: "error",
            code: "loom.findall-criterion-arity",
            message: diagMessage("loom.findall-criterion-arity", {
              name: wf.name,
              critName,
              length: crit.params.length,
              repoName: st.repoName,
              retrievalArgsLength: st.retrievalArgs.length,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const checkBranchOpCalls = (body: WorkflowStmtIR[]): void => {
          // A `let` declared INSIDE the branch binds for the rest of that
          // branch.  Registering it here is what makes
          //
          //     if let o = Orders.find(C) { let cu = Customers.getById(x)  cu.touch() }
          //
          // legal — the emitters already walk into the branch bodies and inject
          // the repository for exactly this shape (dotnet-workflow-repo-find's
          // "injects a repository first used inside an if-let branch body"), so
          // without it the validator refused a form every backend emits.
          const branchLocal: string[] = [];
          for (const inner of body) {
            if (inner.kind === "op-call") {
              mutated = true;
              if (!bindingAgg.get(inner.target)) {
                diags.push({
                  severity: "error",
                  code: "loom.workflow-foreach-unknown-binding",
                  message: diagMessage(
                    "loom.workflow-foreach-unknown-binding#workflow-in-if-let-references",
                    { name: wf.name, var: st.var, target: inner.target, op: inner.op },
                  ),
                  source: `${ctx.name}/${wf.name}`,
                });
              }
            } else if (inner.kind === "emit" || inner.kind === "factory-let") {
              mutated = true;
            }
            if (
              (inner.kind === "repo-let" || inner.kind === "factory-let") &&
              !bindingAgg.has(inner.name)
            ) {
              bindingAgg.set(inner.name, inner.aggName);
              branchLocal.push(inner.name);
            }
          }
          for (const n of branchLocal) bindingAgg.delete(n);
        };
        bindingAgg.set(st.var, st.aggName); // `var` bound only in the then-branch
        checkBranchOpCalls(st.thenBody);
        bindingAgg.delete(st.var);
        checkBranchOpCalls(st.elseBody ?? []);
        break;
      }
      case "op-call": {
        const aggName = bindingAgg.get(st.target);
        if (!aggName) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-binding",
            message: diagMessage("loom.workflow-unknown-binding", {
              name: wf.name,
              target: st.target,
              op: st.op,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const agg = aggsByName.get(aggName);
        if (!agg) break;
        const op = agg.operations.find((o) => o.name === st.op);
        if (!op) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-operation",
            message: diagMessage("loom.workflow-unknown-operation", {
              name: wf.name,
              aggName,
              op: st.op,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (op.visibility === "private") {
          diags.push({
            severity: "error",
            code: "loom.workflow-private-operation",
            message: diagMessage("loom.workflow-private-operation", {
              name: wf.name,
              aggName,
              opName: op.name,
            }),
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // (No restriction on extern ops — workflows can call
        // parameterless and parameterized externs alike.  The
        // emission paths construct the wire-typed request from the
        // workflow's domain args via `domainToRequestExpr` (.NET) /
        // a per-VO object-literal projection (TS).)
        mutated = true;
        break;
      }
      case "repo-delete":
        // `<Repo>.delete(o)` — a repository DELETE is a persistence mutation, so
        // it satisfies a `transactional` workflow's effect requirement.
        mutated = true;
        break;
      case "assign":
        // `field := value` / `field += value` / `field -= value` — own-state
        // mutation onto the workflow's own `Property` state.  Recognised forms:
        // the plain `:=` and the SCALAR compound `+=`/`-=` both lower here (the
        // compound RHS is rewritten to a `binary` over the current value).
        // Cross-aggregate writes and COLLECTION compound mutations never reach
        // here — they stay `__bad__`.  The write is an effect, so a
        // `transactional` workflow with only a (compound) assign is valid.
        if (wf.eventSourced) {
          // An event-sourced workflow's state is derived only by folding its
          // own emitted events (the appliers) — a direct write (`:=`/`+=`/`-=`)
          // would bypass the event log.  Mutate state by `emit` + an `apply`
          // clause instead.
          diags.push({
            severity: "error",
            code: "loom.workflow-eventsourced-assign",
            message: diagMessage("loom.workflow-eventsourced-assign", {
              name: wf.name,
              segments: st.target.segments.join("."),
            }),
            source: `${ctx.name}/${wf.name}`,
          });
        }
        mutated = true;
        break;
      case "expr-let": {
        if (st.name === "__bad__") {
          diags.push({
            severity: "error",
            code: "loom.workflow-unrecognised-statement",
            message: diagMessage("loom.workflow-unrecognised-statement", { name: wf.name }),
            source: `${ctx.name}/${wf.name}`,
          });
        }
        // `let x = files.get(k)` — the bound form of a resource-op.
        checkResourceOpExpr(st.expr, ctx, wf, diags);
        break;
      }
      case "resource-call":
        checkResourceOpExpr(st.call, ctx, wf, diags);
        break;
    }
  }

  if (wf.transactional && !mutated) {
    diags.push({
      severity: "warning",
      code: "loom.transactional-no-effect",
      message: diagMessage("loom.transactional-no-effect", { name: wf.name }),
      source: `${ctx.name}/${wf.name}`,
    });
  }

  // Defence-in-depth: the grammar already gates the isolation level
  // behind the `transactional` keyword, but if a future grammar
  // change drops the gating we'd silently accept a meaningless
  // setting.  Surface it as an error here too.
  if (wf.isolation && !wf.transactional) {
    diags.push({
      severity: "error",
      code: "loom.isolation-requires-transactional",
      message: diagMessage("loom.isolation-requires-transactional", {
        name: wf.name,
        isolation: wf.isolation,
      }),
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// Validate a resource-op call expression in a workflow body (Phase 4):
//   - the verb must belong to the resource's kind vocabulary
//     (lowering leaves `capability === ""` on an unknown verb);
//   - a resource-op may not run inside a transactional span — an S3
//     `put` can't roll back with the DB transaction (use the outbox).
// The capability-gap check (need ⊆ sourceType) is handled by
// `validateNeedCapabilities`, which consumes the usage-derived needs.
function checkResourceOpExpr(
  expr: import("../../types/loom-ir.js").ExprIR,
  ctx: BoundedContextIR,
  wf: { name: string; transactional: boolean },
  diags: LoomDiagnostic[],
): void {
  if (expr.kind !== "call" || expr.callKind !== "resource-op" || !expr.resourceOp) return;
  const op = expr.resourceOp;
  if (op.capability === "") {
    diags.push({
      severity: "error",
      code: "loom.resource-verb-invalid",
      message: diagMessage("loom.resource-verb-invalid", {
        name: wf.name,
        resourceName: op.resourceName,
        verb: op.verb,
        resourceKind: op.resourceKind,
        resourceKind2: verbsForKind(op.resourceKind).join(", ") || "(none)",
      }),
      source: `${ctx.name}/${wf.name}`,
    });
  }
  if (wf.transactional) {
    diags.push({
      severity: "error",
      code: "loom.resource-op-in-transaction",
      message: diagMessage("loom.resource-op-in-transaction", {
        name: wf.name,
        resourceName: op.resourceName,
        verb: op.verb,
      }),
      source: `${ctx.name}/${wf.name}`,
    });
  }
}
