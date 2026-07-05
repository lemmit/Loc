import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/types/loom-ir.js";
import type { OriginRef } from "../../ir/types/origin.js";
import { escapeTsIdent } from "../../util/naming.js";
import { renderTsExpr } from "./render-expr.js";

const INDENT = "    ";

/** Compile-time `--trace` context — the catalog's `value_computed` /
 *  `precondition_evaluated` lines need the enclosing aggregate + op
 *  names, neither of which are on the per-statement IR.  Threaded
 *  through the renderer rather than re-discovered at every emission
 *  site.  When `emitTrace` is false the renderer behaves byte-identically
 *  to its pre-trace output. */
export interface TraceCtx {
  emitTrace: boolean;
  aggregate: string;
  op: string;
  /** True when rendering a body on an event-sourced (`persistedAs(eventLog)`)
   *  aggregate.  An `emit` then both records the event AND folds it into
   *  state via `this._apply(ev)` so the in-memory aggregate stays consistent
   *  for the command's response — the state transition the appliers own.
   *  Off ⇒ `emit` is byte-identical to the legacy notification-event push. */
  eventSourced?: boolean;
}

const NO_TRACE: TraceCtx = { emitTrace: false, aggregate: "", op: "" };

/** When `emitProvenance` is true, instrumented write-sites (statements
 *  carrying a `prov` snapshot) build a `ProvLineage` and route it to the
 *  co-located backing field + the `_provTraces` history buffer.  When
 *  `traceCtx.emitTrace` is true (`--trace` switch), additionally inject
 *  `value_computed` after every scalar assign and `precondition_evaluated`
 *  before every precondition's throw. */
export function renderTsStatements(
  stmts: StmtIR[],
  emitProvenance = false,
  traceCtx: TraceCtx = NO_TRACE,
): string {
  return renderTsStatementChunks(stmts, emitProvenance, traceCtx).join("\n");
}

/** Same rendering as `renderTsStatements`, but one (possibly multi-line)
 *  string per statement instead of the pre-joined whole — exactly the map
 *  `renderTsStatements` joins with `"\n"` today, so `chunks.join("\n")` is
 *  byte-identical to it.  Lets a caller that owns the final file content
 *  (the Hono aggregate emitter) recover each statement's own line span
 *  inside an operation body for `SourceMapRecorder.fragment` — see
 *  `statementSubRegions` below. */
export function renderTsStatementChunks(
  stmts: StmtIR[],
  emitProvenance = false,
  traceCtx: TraceCtx = NO_TRACE,
): string[] {
  return stmts.map((s, i) => renderTsStatement(s, emitProvenance, i, traceCtx));
}

/** One `SourceMapRecorder.fragment` sub-region per statement, keyed to the
 *  chunk list `renderTsStatementChunks` produced from the SAME `stmts`
 *  array (same length, same order — one chunk per statement).  `rel` is a
 *  1-based inclusive line range relative to the fragment's own first line
 *  (`chunks.join("\n")`'s line 1); a statement with no `origin` (synthesized)
 *  is simply omitted — `fragment()` only ever records what it's given. */
export function statementSubRegions(
  stmts: readonly StmtIR[],
  chunks: readonly string[],
  construct: string,
): { rel: [number, number]; origin: OriginRef | undefined; construct?: string }[] {
  const regions: { rel: [number, number]; origin: OriginRef | undefined; construct?: string }[] =
    [];
  let cursor = 1;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const chunkLines = (chunk.match(/\n/g)?.length ?? 0) + 1;
    const origin = stmts[i]?.origin;
    if (origin) regions.push({ rel: [cursor, cursor + chunkLines - 1], origin, construct });
    cursor += chunkLines;
  }
  return regions;
}

function renderTsStatement(
  s: StmtIR,
  emitProvenance: boolean,
  index: number,
  traceCtx: TraceCtx,
): string {
  switch (s.kind) {
    case "precondition":
      return precondition(s.expr, s.source, index, traceCtx);
    case "requires":
      // Authorization gate — surfaces as 403 via the route-level
      // ForbiddenError catch in the per-aggregate routes file.
      return `${INDENT}if (!(${renderTsExpr(s.expr)})) throw new ForbiddenError(${JSON.stringify(`Forbidden: ${s.source}`)});`;
    case "let":
      // `let`-names may collide with a JS reserved word; escape consistently
      // with the matching `refKind: "let"` use sites (`let new` → `new_`).
      return `${INDENT}const ${escapeTsIdent(s.name)} = ${renderTsExpr(s.expr)};`;
    case "assign": {
      const base = `${INDENT}${renderPath(s.target)} = ${renderTsExpr(s.value)};`;
      const wrapped = withTrace(base, s.prov, s.target, s.value, emitProvenance, index);
      return withValueComputed(wrapped, s.target, traceCtx);
    }
    case "add": {
      const base = `${INDENT}${renderPath(s.target)}.push(${renderTsExpr(s.value)});`;
      return withTrace(base, s.prov, s.target, s.value, emitProvenance, index);
    }
    case "remove": {
      const path = renderPath(s.target);
      const value = renderTsExpr(s.value);
      const base = `${INDENT}{ const idx = ${path}.findIndex((e) => e === (${value})); if (idx >= 0) ${path}.splice(idx, 1); }`;
      return withTrace(base, s.prov, s.target, s.value, emitProvenance, index);
    }
    case "emit": {
      const fields = s.fields.map((f) => `${f.name}: ${renderTsExpr(f.value)}`).join(", ");
      const ev = `{ type: ${JSON.stringify(s.eventName)}, ${fields} }`;
      // Event-sourced: record the event and fold it immediately, so the
      // aggregate's in-memory state reflects the transition before the
      // command returns (the applier is the only place state changes).  The
      // explicit `Events.DomainEvent` annotation keeps the `type` tag a
      // string literal (a bare `const __ev = {…}` would widen it to `string`
      // and fail the discriminated-union push/apply).
      if (traceCtx.eventSourced) {
        return `${INDENT}{ const __ev: Events.DomainEvent = ${ev}; this._events.push(__ev); this._apply(__ev); }`;
      }
      return `${INDENT}this._events.push(${ev});`;
    }
    case "call": {
      const args = s.args.map((a) => renderTsExpr(a)).join(", ");
      return `${INDENT}this.${camelize(s.name)}(${args});`;
    }
    case "expression":
      return `${INDENT}${renderTsExpr(s.expr)};`;
    case "return": {
      // Tag the returned value with its union variant on the wire (producer):
      // a record variant flattens its fields beside `type`, a scalar wraps a
      // `value`, `none` is the bare unit.  An untagged return (no union) prints
      // the value verbatim.
      const v = renderTsExpr(s.value);
      if (!s.variantTag) return `${INDENT}return ${v};`;
      const tag = JSON.stringify(s.variantTag);
      const tagged =
        s.variantShape === "none"
          ? `{ type: ${tag} }`
          : s.variantShape === "scalar"
            ? `{ type: ${tag}, value: ${v} }`
            : `{ type: ${tag}, ...(${v}) }`;
      return `${INDENT}return ${tagged};`;
    }
    case "variant-match":
      // Frontend-only effect statement (`match await op() { … }`,
      // async-actions-and-effects.md Stage 2) — gated to page/component action
      // bodies, never lowered into a backend body.
      throw new Error("variant-match statement is frontend-only; it must not reach the TS backend");
  }
}

/** Render a precondition — plain throw when trace is off; under
 *  `--trace`, bind the boolean to a temp first so the result can be
 *  logged (both pass and fail) before the conditional throw. */
function precondition(expr: ExprIR, source: string, index: number, traceCtx: TraceCtx): string {
  const thrown = `throw new DomainError(${JSON.stringify(`Precondition failed: ${source}`)})`;
  if (!traceCtx.emitTrace) {
    return `${INDENT}if (!(${renderTsExpr(expr)})) ${thrown};`;
  }
  const ok = `__pre_${index}_ok`;
  return [
    `${INDENT}const ${ok} = (${renderTsExpr(expr)});`,
    `${INDENT}requestLog().trace({ event: "precondition_evaluated", aggregate: "${traceCtx.aggregate}", op: "${traceCtx.op}", expr: ${JSON.stringify(source)}, passed: ${ok} });`,
    `${INDENT}if (!${ok}) ${thrown};`,
  ].join("\n");
}

/** When `--trace` is on, append a `value_computed` trace line after a
 *  scalar assign so the post-write value is observable.  Skipped for
 *  paths into containments (length > 1) — those are write-through paths
 *  to a sub-object, not a top-level field of the aggregate. */
function withValueComputed(base: string, target: PathIR, traceCtx: TraceCtx): string {
  if (!traceCtx.emitTrace) return base;
  if (target.segments.length !== 1) return base;
  const field = target.segments[0];
  return [
    base,
    `${INDENT}requestLog().trace({ event: "value_computed", aggregate: "${traceCtx.aggregate}", field: "${field}", value: ${renderPath(target)} });`,
  ].join("\n");
}

/** Wrap a provenanced write with trace capture: snapshot the leaf inputs
 *  *before* the mutation (so self-referential writes like `x := x + n`
 *  record the pre-write value), perform the write, then build the lineage
 *  (rule snapshot + leaf inputs + post-write computed value) and route it
 *  to both sinks — the co-located `_<field>_provenance` backing field
 *  (current lineage, persisted on the row) and the per-instance
 *  `_provTraces` buffer (drained into the history table by the route
 *  handler inside the save transaction). */
function withTrace(
  base: string,
  prov: ProvSite | undefined,
  target: PathIR,
  value: ExprIR,
  emitProvenance: boolean,
  index: number,
): string {
  if (!emitProvenance || !prov) return base;
  const targetLit = JSON.stringify(prov.target);
  const inputs = collectLeaves(value)
    .map((l) => `{ path: ${JSON.stringify(l.path)}, value: ${l.value} }`)
    .join(", ");
  const tmp = `__prov_${index}`;
  const lin = `__lin_${index}`;
  const computed = renderPath(target);
  const field = prov.target.field;
  return [
    `${INDENT}const ${tmp} = [${inputs}];`,
    base,
    `${INDENT}const ${lin}: ProvLineage = { snapshotId: ${JSON.stringify(prov.snapshotId)}, target: ${targetLit}, inputs: ${tmp}, computedValue: ${computed} };`,
    `${INDENT}this._${field}_provenance = ${lin};`,
    `${INDENT}this._provTraces.push(${lin});`,
  ].join("\n");
}

/** Bounded walk over the RHS expression collecting leaf inputs —
 *  `this`-props, params and let-bindings (and member-access chains
 *  rooted at them).  Compound nodes recurse; lambdas are skipped (their
 *  bodies reference lambda-local params, not stored leaves). */
function collectLeaves(
  e: ExprIR,
  out: { path: string; value: string }[] = [],
): { path: string; value: string }[] {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: renderTsExpr(e) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: renderTsExpr(e) });
      break;
    case "method-call":
      collectLeaves(e.receiver, out);
      for (const a of e.args) collectLeaves(a, out);
      break;
    case "call":
      for (const a of e.args) collectLeaves(a, out);
      break;
    case "paren":
      collectLeaves(e.inner, out);
      break;
    case "unary":
      collectLeaves(e.operand, out);
      break;
    case "binary":
      collectLeaves(e.left, out);
      collectLeaves(e.right, out);
      break;
    case "ternary":
      collectLeaves(e.cond, out);
      collectLeaves(e.then, out);
      collectLeaves(e.otherwise, out);
      break;
    case "match":
      e.arms.forEach((a) => {
        collectLeaves(a.cond, out);
        collectLeaves(a.value, out);
      });
      if (e.otherwise) collectLeaves(e.otherwise, out);
      break;
    case "new":
    case "object":
      for (const f of e.fields) collectLeaves(f.value, out);
      break;
  }
  return out;
}

/** Dotted source-side path for a member-access chain (e.g. `line.price`). */
function leafPath(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "this") return "this";
  if (e.kind === "member") return `${leafPath(e.receiver)}.${e.member}`;
  return "<expr>";
}

function renderPath(p: PathIR): string {
  if (p.segments.length === 0) return "this";
  const [head, ...tail] = p.segments;
  return `this._${head}${tail.map((t) => `.${t}`).join("")}`;
}

function camelize(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}
