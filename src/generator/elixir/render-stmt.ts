import type { PathIR, StmtIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, relationshipNameFor, renderExpr } from "./render-expr.js";

/** True when the head segment of a mutation path identifies a
 * reference-collection field on the threaded aggregate (vs a regular
 * containment, which keeps the existing entity-instance manage_rel
 * shape). */
function isRefCollPath(p: PathIR, ctx: RenderCtx): boolean {
  if (p.segments.length === 0 || !ctx.agg) return false;
  const head = p.segments[0]!;
  return ctx.agg.associations.some((a) => a.fieldName === head);
}

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
  return stmts.map((s) => renderElixirStatement(s, ctx, changesetVar)).join("\n");
}

function renderElixirStatement(s: StmtIR, ctx: RenderCtx, changesetVar: string): string {
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
      const val = renderExpr(s.value, ctx);
      // Ref-collection (`Id<T>[]`) write — append a target id via the
      // m2m relationship.  `use_identities: [:id]` tells Ash the input
      // is a raw id to look up the target, not a full entity attrs map.
      // `type: :append` (not `:create`) — we're not creating Pokémon
      // records, just attaching existing ones to the trainer.
      if (isRefCollPath(s.target, ctx)) {
        const rel = relationshipNameFor(ctx.agg!, s.target.segments[0]!);
        return `${INDENT}${changesetVar} = Ash.Changeset.manage_relationship(${changesetVar}, :${rel}, [${val}], type: :append, use_identities: [:id])`;
      }
      // Containment collection (`contains lines: OrderLine[]`) — the
      // value is a new entity-part instance, persisted alongside the
      // parent via the owned `:create` semantics.
      const rel = renderPath(s.target);
      return `${INDENT}${changesetVar} = Ash.Changeset.manage_relationship(${changesetVar}, :${rel}, [${val}], type: :create)`;
    }

    case "remove": {
      const val = renderExpr(s.value, ctx);
      // Ref-collection: detach via `:remove` (NOT `:destroy`, which
      // would delete the target Pokémon record itself).
      if (isRefCollPath(s.target, ctx)) {
        const rel = relationshipNameFor(ctx.agg!, s.target.segments[0]!);
        return `${INDENT}${changesetVar} = Ash.Changeset.manage_relationship(${changesetVar}, :${rel}, [${val}], type: :remove, use_identities: [:id])`;
      }
      const rel = renderPath(s.target);
      return `${INDENT}${changesetVar} = Ash.Changeset.manage_relationship(${changesetVar}, :${rel}, [${val}], type: :destroy)`;
    }

    case "emit": {
      // Broadcast a domain event over Phoenix.PubSub.
      const fields = s.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`)
        .join(", ");
      const moduleName = upperFirst(s.eventName);
      return `${INDENT}Phoenix.PubSub.broadcast(${ctx.contextModule}.PubSub, "events", %${ctx.contextModule}.Events.${moduleName}{${fields}})`;
    }

    case "call": {
      const args = s.args.map((a) => renderExpr(a, ctx)).join(", ");
      return `${INDENT}${snake(s.name)}(${ctx.thisName}, ${args})`;
    }

    case "expression":
      return `${INDENT}${renderExpr(s.expr, ctx)}`;
    case "return":
      // Elixir has no `return`; the value is just an expression (the last one
      // in a function body is the result).
      return `${INDENT}${renderExpr(s.value, ctx)}`;
  }
}

function renderPath(p: PathIR): string {
  // The attribute/relationship Ash atom is the head segment. (A dotted
  // join would emit an invalid atom like `:address.city`; Ash addresses
  // nested fields differently, so only the head is used here.)
  return snake(p.segments[0] ?? "");
}
