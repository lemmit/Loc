// Canonical collection-op catalogue — the single source for both the
// membership check (`isCollectionOp`) and member enumeration
// (`membersOfType` in language/type-system.ts re-uses the signatures
// table).
//
// Pure data: zero language / AST dependencies, so this lives at a leaf
// under src/util/ and every layer (language, ir, generator, system)
// imports from here without back-edges into language/.

export interface CollectionOpSignature {
  name: string;
  /** Free-form display signature for completion-item details
   *  (e.g. `"(λ): bool"`).  Not parsed; purely informational. */
  signature: string;
}

export const COLLECTION_OP_SIGNATURES: ReadonlyArray<CollectionOpSignature> = [
  { name: "count", signature: "int" },
  { name: "sum", signature: "(λ): decimal" },
  { name: "all", signature: "(λ): bool" },
  { name: "any", signature: "(λ): bool" },
  { name: "where", signature: "(λ): T[]" },
  { name: "first", signature: "T" },
  { name: "firstOrNull", signature: "T?" },
  { name: "contains", signature: "bool" },
  { name: "map", signature: "(λ): U[]" },
  { name: "sortBy", signature: "(λ, desc?: bool): T[]" },
  { name: "distinct", signature: "T[]" },
  { name: "take", signature: "(n: int): T[]" },
  { name: "skip", signature: "(n: int): T[]" },
  { name: "join", signature: "(sep: string): string" },
];

const COLLECTION_OPS = new Set(COLLECTION_OP_SIGNATURES.map((o) => o.name));

export function isCollectionOp(name: string): boolean {
  return COLLECTION_OPS.has(name);
}
