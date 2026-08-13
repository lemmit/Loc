// The aggregate's canonical LIST read and the `requires` gate on it.
//
// Every aggregate serves one list endpoint (`GET /<aggs>`), backed by the
// repository find named `all`.  That find is USUALLY the one enrichment injects
// (`ensureFindAll`), but an author may declare their own — and theirs wins,
// gate included:
//
//     repository Orders for Order {
//       find all(): Order[] requires currentUser.role == "admin"
//     }
//
// Node and .NET picked the gate up for free because they emit a route per
// repository find and `all` is just another entry in that list.  Java, Python
// and Elixir each special-case `all` OUT of their declared-find loop — it has a
// bespoke route shape (paging controls, the `<Agg>Paged` envelope, `index`) —
// and each then emitted that bespoke route without ever consulting the find's
// `requires`.  The gate parsed, validated, lowered, and reached three emitters
// that read every other field on the find except that one.  Result: the same
// `.ddd` served the list 403-gated on two backends and wide open on three.
//
// The failure is structural, not a typo repeated three times: "the list read"
// was a concept each backend re-derived inline with its own predicate.  So it
// gets ONE derivation here that every backend consults, and a backend that
// forgets to call it is visibly missing a call rather than invisibly missing a
// field read.
//
// Derive, don't stamp (CLAUDE.md): a pure function of the repository's finds,
// computed at each emission site.

import type { ExprIR, FindIR, RepositoryIR } from "../types/loom-ir.js";

/** The repository find backing the aggregate's list endpoint — the
 *  enrichment-injected `all`, or the author's own `find all(...)` when they
 *  declared one (theirs wins, per `ensureFindAll`). */
export function listReadFind(repo: RepositoryIR | undefined): FindIR | undefined {
  return repo?.finds.find((f) => f.name === "all");
}

/** The authorization gate on the list endpoint, when the author declared one.
 *
 *  `undefined` for the enrichment-injected `all` (which carries no gate — it is
 *  compiler-synthesized and has no author source line, which is also why
 *  `loom.default-deny-ungated` exempts it).  The emitted route must evaluate
 *  this BEFORE the query and answer 403 on failure, exactly as a named find's
 *  gate does. */
export function listReadGate(repo: RepositoryIR | undefined): ExprIR | undefined {
  return listReadFind(repo)?.requires;
}
