import type { AggregateIR, BoundedContextIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const ENTITY_TPL = hb.compile(
  `{{#with entity}}
export class {{name}} {
  private _id: Ids.{{name}}Id;
{{#unless isRoot}}  private _parentId: Ids.{{rootName}}Id;
{{/unless}}{{#if isRoot}}  private _events: Events.DomainEvent[] = [];
{{/if}}{{#each fields}}  private _{{name}}: {{tsType type}};
{{/each}}{{#each contains}}  private _{{name}}: {{partName}}{{#if collection}}[]{{else}} | null{{/if}};
{{/each}}
  private constructor(state: { id: Ids.{{name}}Id{{#unless isRoot}}; parentId: Ids.{{rootName}}Id{{/unless}}{{#each fields}}; {{name}}: {{tsType type}}{{/each}}{{#each contains}}; {{name}}: {{partName}}{{#if collection}}[]{{else}} | null{{/if}}{{/each}} }) {
    this._id = state.id;
{{#unless isRoot}}    this._parentId = state.parentId;
{{/unless}}{{#each fields}}    this._{{name}} = state.{{name}};
{{/each}}{{#each contains}}    this._{{name}} = state.{{name}};
{{/each}}    this._assertInvariants();
  }

  get id(): Ids.{{name}}Id { return this._id; }
{{#unless isRoot}}  get parentId(): Ids.{{rootName}}Id { return this._parentId; }
{{/unless}}{{#each fields}}  get {{name}}(): {{tsType type}} { return this._{{name}}; }
{{/each}}{{#each contains}}  get {{name}}(): {{#if collection}}readonly {{partName}}[]{{else}}{{partName}} | null{{/if}} { return this._{{name}}; }
{{/each}}{{#each derived}}  get {{name}}(): {{tsType type}} { return {{tsExpr expr}}; }
{{/each}}
{{#each functions}}  private {{camel name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): {{tsType returnType}} { return {{tsExpr body}}; }
{{/each}}
{{#each operations}}  {{#if (eq visibility "public")}}public{{else}}private{{/if}} {{camel name}}({{#each params}}{{name}}: {{tsType type}}{{#unless @last}}, {{/unless}}{{/each}}): void {
{{tsStmts statements}}
    this._assertInvariants();
  }

{{/each}}
{{#if isRoot}}  pullEvents(): Events.DomainEvent[] {
    const out = this._events;
    this._events = [];
    return out;
  }

{{/if}}  private _assertInvariants(): void {
{{#each invariants}}    {{#if guard}}if (({{tsExpr guard}}) && !({{tsExpr expr}})){{else}}if (!({{tsExpr expr}})){{/if}} throw new DomainError({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}  }

  static _create(state: { id: Ids.{{name}}Id{{#unless isRoot}}; parentId: Ids.{{rootName}}Id{{/unless}}{{#each fields}}; {{name}}: {{tsType type}}{{/each}}{{#each contains}}; {{name}}: {{partName}}{{#if collection}}[]{{else}} | null{{/if}}{{/each}} }): {{name}} {
    return new {{name}}(state);
  }
{{#if isRoot}}
  static create(input: { {{#each (requiredFields fields)}}{{name}}: {{tsType type}}{{#unless @last}}; {{/unless}}{{/each}} }): {{name}} {
    return new {{name}}({
      id: Ids.new{{name}}Id(),
{{#each fields}}      {{name}}: {{#if optional}}null{{else}}input.{{name}}{{/if}},
{{/each}}{{#each contains}}      {{name}}: {{#if collection}}[]{{else}}null{{/if}},
{{/each}}    });
  }
{{/if}}
}
{{/with}}`,
);

const AGGREGATE_TPL = hb.compile(
  `// Auto-generated.
import * as Ids from "./ids.js";
{{#if valueObjectAliases.length}}import { {{#each valueObjectAliases}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from "./value-objects.js";
{{/if}}{{#if enumAliases.length}}import { {{#each enumAliases}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from "./value-objects.js";
{{/if}}import type * as Events from "./events.js";
import { DomainError } from "./errors.js";

{{{partsRendered}}}
{{{rootRendered}}}
`,
);

export function renderAggregate(agg: AggregateIR, ctx: BoundedContextIR): string {
  const valueObjectAliases = ctx.valueObjects.map((v) => v.name);
  const enumAliases = ctx.enums.map((e) => e.name);
  const partsRendered = agg.parts
    .map((p) =>
      ENTITY_TPL({
        entity: {
          ...p,
          isRoot: false,
          rootName: agg.name,
          operations: [],
          contains: p.contains,
        },
      }),
    )
    .join("\n");
  const rootRendered = ENTITY_TPL({
    entity: {
      name: agg.name,
      isRoot: true,
      fields: agg.fields,
      contains: agg.contains,
      derived: agg.derived,
      invariants: agg.invariants,
      functions: agg.functions,
      operations: agg.operations,
    },
  });
  return AGGREGATE_TPL({
    valueObjectAliases,
    enumAliases,
    partsRendered,
    rootRendered,
  });
}
