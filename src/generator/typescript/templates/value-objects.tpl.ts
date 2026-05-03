import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const ENUM_VO_TPL = hb.compile(
  `// Auto-generated.

{{#each enums}}
export const {{name}} = {
{{#each values}}  {{this}}: "{{this}}"{{#unless @last}},{{/unless}}
{{/each}}
} as const;
export type {{name}} = {{#each values}}"{{this}}"{{#unless @last}} | {{/unless}}{{/each}};

{{/each}}
{{#each valueObjects}}
export class {{name}} {
  constructor(
{{#each fields}}    public readonly {{name}}: {{tsType type}}{{#unless @last}},{{/unless}}
{{/each}}  ) {
{{#each invariants}}    {{#if guard}}if (({{tsExpr guard}}) && !({{tsExpr expr}})){{else}}if (!({{tsExpr expr}})){{/if}} throw new Error({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}  }

{{#each derived}}  get {{name}}(): {{tsType type}} { return {{tsExpr expr}}; }
{{/each}}
{{#each functions}}  private {{camel name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): {{tsType returnType}} { return {{tsExpr body}}; }
{{/each}}
}

{{/each}}
`,
);

export function renderEnumsAndValueObjects(ctx: BoundedContextIR): string {
  return ENUM_VO_TPL({ enums: ctx.enums, valueObjects: ctx.valueObjects });
}
