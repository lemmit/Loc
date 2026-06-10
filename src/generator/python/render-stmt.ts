import type { PathIR, StmtIR } from "../../ir/types/loom-ir.js";
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

export interface PyStmtCtx {
  /** True when rendering a body on an event-sourced
   *  (`persistedAs(eventLog)`) aggregate: an `emit` then both records
   *  the event AND folds it via `self._apply(ev)` (S14).  Off ⇒ `emit`
   *  is the plain notification-event append. */
  eventSourced?: boolean;
}

const METHOD_BODY_INDENT = "        ";

export function renderPyStatements(
  stmts: StmtIR[],
  indent: string = METHOD_BODY_INDENT,
  ctx: PyStmtCtx = {},
): string {
  return stmts.map((s) => renderPyStatement(s, indent, ctx)).join("\n");
}

function renderPyStatement(s: StmtIR, i: string, ctx: PyStmtCtx): string {
  const sub = `${i}    `;
  switch (s.kind) {
    case "precondition":
      return [
        `${i}if not (${renderPyExpr(s.expr)}):`,
        `${sub}raise DomainError(${JSON.stringify(`Precondition failed: ${s.source}`)})`,
      ].join("\n");
    case "requires":
      // Authorization gate — surfaces as 403 via the route-level
      // ForbiddenError handler (S16).
      return [
        `${i}if not (${renderPyExpr(s.expr)}):`,
        `${sub}raise ForbiddenError(${JSON.stringify(`Forbidden: ${s.source}`)})`,
      ].join("\n");
    case "let":
      return `${i}${snake(s.name)} = ${renderPyExpr(s.expr)}`;
    case "assign":
      return `${i}${renderPath(s.target)} = ${renderPyExpr(s.value)}`;
    case "add":
      return `${i}${renderPath(s.target)}.append(${renderPyExpr(s.value)})`;
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
