import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Branded `XId` types — one per aggregate and per part.  Branding gives us
// nominal safety on what would otherwise be a bare `string` UUID.
// ---------------------------------------------------------------------------

export function renderIds(ctx: BoundedContextIR, extraIdNames: readonly string[] = []): string {
  const names: string[] = [];
  for (const a of ctx.aggregates) {
    names.push(a.name);
    for (const p of a.parts) names.push(p.name);
  }
  // Foreign id brands (M-T4.4): id types referenced by events consumed
  // through a wired broker channel whose owning aggregate this deployable
  // doesn't host — the event interface needs the brand even though no
  // repository/schema for the aggregate exists here.
  for (const n of extraIdNames) {
    if (!names.includes(n)) names.push(n);
  }
  return (
    lines(
      "// Auto-generated.",
      // UUIDv7 (time-ordered): sortable, better index locality than the random
      // v4, same portable guid wire shape.  `uuidv7` is a tiny, typed, dep.
      'import { uuidv7 } from "uuidv7";',
      "",
      ...names.flatMap((name) => [
        `export type ${name}Id = string & { readonly __brand: "${name}Id" };`,
        `export const ${name}Id = (value: string): ${name}Id => value as ${name}Id;`,
        `export const new${name}Id = (): ${name}Id => uuidv7() as ${name}Id;`,
        "",
      ]),
    ) + "\n"
  );
}
