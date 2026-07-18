// Shared `File`-primitive field detection (M-T1.2 / M-T4.6 §5.3).
//
// A `File` is a passive wire-only leaf whose bytes live in an object store;
// a File-bearing aggregate therefore constrains its host deployable (it must
// bind an `objectStore` dataSource — see `validateFileFieldObjectStorage`) and
// makes the Hono backend emit the upload/download endpoints.  Both the IR
// validator and the generator need the same "does this aggregate have a File
// field?" predicate, so it lives here (at the layer both consumers sit above),
// not duplicated per call site.

import type { AggregateIR, TypeIR } from "../types/loom-ir.js";

/** True iff `t` is the `File` primitive, unwrapping `T?` / `T[]` wrappers. */
export function typeIsFile(t: TypeIR): boolean {
  if (t.kind === "array") return typeIsFile(t.element);
  if (t.kind === "optional") return typeIsFile(t.inner);
  return t.kind === "primitive" && t.name === "File";
}

/** The name of the first `File`-typed field on an aggregate — scanning its
 *  declared properties and contained entity parts — or `undefined` when it has
 *  none.  Part fields surface as `<part>.<field>`. */
export function aggregateFileField(agg: AggregateIR): string | undefined {
  for (const f of agg.fields) if (typeIsFile(f.type)) return f.name;
  for (const part of agg.parts)
    for (const f of part.fields) if (typeIsFile(f.type)) return `${part.name}.${f.name}`;
  return undefined;
}

/** True iff the aggregate has any `File`-typed field. */
export function aggregateHasFileField(agg: AggregateIR): boolean {
  return aggregateFileField(agg) !== undefined;
}
