import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const IDS_TPL = hb.compile(
  `// Auto-generated.
import { randomUUID } from "node:crypto";

{{#each entries}}
export type {{this.name}}Id = string & { readonly __brand: "{{this.name}}Id" };
export const {{this.name}}Id = (value: string): {{this.name}}Id => value as {{this.name}}Id;
export const new{{this.name}}Id = (): {{this.name}}Id => randomUUID() as {{this.name}}Id;

{{/each}}
`,
);

export function renderIds(ctx: BoundedContextIR): string {
  const entries: { name: string }[] = [];
  for (const a of ctx.aggregates) {
    entries.push({ name: a.name });
    for (const p of a.parts) entries.push({ name: p.name });
  }
  return IDS_TPL({ entries });
}
