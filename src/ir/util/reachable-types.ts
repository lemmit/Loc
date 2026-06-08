// Transitive reachable-type collection over the IR's structural types.
//
// Several schema/DTO emitters (the React per-aggregate api module, the
// Hono route + workflow schema blocks) emit a named schema for each value
// object and enum they reference — `<Vo>Schema`, `<Enum>Schema`.  A value
// object's schema is itself `z.object({ <field>: <fieldType>Schema, … })`,
// so it references the schema of EACH field's type.  An emitter that
// collected only the types named directly on the aggregate / workflow
// surface — but not the types reached THROUGH a value object's fields —
// would emit a `<Vo>Schema` whose body references an undeclared
// `<Enum>Schema` (e.g. `Address.country: Country` pulling in `Country`),
// which the bundler rejects with "CountrySchema is not defined".
//
// `collectReachableTypes` walks the seed types and, for every value object
// it reaches, descends into that VO's own field types — the transitive
// closure that matches what the emitted `<Vo>Schema` bodies reference.
// Pure IR traversal: consumed downward by the generators, no back-edge.

import type { TypeIR, ValueObjectIR } from "../types/loom-ir.js";

export interface ReachableTypes {
  /** Names of every value object reachable from the seeds (directly or
   *  through another value object's fields). */
  valueObjects: Set<string>;
  /** Names of every enum reachable from the seeds (directly or through a
   *  value object's fields). */
  enums: Set<string>;
}

export function collectReachableTypes(
  seeds: Iterable<TypeIR>,
  valueObjects: ReadonlyArray<ValueObjectIR>,
): ReachableTypes {
  const voByName = new Map(valueObjects.map((v) => [v.name, v]));
  const vos = new Set<string>();
  const enums = new Set<string>();
  // Value objects whose own fields we still have to descend into.
  const pending: string[] = [];

  const visit = (t: TypeIR): void => {
    if (t.kind === "valueobject") {
      if (!vos.has(t.name)) {
        vos.add(t.name);
        pending.push(t.name);
      }
    } else if (t.kind === "enum") {
      enums.add(t.name);
    } else if (t.kind === "array") {
      visit(t.element);
    } else if (t.kind === "optional") {
      visit(t.inner);
    }
  };

  for (const t of seeds) visit(t);
  // Closure: a reached VO's emitted schema references the schema of each
  // of its fields, so those field types are themselves reachable.
  while (pending.length > 0) {
    const vo = voByName.get(pending.pop()!);
    if (!vo) continue;
    for (const f of vo.fields) visit(f.type);
  }

  return { valueObjects: vos, enums };
}
