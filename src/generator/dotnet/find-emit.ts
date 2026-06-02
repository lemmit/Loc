import type { EnrichedAggregateIR, FindIR, RepositoryIR, TypeIR } from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { collectCsExprUsings, renderCsExpr } from "./render-expr.js";

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
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
): Array<{ name: string; filterClause: string; projectionClause: string }> {
  if (!repo) return [];
  return repo.finds.map((find) => ({
    name: find.name,
    filterClause: filterClauseFor(find, agg),
    projectionClause: projectionClauseFor(find.returnType),
  }));
}

/** Namespaces the find-filter predicates of `repo` reach into (e.g.
 *  System.Text.RegularExpressions for a `where … matches …` find) — the
 *  repository-impl emitter declares these as `using`s.  Pure mirror of
 *  what `filterClauseFor` renders. */
export function collectFindBodyUsings(
  repo: RepositoryIR | undefined,
  into: Set<string> = new Set(),
): Set<string> {
  for (const find of repo?.finds ?? []) {
    if (find.filter) collectCsExprUsings(find.filter, into);
  }
  return into;
}

function filterClauseFor(find: FindIR, agg: EnrichedAggregateIR): string {
  if (find.filter) {
    // `agg` is threaded so the renderer can resolve a
    // `this.<refColl>.contains(param)` predicate to its
    // AssociationIR and emit a join-table subquery.  See
    // `render-expr.ts:renderMethodCall`.
    return `.Where(x => ${renderCsExpr(find.filter, { thisName: "x", agg })})`;
  }
  if (find.params.length === 0) return "";
  const conditions: string[] = [];
  for (const p of find.params) {
    const matchedField = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matchedField) {
      conditions.push(`x.${upperFirst(matchedField.name)} == ${p.name}`);
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
