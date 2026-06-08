import type { ExprIR, PathIR, StmtIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import type { CsRenderContext } from "./render-expr.js";
import { collectCsExprUsings, renderCsExpr } from "./render-expr.js";

const INDENT = "        ";
const DEFAULT_CTX: CsRenderContext = { thisName: "this" };

/** Compile-time --trace context — mirrors render-stmt.ts on the Hono
 *  side.  The catalog's `value_computed` and `precondition_evaluated`
 *  lines need the enclosing aggregate + op names, neither of which are
 *  on the per-statement IR.  Threaded through the renderer rather than
 *  re-discovered at each emission site.  When `emitTrace` is false the
 *  renderer behaves byte-identically to its pre-trace output. */
export interface TraceCtx {
  emitTrace: boolean;
  aggregate: string;
  op: string;
  /** True when rendering a body on an event-sourced (`persistedAs(eventLog)`)
   *  aggregate.  An `emit` then both records the event AND folds it via
   *  `_Apply(ev)` so the in-memory aggregate stays consistent for the
   *  command's response — the state transition the appliers own.  Off ⇒
   *  `emit` is byte-identical to the legacy notification-event add. */
  eventSourced?: boolean;
}

const NO_TRACE: TraceCtx = { emitTrace: false, aggregate: "", op: "" };

export function renderCsStatements(
  stmts: StmtIR[],
  ctx: CsRenderContext = DEFAULT_CTX,
  traceCtx: TraceCtx = NO_TRACE,
): string {
  return stmts.map((s, i) => renderCsStatement(s, i, ctx, traceCtx)).join("\n");
}

/** Namespaces a statement body reaches into beyond the SDK's implicit
 *  usings — the union of `collectCsExprUsings` over every expression
 *  these statements render through `renderCsExpr`.  Mirrors the
 *  per-kind expression set of `renderCsStatement`. */
export function collectCsStmtUsings(stmts: StmtIR[], into: Set<string> = new Set()): Set<string> {
  for (const s of stmts) {
    switch (s.kind) {
      case "precondition":
      case "requires":
      case "let":
      case "expression":
        collectCsExprUsings(s.expr, into);
        break;
      case "assign":
      case "add":
      case "remove":
      case "return":
        collectCsExprUsings(s.value, into);
        break;
      case "emit":
        for (const f of s.fields) collectCsExprUsings(f.value, into);
        break;
      case "call":
        for (const a of s.args) collectCsExprUsings(a, into);
        break;
    }
  }
  return into;
}

function renderCsStatement(
  s: StmtIR,
  index: number,
  ctx: CsRenderContext,
  traceCtx: TraceCtx,
): string {
  switch (s.kind) {
    case "precondition":
      return precondition(s.expr, s.source, index, ctx, traceCtx);
    case "requires":
      // Authorization gate — surfaces as 403 (handled by
      // DomainExceptionFilter mapping ForbiddenException → 403).
      return `${INDENT}if (!(${renderCsExpr(s.expr, ctx)})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${s.source}`)});`;
    case "let":
      return `${INDENT}var ${s.name} = ${renderCsExpr(s.expr, ctx)};`;
    case "assign": {
      const base = `${INDENT}${renderPath(s.target)} = ${renderCsExpr(s.value, ctx)};`;
      return withValueComputed(base, s.target, traceCtx);
    }
    case "add":
      return `${INDENT}${renderPrivatePath(s.target, ctx)}.Add(${renderCsExpr(s.value, ctx)});`;
    case "remove":
      return `${INDENT}${renderPrivatePath(s.target, ctx)}.Remove(${renderCsExpr(s.value, ctx)});`;
    case "emit": {
      const args = s.fields
        .map((f) => `${upperFirst(f.name)}: ${renderCsExpr(f.value, ctx)}`)
        .join(", ");
      // Event-sourced: record the event and fold it immediately, so the
      // aggregate's in-memory state reflects the transition before the
      // command returns (the applier is the only place state changes).
      if (traceCtx.eventSourced) {
        return `${INDENT}{ var __ev = new ${s.eventName}(${args}); _domainEvents.Add(__ev); _Apply(__ev); }`;
      }
      return `${INDENT}_domainEvents.Add(new ${s.eventName}(${args}));`;
    }
    case "call": {
      const args = s.args.map((a) => renderCsExpr(a, ctx)).join(", ");
      return `${INDENT}this.${upperFirst(s.name)}(${args});`;
    }
    case "expression":
      return `${INDENT}${renderCsExpr(s.expr, ctx)};`;
    case "return": {
      // Exception-less operation return (exception-less.md): a tagged return
      // constructs the Domain union's variant record `<Union>_<Tag>(...)`.  A
      // record variant orders its positional args by the variant's declared
      // field order (from `ctx.returnUnion.members`), looking each up by name in
      // the lowered object literal; a scalar wraps the single value; `none` is
      // the empty unit.  Untagged returns (plain value) render the value as-is.
      if (!s.variantTag || !ctx.returnUnion) {
        return `${INDENT}return ${renderCsExpr(s.value, ctx)};`;
      }
      const variant = `${ctx.returnUnion.name}_${s.variantTag}`;
      if (s.variantShape === "none") return `${INDENT}return new ${variant}();`;
      if (s.variantShape === "scalar") {
        return `${INDENT}return new ${variant}(${renderCsExpr(s.value, ctx)});`;
      }
      const member = ctx.returnUnion.members.find((m) => m.tag === s.variantTag);
      const objFields = s.value.kind === "object" ? s.value.fields : [];
      const order = member && member.shape === "record" ? member.fields : [];
      const args = order.map((mf) => {
        const f = objFields.find((of) => of.name === mf.name);
        return f ? renderCsExpr(f.value, ctx) : "default";
      });
      return `${INDENT}return new ${variant}(${args.join(", ")});`;
    }
  }
}

/** Render a precondition.  Trace-off: the one-liner throw.  Trace-on:
 *  bind the boolean to a temp so BOTH pass and fail outcomes log
 *  (precondition_evaluated) before the conditional throw fires off the
 *  same temp.  Pattern matches the Hono render-stmt.ts shape exactly. */
function precondition(
  expr: ExprIR,
  source: string,
  index: number,
  ctx: CsRenderContext,
  traceCtx: TraceCtx,
): string {
  const thrown = `throw new DomainException(${JSON.stringify(`Precondition failed: ${source}`)})`;
  if (!traceCtx.emitTrace) {
    return `${INDENT}if (!(${renderCsExpr(expr, ctx)})) ${thrown};`;
  }
  const ok = `__pre_${index}_ok`;
  return [
    `${INDENT}var ${ok} = (${renderCsExpr(expr, ctx)});`,
    `${INDENT}${ns_DomainLog}.LogTrace("{Event} aggregate={Aggregate} op={Op} expr={Expr} passed={Passed}", "precondition_evaluated", "${traceCtx.aggregate}", "${traceCtx.op}", ${JSON.stringify(source)}, ${ok});`,
    `${INDENT}if (!${ok}) ${thrown};`,
  ].join("\n");
}

/** Under --trace, append a `value_computed` trace line after a scalar
 *  assign so the post-write value is observable.  Skipped for paths
 *  into containments (length > 1) — those are write-through paths to
 *  a sub-object, not a top-level field of the aggregate. */
function withValueComputed(base: string, target: PathIR, traceCtx: TraceCtx): string {
  if (!traceCtx.emitTrace) return base;
  if (target.segments.length !== 1) return base;
  const field = target.segments[0]!;
  return [
    base,
    `${INDENT}${ns_DomainLog}.LogTrace("{Event} aggregate={Aggregate} field={Field} value={Value}", "value_computed", "${traceCtx.aggregate}", "${field}", ${renderPath(target)});`,
  ].join("\n");
}

// `DomainLog` is the static AsyncLocal accessor emitted under
// Domain/Common/ when --trace is on (see emit/domain-log.ts).  The
// trace-injected calls reference it unqualified — same-namespace
// (`<ns>.Domain.<Plural>`) → `<ns>.Domain.Common`.  C# resolves the
// unqualified `DomainLog.LogTrace(…)` via the entity file's `using
// <ns>.Domain.Common;` (which the entity emitter adds when emitTrace
// is on).
const ns_DomainLog = "DomainLog";

function renderPath(p: PathIR): string {
  return p.segments.map((s) => upperFirst(s)).join(".");
}

// For collection mutation we go via the private backing field —
// EXCEPT for `Id<T>[]` reference collections, which the entity
// emitter exposes as a writable `List<TargetId>` property (no `_`
// backing field; the public surface IS the mutable list).  Identifies
// ref-collections via `ctx.agg.associations`; falls back to the
// containment convention when there's no aggregate context.
function renderPrivatePath(p: PathIR, ctx?: CsRenderContext): string {
  if (p.segments.length === 0) return "this";
  const [head, ...tail] = p.segments;
  const isRefColl = !!ctx?.agg?.associations?.some((a) => a.fieldName === head);
  const headPath = isRefColl ? upperFirst(head!) : `_${head}`;
  return `${headPath}${tail.map((t) => `.${upperFirst(t)}`).join("")}`;
}
