import type { ExprIR, PathIR, ProvSite, StmtIR } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";
import { renderPyExpr } from "./render-expr.js";

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
  /** True when this op's authorization (`requires`) gate has been relocated to
   *  the application/handler boundary (an `operationAuthzOnly` op): the domain
   *  method must NOT re-raise the 403 — it renders to nothing here, and the
   *  route handler raises the gate before dispatch.  `precondition` (400) is
   *  unaffected and always stays in the domain body. */
  suppressRequires?: boolean;
}

const METHOD_BODY_INDENT = "        ";

export function renderPyStatements(
  stmts: StmtIR[],
  indent: string = METHOD_BODY_INDENT,
  ctx: PyStmtCtx = {},
): string {
  let preIndex = 0;
  let provIndex = 0;
  return stmts
    .map((s) => {
      const pre = s.kind === "precondition" ? preIndex++ : 0;
      const pi = (s.kind === "assign" || s.kind === "add") && s.prov ? provIndex++ : 0;
      return renderPyStatement(s, indent, ctx, pre, pi);
    })
    .filter((line) => line !== "")
    .join("\n");
}

/** Bounded walk over the RHS expression collecting leaf inputs —
 *  `this`-props, params and let-bindings (and member-access chains rooted at
 *  them).  Each leaf is `(source path, rendered Python access)`; the access
 *  re-uses `renderPyExpr`, so a `this`-prop renders `self._x`, a param `x`.
 *  Mirrors the TS `collectLeaves`. */
function collectLeaves(
  e: ExprIR,
  out: { path: string; value: string }[] = [],
): { path: string; value: string }[] {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: renderPyExpr(e) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: renderPyExpr(e) });
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
      for (const arm of e.arms) {
        collectLeaves(arm.cond, out);
        collectLeaves(arm.value, out);
      }
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
  const inputs = collectLeaves(value)
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
      const thrown = `raise DomainError(${JSON.stringify(`Precondition failed: ${s.source}`)})`;
      if (!ctx.trace) {
        return [`${i}if not (${renderPyExpr(s.expr)}):`, `${sub}${thrown}`].join("\n");
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
      // ForbiddenError handler (S16).  For an `operationAuthzOnly` op the gate
      // has been relocated to the route handler (raised in handler scope before
      // dispatch), so the domain method drops the raise entirely — emit nothing.
      if (ctx.suppressRequires) return "";
      return [
        `${i}if not (${renderPyExpr(s.expr)}):`,
        `${sub}raise ForbiddenError(${JSON.stringify(`Forbidden: ${s.source}`)})`,
      ].join("\n");
    case "let":
      return `${i}${snake(s.name)} = ${renderPyExpr(s.expr)}`;
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
      // Both call targets (`function` / `private-operation`) render as
      // the `_`-prefixed private method — see render-expr.ts's header.
      return `${i}self._${snake(s.name)}(${args})`;
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
  }
}

function renderPath(p: PathIR): string {
  if (p.segments.length === 0) return "self";
  const [head, ...tail] = p.segments;
  return `self._${snake(head!)}${tail.map((t) => `.${snake(t)}`).join("")}`;
}
