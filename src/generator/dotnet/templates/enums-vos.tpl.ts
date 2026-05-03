import type { ValueObjectIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const ENUM_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Enums;

public enum {{name}}
{
{{#each values}}    {{this}}{{#unless @last}},{{/unless}}
{{/each}}
}
`,
);

// Value objects are emitted as immutable record-classes with explicit
// constructors so invariant checks always run.  Using positional records
// would skip the invariant block on `new VO(args)`.
const VALUEOBJECT_TPL = hb.compile(
  `// Auto-generated.
using System;
using {{ns}}.Domain.Common;

namespace {{ns}}.Domain.ValueObjects;

public sealed record {{name}}
{
{{#each fields}}    public {{csType type}} {{pascal name}} { get; init; }
{{/each}}
    public {{name}}({{#each fields}}{{csType type}} {{name}}{{#unless @last}}, {{/unless}}{{/each}})
    {
{{#each fields}}        {{pascal name}} = {{name}};
{{/each}}{{#each invariants}}        {{#if guard}}if (({{csExpr guard}}) && !({{csExpr expr}})){{else}}if (!({{csExpr expr}})){{/if}} throw new DomainException({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}    }

    /// <summary>Parameterless constructor reserved for EF Core / serializers.</summary>
    private {{name}}()
    {
{{#each fields}}        {{pascal name}} = default!;
{{/each}}    }

{{#each derived}}    public {{csType type}} {{pascal name}} => {{csExpr expr}};
{{/each}}
{{#each functions}}    private {{csType returnType}} {{pascal name}}({{csParams params}}) => {{csExpr body}};
{{/each}}
}
`,
);

export function renderEnum(e: { name: string; values: string[] }, ns: string): string {
  return ENUM_TPL({ name: e.name, values: e.values, ns });
}

export function renderValueObject(vo: ValueObjectIR, ns: string): string {
  return VALUEOBJECT_TPL({ ...vo, ns });
}
