import type { AggregateIR, FindIR, RepositoryIR, TypeIR } from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import { renderCsExpr } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Repository find-method bodies.
//
// Two paths:
//   - Explicit `where Expression` clause on the find — render the IR
//     expression in a LINQ predicate context (`x => …`).  The standard
//     C# expression renderer accepts a `thisName` in its context, so
//     `this.Status` becomes `x.Status` automatically.
//   - No `where` — convention-based equality: each parameter is matched
//     to an aggregate property with the same name (or `<name>Id` →
//     `<name>` if the param's name strips an `Id` suffix), and an
//     `&&`-conjunction is emitted.
// ---------------------------------------------------------------------------

export function buildFindBodies(
  agg: AggregateIR,
  repo: RepositoryIR | undefined,
): Array<{ name: string; filterClause: string; projectionClause: string }> {
  if (!repo) return [];
  return repo.finds.map((find) => ({
    name: find.name,
    filterClause: filterClauseFor(find, agg),
    projectionClause: projectionClauseFor(find.returnType),
  }));
}

function filterClauseFor(find: FindIR, agg: AggregateIR): string {
  if (find.filter) {
    return `.Where(x => ${renderCsExpr(find.filter, { thisName: "x" })})`;
  }
  if (find.params.length === 0) return "";
  const conditions: string[] = [];
  for (const p of find.params) {
    const matchedField = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matchedField) {
      conditions.push(`x.${pascal(matchedField.name)} == ${p.name}`);
    }
  }
  if (conditions.length === 0) return "";
  return `.Where(x => ${conditions.join(" && ")})`;
}

function projectionClauseFor(t: TypeIR): string {
  if (t.kind === "array") return `.ToListAsync(ct)`;
  if (t.kind === "optional") return `.FirstOrDefaultAsync(ct)`;
  return `.FirstAsync(ct)`;
}
