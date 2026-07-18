// -------------------------------------------------------------------------
// Per-persistence-adapter find-predicate capability descriptor.
//
// Platform-neutral (it lives at IR level so `ir/validate` — which may not
// import `generator/` — can gate find/`filter`/retrieval predicates against
// the selected adapter's SQL-lowerable subset).  Each backend's relational
// adapter lowers a DIFFERENT subset of the queryable expression
// sublanguage to SQL; a predicate outside the selected adapter's subset
// either throws at generate time or emits a runtime-broken stub:
//
//   - MikroORM (`src/generator/typescript/emit/mikroorm.ts` whereToMikroFilter)
//       throws "mikroorm v1: this find's predicate is not yet supported".
//   - Dapper   (`src/generator/dotnet/emit/dapper.ts` whereToSql)
//       emits a `NotImplementedException` stub body.
//   - Drizzle  (`src/generator/typescript/repository-find-predicate.ts`)
//       lowers `null` → the find body falls back to a TODO comment.
//
// EF Core (`efcore`) lowers the RICHEST subset — exactly the queryable
// sublanguage admitted by `firstNonQueryableNode` (this.<field> compared to
// literal / param / enum, `&&`/`||`/`!` combinations, `currentUser.<field>`,
// `this.<refColl>.contains(x)`).  It is the "fully lowerable" baseline; the
// other three adapters are described here as NARROWINGS of it (which of those
// queryable shapes each one CANNOT lower).  Drizzle (the default node adapter)
// matches the baseline, so it has no narrowing.
//
// This is a GATE descriptor only — it describes what each adapter rejects so
// the validator can fail fast.  It does NOT extend any lowerer.
// -------------------------------------------------------------------------

import type { ExprIR, TypeIR } from "../types/loom-ir.js";

/** The persistence adapters that lower a `find` / `filter` / retrieval
 *  predicate to SQL.  Mirrors the `persistence:` selector spellings the
 *  deployable carries (`src/platform/*`); only the relational adapters
 *  appear here. */
export type FindPredicateAdapter = "efcore" | "drizzle" | "dapper" | "mikroorm";

/** A capability descriptor: given a predicate ALREADY known to be in the
 *  fully-lowerable (EF Core) queryable subset, return a short label for the
 *  first node THIS narrower adapter cannot lower — or null when the whole
 *  predicate is within the adapter's subset.
 *
 *  The predicate is assumed to already be queryable (anything richer has
 *  been rejected upstream by `firstNonQueryableNode`), so each descriptor
 *  only walks the structural arms the queryable subset admits (paren / unary
 *  `!` / binary compare+`&&`/`||` / `this.*` member / refs / literals /
 *  `this.<refColl>.contains`) and flags the shapes that ARE queryable but
 *  NOT lowerable by the given adapter. */
export type FindPredicateCapability = (e: ExprIR) => string | null;

/** `this.<refColl>.contains(x)` — the membership-over-a-reference-collection
 *  shape `firstNonQueryableNode` admits (it lowers to an EXISTS-style join
 *  subquery on EF Core / Drizzle).  Dapper and MikroORM emit no such
 *  subquery, so they reject it. */
function isContainsMembership(e: ExprIR): boolean {
  return (
    e.kind === "method-call" &&
    e.member === "contains" &&
    e.receiverType.kind === "array" &&
    e.receiverType.element.kind === "id"
  );
}

/** `currentUser.<field>` — a row-level principal reference.  EF Core /
 *  Drizzle thread the request principal into the query; Dapper / MikroORM
 *  have no principal accessor in their find path, so they reject it. */
function isCurrentUserMember(e: ExprIR): boolean {
  return e.kind === "member" && e.receiver.kind === "ref" && e.receiver.refKind === "current-user";
}

/** A bare boolean column standing alone in a boolean position (`filter
 *  this.isActive` / `filter !this.isDeleted`).  EF Core / Drizzle lower it to
 *  `col = true`; MikroORM's `whereToMikroFilter` only accepts top-level
 *  comparisons / `&&` / `||`, so a bare boolean column is rejected. */
function isBareBooleanColumn(e: ExprIR): boolean {
  const isBool = (t: TypeIR | undefined): boolean => t?.kind === "primitive" && t.name === "bool";
  if (e.kind === "member" && e.receiver.kind === "this") return isBool(e.memberType);
  if (e.kind === "ref" && e.refKind === "this-prop") return isBool(e.type);
  return false;
}

const COMPARE_OPS: ReadonlySet<string> = new Set(["==", "!=", "<", "<=", ">", ">="]);

const FULL_SUBSET: FindPredicateCapability = () => null;

/** Dapper (`whereToSql`): comparisons, `&&`/`||`, unary `!`, `this.<field>`,
 *  params, this-prop / enum-value refs, literals, AND `currentUser.<claim>`
 *  (lowered to a `@__cu_<claim>` param bound from the ambient request
 *  principal — same accessor the capability-filter path uses).  It does NOT
 *  emit the reference-collection membership subquery.  That shape can appear at
 *  any node, so a plain node-by-node walk of the queryable structural arms
 *  suffices. */
const DAPPER_SUBSET: FindPredicateCapability = (e) => {
  const reject = (n: ExprIR): string | null => {
    if (isContainsMembership(n))
      return "'this.<refColl>.contains(x)' membership (no join subquery on Dapper)";
    return null;
  };
  const walk = (n: ExprIR): string | null => {
    const here = reject(n);
    if (here) return here;
    switch (n.kind) {
      case "paren":
        return walk(n.inner);
      case "unary":
        return walk(n.operand);
      case "binary":
        return walk(n.left) ?? walk(n.right);
      case "method-call":
        return n.args.length === 1 ? walk(n.args[0]!) : null;
      default:
        return null;
    }
  };
  return walk(e);
};

/** MikroORM (`whereToMikroFilter`): comparisons (`col <op> value`), bare
 *  boolean columns (`this.active` → `{ active: true }`), unary `!` (NOT — via
 *  FilterQuery `$not` / a `false` boolean entry), and `&&` / `||` of predicate
 *  positions.  It still does NOT lower the reference-collection membership
 *  subquery or a `currentUser.<field>` principal reference (no join / no
 *  principal accessor on the find path), so those two shapes are the only
 *  remaining narrowings versus the EF Core / drizzle baseline. */
const MIKROORM_SUBSET: FindPredicateCapability = (e) => {
  const NOT_SUPPORTED =
    "MikroORM v1 lowers comparisons (col <op> value), bare boolean columns, unary '!' and &&/|| of them";
  // Walk a PREDICATE position.  Comparisons / `&&` / `||` / `!` / bare boolean
  // columns are valid here.
  const walkPredicate = (n: ExprIR): string | null => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary") {
      if (inner.op === "&&" || inner.op === "||") {
        return walkPredicate(inner.left) ?? walkPredicate(inner.right);
      }
      if (COMPARE_OPS.has(inner.op)) {
        // A comparison — its operands are values, not predicates; only the
        // adapter-wide rejected shapes (currentUser, contains) can hide there.
        return walkValue(inner.left) ?? walkValue(inner.right);
      }
      return `arithmetic '${inner.op}' — ${NOT_SUPPORTED}`;
    }
    if (inner.kind === "unary" && inner.op === "!") return walkPredicate(inner.operand);
    if (isContainsMembership(inner))
      return `'this.<refColl>.contains(x)' membership — ${NOT_SUPPORTED}`;
    if (isBareBooleanColumn(inner)) return null;
    return `${inner.kind} — ${NOT_SUPPORTED}`;
  };
  // Walk a comparison OPERAND (value) position — only the adapter-wide
  // rejected references matter here.
  const walkValue = (n: ExprIR): string | null => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (isCurrentUserMember(inner))
      return "'currentUser.<field>' principal reference (no principal accessor on the MikroORM find path)";
    return null;
  };
  return walkPredicate(e);
};

const CAPABILITIES: Record<FindPredicateAdapter, FindPredicateCapability> = {
  // EF Core lowers the full queryable subset (the baseline).
  efcore: FULL_SUBSET,
  // Drizzle (default node adapter) matches the EF Core subset.
  drizzle: FULL_SUBSET,
  dapper: DAPPER_SUBSET,
  mikroorm: MIKROORM_SUBSET,
};

/** Recognised relational find-predicate adapters. */
export function isFindPredicateAdapter(name: string): name is FindPredicateAdapter {
  return name === "efcore" || name === "drizzle" || name === "dapper" || name === "mikroorm";
}

/** Return a short label for the first node in `predicate` that the given
 *  adapter cannot lower to SQL, or null when the whole predicate is within
 *  the adapter's subset.  `predicate` is assumed to already be in the
 *  fully-lowerable queryable subset (gated by `firstNonQueryableNode`); this
 *  applies only the per-adapter NARROWING. */
export function firstUnlowerableForAdapter(
  predicate: ExprIR,
  adapter: FindPredicateAdapter,
): string | null {
  return CAPABILITIES[adapter](predicate);
}
