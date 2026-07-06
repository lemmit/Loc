// Repository import collection.
//
// Walks an aggregate's fields + part fields and returns the names of the
// value objects and enums it references — used by `buildRepositoryFile` to
// generate the minimal set of `import { … } from "../domain/values/…"` and
// `import { … } from "../domain/enums/…"` lines in the emitted repository
// file.
//
// Pure leaf helpers; both visit the type tree (array / optional) and
// preserve the source order from the bounded-context's `valueObjects` /
// `enums` arrays so the emitted imports are stable across runs.

import type { BoundedContextIR, EnrichedAggregateIR, TypeIR } from "../../ir/types/loom-ir.js";

export function collectValueObjects(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject" && !used.has(t.name)) {
      used.add(t.name);
      // Transitive closure: a VO-in-VO hydrate constructs the NESTED VO too
      // (`new Offer(new Money(…))`), so the inner class needs importing —
      // recurse into the referenced VO's own fields (cycle-safe via `used`).
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      for (const f of vo?.fields ?? []) visit(f.type);
    }
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const part of agg.parts) for (const f of part.fields) visit(f.type);
  return ctx.valueObjects.filter((v) => used.has(v.name)).map((v) => v.name);
}

export function collectEnums(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "enum") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const part of agg.parts) for (const f of part.fields) visit(f.type);
  return ctx.enums.filter((e) => used.has(e.name)).map((e) => e.name);
}
