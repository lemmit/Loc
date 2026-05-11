import type { PathIR, StmtIR } from "../../ir/loom-ir.js";
import { snake, pascal } from "../../util/naming.js";
import { renderExpr, type RenderCtx } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Statement renderer for Phoenix LiveView / Ash operation bodies.
//
// Mirrors dotnet/render-stmt.ts.  Statements appear inside `update`
// action `change` blocks and workflow bodies.  Each statement lowers to
// one or more lines of Elixir that operate on an `Ash.Changeset`.
// ---------------------------------------------------------------------------

const INDENT = "      ";

export function renderElixirStatements(
  stmts: StmtIR[],
  ctx: RenderCtx,
  changesetVar = "changeset",
): string {
  return stmts
    .map((s) => renderElixirStatement(s, ctx, changesetVar))
    .join("\n");
}

function renderElixirStatement(
  s: StmtIR,
  ctx: RenderCtx,
  changesetVar: string,
): string {
  switch (s.kind) {
    case "precondition":
      // Raise a domain error when the precondition fails.
      return `${INDENT}if not (${renderExpr(s.expr, ctx)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`;

    case "requires":
      // Authorization gate — surfaces as a forbidden error.
      return `${INDENT}if not (${renderExpr(s.expr, ctx)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`;

    case "let": {
      const val = renderExpr(s.expr, ctx);
      return `${INDENT}${snake(s.name)} = ${val}`;
    }

    case "assign": {
      // `field := value` in operation body → change_attribute on changeset.
      const field = renderPath(s.target);
      const val = renderExpr(s.value, ctx);
      return `${INDENT}${changesetVar} = Ash.Changeset.change_attribute(${changesetVar}, :${field}, ${val})`;
    }

    case "add": {
      // `collection += new EntityPart{...}` → manage_relationship append.
      const rel = renderPath(s.target);
      const val = renderExpr(s.value, ctx);
      return `${INDENT}${changesetVar} = Ash.Changeset.manage_relationship(${changesetVar}, :${rel}, [${val}], type: :create)`;
    }

    case "remove": {
      const rel = renderPath(s.target);
      const val = renderExpr(s.value, ctx);
      return `${INDENT}${changesetVar} = Ash.Changeset.manage_relationship(${changesetVar}, :${rel}, [${val}], type: :destroy)`;
    }

    case "emit": {
      // Broadcast a domain event over Phoenix.PubSub.
      const fields = s.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`)
        .join(", ");
      const moduleName = pascal(s.eventName);
      return `${INDENT}Phoenix.PubSub.broadcast(${ctx.contextModule}.PubSub, "events", %${ctx.contextModule}.Events.${moduleName}{${fields}})`;
    }

    case "call": {
      const args = s.args.map((a) => renderExpr(a, ctx)).join(", ");
      return `${INDENT}${snake(s.name)}(${ctx.thisName}, ${args})`;
    }

    case "expression":
      return `${INDENT}${renderExpr(s.expr, ctx)}`;
  }
}

function renderPath(p: PathIR): string {
  // All paths root from `this`; emit snake_case segments joined with `.`
  // for nested access.  For attribute/relationship we only need the
  // first segment as the Ash field atom.
  return p.segments.map(snake).join(".");
}
