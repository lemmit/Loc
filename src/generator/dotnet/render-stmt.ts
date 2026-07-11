import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/types/loom-ir.js";
import { escapeCsharpIdent, upperFirst } from "../../util/naming.js";
import { collectLeaves } from "../_stmt/leaves.js";
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
  return renderCsStatementChunks(stmts, ctx, traceCtx).join("\n");
}

/** Same rendering as `renderCsStatements`, but one (possibly multi-line)
 *  string per statement instead of the pre-joined whole — exactly the map
 *  `renderCsStatements` joins with `"\n"` today, so `chunks.join("\n")` is
 *  byte-identical to it.  Lets a caller that owns the final file content
 *  (the .NET entity emitter) recover each statement's own line span inside
 *  an operation body for `SourceMapRecorder.fragment` — see
 *  `statementSubRegions` (re-exported below). */
export function renderCsStatementChunks(
  stmts: StmtIR[],
  ctx: CsRenderContext = DEFAULT_CTX,
  traceCtx: TraceCtx = NO_TRACE,
): string[] {
  return stmts.map((s, i) => renderCsStatement(s, i, ctx, traceCtx));
}

// `statementSubRegions` lives in src/generator/_trace/sourcemap.ts —
// origin-generic (works for any statement IR carrying `origin?`), so every
// backend's chunk-producing renderer shares the one cursor walk.  Re-exported
// here so call sites in this backend's emitters can import it alongside
// `renderCsStatementChunks` from a single module.
export { statementSubRegions } from "../_trace/sourcemap.js";

/** Namespaces a statement body reaches into beyond the SDK's implicit
 *  usings — the union of `collectCsExprUsings` over every expression
 *  these statements render through `renderCsExpr`.  Mirrors the
 *  per-kind expression set of `renderCsStatement`. */
export function collectCsStmtUsings(
  stmts: StmtIR[],
  into: Set<string> = new Set(),
  /** Forwarded to `collectCsExprUsings` so a domain-service call in any
   *  statement body adds `${ns}.Domain.Services`.  Omitted ⇒ no such using. */
  ns?: string,
): Set<string> {
  for (const s of stmts) {
    switch (s.kind) {
      case "precondition":
      case "requires":
      case "let":
      case "expression":
        collectCsExprUsings(s.expr, into, ns);
        break;
      case "assign":
      case "add":
      case "remove":
      case "return":
        collectCsExprUsings(s.value, into, ns);
        break;
      case "emit":
        for (const f of s.fields) collectCsExprUsings(f.value, into, ns);
        break;
      case "call":
        for (const a of s.args) collectCsExprUsings(a, into, ns);
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
      // `let`-names may collide with a C# keyword (`let base = …` → `var
      // @base`); the same escape applies at every `refKind: "let"` use site.
      return `${INDENT}var ${escapeCsharpIdent(s.name)} = ${renderCsExpr(s.expr, ctx)};`;
    case "assign": {
      const base = `${INDENT}${renderPath(s.target)} = ${renderCsExpr(s.value, ctx)};`;
      const traced = withValueComputed(base, s.target, traceCtx);
      return withProvCapture(traced, s.prov, s.target, s.value, index, ctx);
    }
    case "add": {
      const base = `${INDENT}${renderPrivatePath(s.target, ctx)}.Add(${renderCsExpr(s.value, ctx)});`;
      return withProvCapture(base, s.prov, s.target, s.value, index, ctx);
    }
    case "remove": {
      const base = `${INDENT}${renderPrivatePath(s.target, ctx)}.Remove(${renderCsExpr(s.value, ctx)});`;
      return withProvCapture(base, s.prov, s.target, s.value, index, ctx);
    }
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
    case "variant-match":
      // Frontend-only effect statement (Stage 2) — gated to action bodies.
      throw new Error(
        "variant-match statement is frontend-only; it must not reach the .NET backend",
      );
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

/** Wrap a provenanced write (a statement carrying a `ProvSite`) with lineage
 *  capture — the .NET mirror of the Hono `withTrace`.  Snapshot the leaf
 *  inputs *before* the mutation (so a self-referential `x := x + n` records the
 *  pre-write value), perform the write, then build the `ProvLineage` (rule
 *  snapshot + inputs + post-write computed value) and route it to both sinks:
 *  the co-located `<Field>Provenance` property (current lineage, persisted on
 *  the row) and the per-instance `_provTraces` buffer (drained into
 *  provenance_records by the repository inside the save transaction). */
function withProvCapture(
  base: string,
  prov: ProvSite | undefined,
  target: PathIR,
  value: ExprIR,
  index: number,
  ctx: CsRenderContext,
): string {
  if (!prov) return base;
  // Co-located capture is for top-level provenanced fields of the aggregate
  // root (the `<Field>Provenance` property + `_provTraces` buffer live on the
  // root).  A write-through into a containment (segments.length > 1) targets a
  // sub-object, which carries no co-located lineage slot — skip, mirroring the
  // value-computed trace's same guard.
  if (target.segments.length !== 1) return base;
  const inputs = collectLeaves(value, (x) => renderCsExpr(x, ctx))
    .map((l) => `new ProvInput(${JSON.stringify(l.path)}, ${l.value})`)
    .join(", ");
  const tmp = `__prov_${index}`;
  const lin = `__lin_${index}`;
  const computed = renderPath(target);
  const field = `${upperFirst(prov.target.field)}Provenance`;
  const targetLit = `new ProvTarget(${JSON.stringify(prov.target.type)}, ${JSON.stringify(prov.target.field)})`;
  return [
    `${INDENT}var ${tmp} = new List<ProvInput> { ${inputs} };`,
    base,
    `${INDENT}var ${lin} = new ProvLineage(${JSON.stringify(prov.snapshotId)}, ${targetLit}, ${tmp}, ${computed});`,
    `${INDENT}this.${field} = ${lin};`,
    `${INDENT}this._provTraces.Add(${lin});`,
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
