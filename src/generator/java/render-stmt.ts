import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/types/loom-ir.js";
import { escapeJavaIdent } from "../../util/naming.js";
import { collectLeaves } from "../_stmt/leaves.js";
import { collectJavaExprImports, type JavaRenderContext, renderJavaExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Statement renderer for the Java / Spring backend.  Flat dispatch over
// the StmtIR kinds (deliberately per-backend, like every render-stmt).
// Bodies render inside aggregate methods at two indent levels.
// ---------------------------------------------------------------------------

const INDENT = "        ";
const DEFAULT_CTX: JavaRenderContext = { thisName: "this" };

/** Compile-time --trace context — mirrors render-stmt.ts on the C# side.
 *  When `emitTrace` is false the renderer is byte-identical to its
 *  pre-trace output. */
export interface JavaTraceCtx {
  emitTrace: boolean;
  aggregate: string;
  op: string;
  /** True when rendering a body on an event-sourced aggregate: `emit`
   *  records the event AND folds it via `_apply(ev)` so in-memory state
   *  reflects the transition before the command returns. */
  eventSourced?: boolean;
}

const NO_TRACE: JavaTraceCtx = { emitTrace: false, aggregate: "", op: "" };

export function renderJavaStatements(
  stmts: StmtIR[],
  ctx: JavaRenderContext = DEFAULT_CTX,
  traceCtx: JavaTraceCtx = NO_TRACE,
): string {
  return renderJavaStatementChunks(stmts, ctx, traceCtx).join("\n");
}

/** Same rendering as `renderJavaStatements`, but one (possibly multi-line)
 *  string per statement instead of the pre-joined whole — exactly the map
 *  `renderJavaStatements` joins with `"\n"` today, so `chunks.join("\n")` is
 *  byte-identical to it.  Lets a caller that owns the final file content
 *  (the entity emitter) recover each statement's own line span inside an
 *  operation body for `SourceMapRecorder.fragment` — see
 *  `statementSubRegions` (re-exported below). */
export function renderJavaStatementChunks(
  stmts: StmtIR[],
  ctx: JavaRenderContext = DEFAULT_CTX,
  traceCtx: JavaTraceCtx = NO_TRACE,
): string[] {
  return stmts.map((s, i) => renderJavaStatement(s, i, ctx, traceCtx));
}

// `statementSubRegions` lives in src/generator/_trace/sourcemap.ts — it's
// origin-generic (works for any statement IR carrying `origin?`), so every
// backend's chunk-producing renderer shares the one cursor walk. Re-exported
// here so call sites can import it alongside the chunk renderer.
export { statementSubRegions } from "../_trace/sourcemap.js";

/** Imports a statement body needs — the union of
 *  `collectJavaExprImports` over every rendered expression. */
export function collectJavaStmtImports(
  stmts: StmtIR[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const s of stmts) {
    switch (s.kind) {
      case "precondition":
      case "requires":
      case "let":
      case "expression":
        collectJavaExprImports(s.expr, into);
        break;
      case "assign":
      case "add":
      case "remove":
      case "return":
        collectJavaExprImports(s.value, into);
        break;
      case "emit":
        for (const f of s.fields) collectJavaExprImports(f.value, into);
        break;
      case "call":
        for (const a of s.args) collectJavaExprImports(a, into);
        break;
    }
  }
  return into;
}

function renderJavaStatement(
  s: StmtIR,
  index: number,
  ctx: JavaRenderContext,
  traceCtx: JavaTraceCtx,
): string {
  switch (s.kind) {
    case "precondition":
      return precondition(s.expr, s.source, index, ctx, traceCtx);
    case "requires":
      // Authorization gate — ForbiddenException maps to 403 in the
      // controller advice.
      return `${INDENT}if (!(${renderJavaExpr(s.expr, ctx)})) throw new ForbiddenException(${JSON.stringify(`Forbidden: ${s.source}`)});`;
    case "let":
      // `let`-names may collide with a Java keyword; escape consistently with
      // the matching `refKind: "let"` use sites (`let class` → `class_`).
      return `${INDENT}var ${escapeJavaIdent(s.name)} = ${renderJavaExpr(s.expr, ctx)};`;
    case "assign": {
      const base = `${INDENT}${renderPath(s.target)} = ${renderJavaExpr(s.value, ctx)};`;
      return withProvCapture(
        withValueComputed(base, s.target, traceCtx),
        s.prov,
        s.target,
        s.value,
        index,
        ctx,
      );
    }
    case "add": {
      const base = `${INDENT}${renderPath(s.target)}.add(${renderJavaExpr(s.value, ctx)});`;
      return withProvCapture(base, s.prov, s.target, s.value, index, ctx);
    }
    case "remove": {
      const base = `${INDENT}${renderPath(s.target)}.remove(${renderJavaExpr(s.value, ctx)});`;
      return withProvCapture(base, s.prov, s.target, s.value, index, ctx);
    }
    case "emit": {
      const args = orderedEventArgs(s, ctx);
      if (traceCtx.eventSourced) {
        return `${INDENT}{ var __ev = new ${s.eventName}(${args}); this._domainEvents.add(__ev); this._apply(__ev); }`;
      }
      return `${INDENT}this._domainEvents.add(new ${s.eventName}(${args}));`;
    }
    case "call": {
      const args = s.args.map((a) => renderJavaExpr(a, ctx)).join(", ");
      return `${INDENT}this.${s.name}(${args});`;
    }
    case "expression":
      return `${INDENT}${renderJavaExpr(s.expr, ctx)};`;
    case "return": {
      // Exception-less tagged return → the domain union's variant record
      // `<Union>_<Tag>(…)`, args ordered by the variant's declared field
      // order.  Untagged returns render the value as-is.
      if (!s.variantTag || !ctx.returnUnion) {
        return `${INDENT}return ${renderJavaExpr(s.value, ctx)};`;
      }
      const variant = `${ctx.returnUnion.name}_${s.variantTag}`;
      if (s.variantShape === "none") return `${INDENT}return new ${variant}();`;
      if (s.variantShape === "scalar") {
        return `${INDENT}return new ${variant}(${renderJavaExpr(s.value, ctx)});`;
      }
      const member = ctx.returnUnion.members.find((m) => m.tag === s.variantTag);
      const objFields = s.value.kind === "object" ? s.value.fields : [];
      const order = member && member.shape === "record" ? member.fields : [];
      const args = order.map((mf) => {
        const f = objFields.find((of) => of.name === mf.name);
        return f ? renderJavaExpr(f.value, ctx) : "null";
      });
      return `${INDENT}return new ${variant}(${args.join(", ")});`;
    }
    case "variant-match":
      // Frontend-only effect statement (Stage 2) — gated to action bodies.
      throw new Error(
        "variant-match statement is frontend-only; it must not reach the Java backend",
      );
  }
}

/** Java events are records with positional constructors — order the emit
 *  site's `name: value` pairs by the event's declared field order
 *  (`ctx.eventFields`), falling back to emit-site order when the entity
 *  emitter didn't thread the map (synthetic contexts). */
function orderedEventArgs(s: Extract<StmtIR, { kind: "emit" }>, ctx: JavaRenderContext): string {
  const declared = ctx.eventFields?.get(s.eventName);
  const rendered = new Map(s.fields.map((f) => [f.name, renderJavaExpr(f.value, ctx)]));
  if (!declared) return [...rendered.values()].join(", ");
  return declared.map((name) => rendered.get(name) ?? "null").join(", ");
}

/** Trace-off: the one-liner throw.  Trace-on: bind the boolean so both
 *  outcomes log before the conditional throw (catalog
 *  `precondition_evaluated`). */
function precondition(
  expr: ExprIR,
  source: string,
  index: number,
  ctx: JavaRenderContext,
  traceCtx: JavaTraceCtx,
): string {
  const thrown = `throw new DomainException(${JSON.stringify(`Precondition failed: ${source}`)})`;
  if (!traceCtx.emitTrace) {
    return `${INDENT}if (!(${renderJavaExpr(expr, ctx)})) ${thrown};`;
  }
  const ok = `__pre_${index}_ok`;
  return [
    `${INDENT}var ${ok} = (${renderJavaExpr(expr, ctx)});`,
    `${INDENT}DomainLog.trace("precondition_evaluated", "${traceCtx.aggregate}", "${traceCtx.op}", ${JSON.stringify(source)}, ${ok});`,
    `${INDENT}if (!${ok}) ${thrown};`,
  ].join("\n");
}

/** Under --trace, append a `value_computed` line after a scalar assign. */
function withValueComputed(base: string, target: PathIR, traceCtx: JavaTraceCtx): string {
  if (!traceCtx.emitTrace) return base;
  if (target.segments.length !== 1) return base;
  const field = target.segments[0]!;
  return [
    base,
    `${INDENT}DomainLog.traceValue("value_computed", "${traceCtx.aggregate}", "${field}", ${renderPath(target)});`,
  ].join("\n");
}

/** Wrap a provenanced write (a statement carrying a `ProvSite`) with lineage
 *  capture — the Java mirror of the Hono `withTrace` / .NET `withProvCapture`.
 *  Snapshot the leaf inputs *before* the mutation (so a self-referential
 *  `x := x + n` records the pre-write value), perform the write, then build the
 *  `ProvLineage` (rule snapshot + inputs + post-write computed value) and route
 *  it to both sinks: the co-located `<field>Provenance` field (current lineage,
 *  persisted on the row) and the per-instance `_provTraces` buffer (drained
 *  into provenance_records by the repository inside the save transaction). */
function withProvCapture(
  base: string,
  prov: ProvSite | undefined,
  target: PathIR,
  value: ExprIR,
  index: number,
  ctx: JavaRenderContext,
): string {
  if (!prov) return base;
  // Co-located capture is for top-level provenanced fields of the aggregate
  // root (the `<field>Provenance` field + `_provTraces` buffer live on the
  // root).  A write-through into a containment (segments.length > 1) carries no
  // co-located slot — skip, mirroring the value-computed trace's same guard.
  if (target.segments.length !== 1) return base;
  const inputs = collectLeaves(value, (x) => renderJavaExpr(x, ctx))
    .map((l) => `new ProvInput(${JSON.stringify(l.path)}, ${l.value})`)
    .join(", ");
  const tmp = `__prov_${index}`;
  const lin = `__lin_${index}`;
  const computed = renderPath(target);
  const field = `${prov.target.field}Provenance`;
  const targetLit = `new ProvTarget(${JSON.stringify(prov.target.type)}, ${JSON.stringify(prov.target.field)})`;
  return [
    `${INDENT}var ${tmp} = java.util.List.<ProvInput>of(${inputs});`,
    base,
    `${INDENT}var ${lin} = new ProvLineage(${JSON.stringify(prov.snapshotId)}, ${targetLit}, ${tmp}, ${computed});`,
    `${INDENT}this.${field} = ${lin};`,
    `${INDENT}this._provTraces.add(${lin});`,
  ].join("\n");
}

/** Mutation paths read/write fields directly — generated domain classes
 *  keep fields package-private precisely so the aggregate can write
 *  through its containments (`this.profile.bio = …`).  `this.` prefixes
 *  the head so operation params can't shadow the field. */
function renderPath(p: PathIR): string {
  return `this.${p.segments.join(".")}`;
}
