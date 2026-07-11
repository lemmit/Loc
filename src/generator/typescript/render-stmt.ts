import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/types/loom-ir.js";
import { escapeTsIdent } from "../../util/naming.js";
import { collectLeaves } from "../_stmt/leaves.js";
import type { ChunkMark } from "../_trace/sourcemap.js";
import { renderTsExpr, renderTsExprWithMarks } from "./render-expr.js";

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

// `statementSubRegions` moved to src/generator/_trace/sourcemap.ts once the
// statement-region bracket fanned out beyond Hono — it's origin-generic
// (works for any statement IR carrying `origin?`), so every backend's
// chunk-producing renderer shares the one cursor walk. Re-exported here so
// existing import sites keep working.
export { statementSubRegions } from "../_trace/sourcemap.js";

/** The expression-bearing sub-nodes marked for EVERY StmtIR kind
 *  (span-tracking-emission.md, M17 phase 7 slice 4 — widened from the
 *  `let`/`assign`/`return`-only narrowing of M15 phase 7 slice 2, which
 *  mirrored the .NET `#line` weave's own scope-6a narrowing).  Each
 *  returned expr is anchored INDEPENDENTLY in `statementExprMarks` below —
 *  a multi-expr kind (`call`'s args, `emit`'s field values) doesn't let one
 *  ambiguous/missing sibling suppress the rest; two siblings that render to
 *  IDENTICAL text still naturally skip each other, since the shared
 *  one-occurrence `indexOf` anchor can't tell them apart (the same honesty
 *  rule the single-expr case already followed). `variant-match` is
 *  frontend-only (never reaches the TS backend, see `renderTsStatement`'s
 *  `default` throw) and any future unhandled kind both fall through to
 *  `[]`. */
function markableExprsOf(s: StmtIR): ExprIR[] {
  switch (s.kind) {
    case "precondition":
    case "requires":
      return [s.expr];
    case "let":
      return [s.expr];
    case "assign":
    case "return":
      return [s.value];
    case "add":
    case "remove":
      return [s.value];
    case "expression":
      return [s.expr];
    case "call":
      return s.args;
    case "emit":
      return s.fields.map((f) => f.value);
    default:
      return [];
  }
}

/** Expression-level marks for ONE already-rendered statement chunk — the
 *  marks-carrying sibling to `renderTsStatementChunks`
 *  (span-tracking-emission.md, M15 phase 7 slice 2; widened to every
 *  expression-bearing kind in M17 phase 7 slice 4).  Renders EACH of the
 *  statement's markable expressions (`markableExprsOf` above) a SECOND time
 *  through `renderTsExprWithMarks` (the level-wise mark composer,
 *  `src/generator/_expr/target.ts`), then locates that rendered text inside
 *  the ALREADY-rendered `chunk` via the same one-occurrence anchor
 *  discipline `SourceMapRecorder.fragment` uses: absent or ambiguous ⇒ an
 *  honest skip for THAT expr (no marks from it), not a guess — the same
 *  fragment() honesty every other source-map region in this codebase
 *  already follows (e.g. a provenance/trace-wrapped chunk that repeats the
 *  RHS text in its `__prov_N` snapshot array skips here for exactly that
 *  reason; a traced precondition's `__pre_N_ok` binding line is exactly the
 *  same shape — anchor there or skip, never guess). Each expr anchors
 *  independently of its siblings — one ambiguous/absent expr doesn't
 *  suppress marks from the rest of the list; the results are simply
 *  concatenated. ONLY meant to be called from the aggregate op-body loop
 *  when a `SourceMapRecorder` is actually threaded in — a flag-off run
 *  never calls this and pays zero extra allocation. */
export function statementExprMarks(s: StmtIR, chunk: string): ChunkMark[] {
  const exprs = markableExprsOf(s);
  const out: ChunkMark[] = [];
  for (const expr of exprs) {
    const { text, marks } = renderTsExprWithMarks(expr);
    if (text.length === 0 || marks.length === 0) continue;
    const first = chunk.indexOf(text);
    if (first === -1 || chunk.indexOf(text, first + 1) !== -1) continue;
    for (const m of marks) {
      out.push({ start: first + m.start, end: first + m.end, origin: m.origin });
    }
  }
  return out;
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
  const inputs = collectLeaves(value, renderTsExpr)
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

function renderPath(p: PathIR): string {
  if (p.segments.length === 0) return "this";
  const [head, ...tail] = p.segments;
  return `this._${head}${tail.map((t) => `.${t}`).join("")}`;
}

function camelize(name: string): string {
  return name[0]!.toLowerCase() + name.slice(1);
}
