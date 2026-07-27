// Permission `implies` transitive closure (authorization.md §6, M-T3.2 item 7).
//
// `X implies Y` declares that HOLDING permission `X` transitively GRANTS
// permission `Y`.  The closure is precomputed here at lowering; the runtime
// authorization check stays a flat membership test — a `contains(Y)` gate is
// expanded to an OR over `Y` plus every permission that (transitively) implies
// it, so no backend walks a graph at request time.
//
// For enforcement we need the REVERSE closure: for each permission `Y`, the set
// of permissions that transitively imply it (`impliedBy(Y)`).  A `contains(Y)`
// check then passes for a caller holding `Y` OR any member of `impliedBy(Y)`.

/** One permission's raw declaration for closure computation: its source name
 *  and the DIRECT `implies` target names (unresolved). */
export interface PermissionEdge {
  name: string;
  /** Direct `implies` target names, exactly as written (may reference an
   *  unknown / sibling name — the validator owns rejection). */
  implies: readonly string[];
}

/** Result of the closure computation, keyed by permission source name. */
export interface PermissionClosure {
  /** Names this permission transitively GRANTS (its forward closure, excluding
   *  itself).  `X implies Y`, `Y implies Z` ⇒ grants(X) = {Y, Z}. */
  grants: string[];
  /** Names that transitively IMPLY this permission (its reverse closure,
   *  excluding itself) — the set a `contains(this)` check must also accept.
   *  `X implies Y` ⇒ impliedBy(Y) = {X}. */
  impliedBy: string[];
}

/**
 * Compute the forward (`grants`) and reverse (`impliedBy`) transitive closures
 * for a permission catalogue.  Cycle-safe (a `visited` set bounds any
 * mutual/self implication).  Unknown `implies` targets (names with no matching
 * declaration) are followed structurally but contribute no further edges — the
 * validator surfaces them as `loom.permission-implies-unknown`; here they are
 * simply dropped so a bad reference never crashes lowering.
 */
export function computePermissionClosures(
  edges: readonly PermissionEdge[],
): Map<string, PermissionClosure> {
  const known = new Set(edges.map((e) => e.name));
  const direct = new Map<string, readonly string[]>();
  for (const e of edges) direct.set(e.name, e.implies);

  // Forward transitive closure (what each permission grants).
  const grantsOf = (start: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(direct.get(start) ?? [])];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (!known.has(t) || out.has(t) || t === start) continue;
      out.add(t);
      for (const n of direct.get(t) ?? []) stack.push(n);
    }
    return out;
  };

  const grants = new Map<string, Set<string>>();
  for (const e of edges) grants.set(e.name, grantsOf(e.name));

  // Reverse closure — invert `grants`.
  const impliedBy = new Map<string, Set<string>>();
  for (const e of edges) impliedBy.set(e.name, new Set());
  for (const [holder, granted] of grants) {
    for (const g of granted) impliedBy.get(g)?.add(holder);
  }

  const result = new Map<string, PermissionClosure>();
  for (const e of edges) {
    result.set(e.name, {
      grants: [...(grants.get(e.name) ?? [])].sort(),
      impliedBy: [...(impliedBy.get(e.name) ?? [])].sort(),
    });
  }
  return result;
}
