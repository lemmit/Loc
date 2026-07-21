import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/types/loom-ir.js";
import { escapePythonIdent, snake } from "../../util/naming.js";
import { collectLeaves } from "../_stmt/leaves.js";
import { renderPyExpr, renderPyNegatedGuard } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Statement renderer for the Python backend.  Flat per-kind dispatch,
// mirroring the TS/.NET `render-stmt.ts` shape (deliberately not
// extracted into a shared dispatcher — the arms are shape-divergent
// per backend).
//
// Python's indentation is structural, so the renderer takes the
// enclosing indent explicitly (method bodies sit at 8 spaces inside a
// class).  Multi-line arms (remove, event-sourced emit) nest one level
// below it.
// ---------------------------------------------------------------------------

export interface PyTraceCtx {
  /** Aggregate / part name carried on each emitted trace line. */
  aggregate: string;
  /** Operation label carried on `precondition_evaluated` lines. */
  op: string;
}

export interface PyStmtCtx {
  /** True when rendering a body on an event-sourced
   *  (`persistedAs(eventLog)`) aggregate: an `emit` then both records
   *  the event AND folds it via `self._apply(ev)` (S14).  Off ⇒ `emit`
   *  is the plain notification-event append. */
  eventSourced?: boolean;
  /** Present under `--trace` (F5): inject `precondition_evaluated` /
   *  `value_computed` domain-trace lines (no obs e2e asserts these;
   *  cosmetic parity with the Hono / .NET `--trace` instrumentation). */
  trace?: PyTraceCtx;
  /** True when the aggregate hosts a `provenanced` field (provenance.md):
   *  every instrumented write-site (`assign`/`add`) whose `prov` is set
   *  snapshots its leaf inputs *before* the write, builds a `ProvLineage`,
   *  routes it to the co-located `_<field>_provenance` backing field, and
   *  pushes it onto the per-request ContextVar buffer via `record(...)`. */
  emitProvenance?: boolean;
}

const METHOD_BODY_INDENT = "        ";

export function renderPyStatements(
  stmts: StmtIR[],
  indent: string = METHOD_BODY_INDENT,
  ctx: PyStmtCtx = {},
): string {
  return renderPyStatementChunks(stmts, indent, ctx).join("\n");
}

/** Same rendering as `renderPyStatements`, but one (possibly multi-line)
 *  string per statement instead of the pre-joined whole — exactly the map
 *  `renderPyStatements` joins with `"\n"` today, so `chunks.join("\n")` is
 *  byte-identical to it.  Lets a caller that owns the final file content
 *  (the Python aggregate emitter) recover each statement's own line span
 *  inside an operation body for `SourceMapRecorder.fragment` — see
 *  `statementSubRegions` in `src/generator/_trace/sourcemap.ts`.
 *
 *  Threads the SAME two running counters `renderPyStatements` always has
 *  (`preIndex` bumped only on a `precondition` statement, `provIndex` bumped
 *  only on a provenanced `assign`/`add`) — a chunk's `__pre_N_ok` / `__prov_N`
 *  temp names must match what the pre-joined renderer would have produced
 *  for the exact same statement at the exact same position, so this cannot
 *  be a plain positional index. */
export function renderPyStatementChunks(
  stmts: StmtIR[],
  indent: string = METHOD_BODY_INDENT,
  ctx: PyStmtCtx = {},
): string[] {
  let preIndex = 0;
  let provIndex = 0;
  return stmts.map((s) => {
    const pre = s.kind === "precondition" ? preIndex++ : 0;
    const pi = (s.kind === "assign" || s.kind === "add") && s.prov ? provIndex++ : 0;
    return renderPyStatement(s, indent, ctx, pre, pi);
  });
}

export { statementSubRegions } from "../_trace/sourcemap.js";

/** Splice provenance trace capture around a write-site `base` line:
 *  snapshot the leaf inputs *before* the mutation (so a self-referential
 *  `x := x + n` records the pre-write value), perform the write, build the
 *  `ProvLineage` (rule snapshot + leaf inputs + post-write computed value)
 *  and route it to both sinks — the co-located `_<field>_provenance` backing
 *  field (current lineage, persisted on the row) and the per-request
 *  ContextVar buffer via `record(...)` (drained into the history table by
 *  the repository inside the save transaction).  Mirrors the TS `withTrace`. */
function withProv(
  base: string,
  prov: ProvSite | undefined,
  target: PathIR,
  value: ExprIR,
  emitProvenance: boolean,
  i: string,
  index: number,
): string {
  if (!emitProvenance || !prov) return base;
  const tmp = `__prov_${index}`;
  const lin = `__lin_${index}`;
  const computed = renderPath(target);
  const field = prov.target.field;
  const inputs = collectLeaves(value, renderPyExpr)
    .map((l) => `ProvInput(path=${JSON.stringify(l.path)}, value=${l.value})`)
    .join(", ");
  return [
    `${i}${tmp} = [${inputs}]`,
    base,
    `${i}${lin} = ProvLineage(snapshot_id=${JSON.stringify(prov.snapshotId)}, target=ProvTarget(type=${JSON.stringify(prov.target.type)}, field=${JSON.stringify(field)}), inputs=${tmp}, computed_value=${computed})`,
    `${i}self._${snake(field)}_provenance = ${lin}`,
    `${i}record(${lin})`,
  ].join("\n");
}

/** `log("trace", "<event>", <kwargs>)` — the domain-trace facade call. */
function traceLine(i: string, event: string, kwargs: string): string {
  return `${i}log("trace", ${JSON.stringify(event)}, ${kwargs})`;
}

function renderPyStatement(
  s: StmtIR,
  i: string,
  ctx: PyStmtCtx,
  preIndex: number,
  provIndex: number,
): string {
  const sub = `${i}    `;
  switch (s.kind) {
    case "precondition": {
      const thrown = `raise DomainError(${JSON.stringify(s.message ? s.message.text : `Precondition failed: ${s.source}`)})`;
      if (!ctx.trace) {
        return [`${i}if ${renderPyNegatedGuard(s.expr)}:`, `${sub}${thrown}`].join("\n");
      }
      const ok = `__pre_${preIndex}_ok`;
      return [
        `${i}${ok} = (${renderPyExpr(s.expr)})`,
        traceLine(
          i,
          "precondition_evaluated",
          `aggregate=${JSON.stringify(ctx.trace.aggregate)}, op=${JSON.stringify(ctx.trace.op)}, expr=${JSON.stringify(s.source)}, passed=${ok}`,
        ),
        `${i}if not ${ok}:`,
        `${sub}${thrown}`,
      ].join("\n");
    }
    case "requires":
      // Authorization gate — surfaces as 403 via the route-level
      // ForbiddenError handler (S16).
      return [
        `${i}if ${renderPyNegatedGuard(s.expr)}:`,
        `${sub}raise ForbiddenError(${JSON.stringify(`Forbidden: ${s.source}`)})`,
      ].join("\n");
    case "let":
      // `let`-names may collide with a Python keyword; escape the snake-cased
      // form consistently with the `refKind: "let"` use sites.
      return `${i}${escapePythonIdent(snake(s.name))} = ${renderPyExpr(s.expr)}`;
    case "assign": {
      let base = `${i}${renderPath(s.target)} = ${renderPyExpr(s.value)}`;
      // `value_computed` trace after a single-segment field assign (nested
      // paths are skipped, matching the Hono / .NET `withValueComputed`).
      if (ctx.trace && s.target.segments.length === 1) {
        base = [
          base,
          traceLine(
            i,
            "value_computed",
            `aggregate=${JSON.stringify(ctx.trace.aggregate)}, field=${JSON.stringify(s.target.segments[0])}, value=${renderPath(s.target)}`,
          ),
        ].join("\n");
      }
      return withProv(base, s.prov, s.target, s.value, !!ctx.emitProvenance, i, provIndex);
    }
    case "add": {
      const base = `${i}${renderPath(s.target)}.append(${renderPyExpr(s.value)})`;
      return withProv(base, s.prov, s.target, s.value, !!ctx.emitProvenance, i, provIndex);
    }
    case "remove": {
      const path = renderPath(s.target);
      return [
        `${i}__rm = ${renderPyExpr(s.value)}`,
        `${i}if __rm in ${path}:`,
        `${sub}${path}.remove(__rm)`,
      ].join("\n");
    }
    case "emit": {
      const kwargs = s.fields.map((f) => `${snake(f.name)}=${renderPyExpr(f.value)}`).join(", ");
      const ev = `${s.eventName}(${kwargs})`;
      if (ctx.eventSourced) {
        return [`${i}__ev = ${ev}`, `${i}self._events.append(__ev)`, `${i}self._apply(__ev)`].join(
          "\n",
        );
      }
      return `${i}self._events.append(${ev})`;
    }
    case "call": {
      const args = s.args.map((a) => renderPyExpr(a)).join(", ");
      // A `function` is always a private method (`def _is_draft`); an operation
      // is a public method (`def reserve`) unless declared `private`.  So only
      // prefix `_` for a function or an actually-private operation.
      const prefix = s.target === "private-operation" && !s.targetPrivate ? "" : "_";
      return `${i}self.${prefix}${snake(s.name)}(${args})`;
    }
    case "expression":
      return `${i}${renderPyExpr(s.expr)}`;
    case "return": {
      // Tagged union returns get their proper variant classes in S12;
      // until then the dict form carries the same wire keys.
      const v = renderPyExpr(s.value);
      if (!s.variantTag) return `${i}return ${v}`;
      const tag = JSON.stringify(s.variantTag);
      const tagged =
        s.variantShape === "none"
          ? `{"type": ${tag}}`
          : s.variantShape === "scalar"
            ? `{"type": ${tag}, "value": ${v}}`
            : `{"type": ${tag}, **${v}}`;
      return `${i}return ${tagged}`;
    }
    case "variant-match":
      // Frontend-only effect statement (Stage 2) — gated to action bodies.
      throw new Error(
        "variant-match statement is frontend-only; it must not reach the Python backend",
      );
  }
}

function renderPath(p: PathIR): string {
  if (p.segments.length === 0) return "self";
  const [head, ...tail] = p.segments;
  return `self._${snake(head!)}${tail.map((t) => `.${snake(t)}`).join("")}`;
}
