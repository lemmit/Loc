import type {
  AggregateIR,
  EntityPartIR,
} from "../../../ir/loom-ir.js";
import { csNewIdValue } from "../render-expr.js";
import { hb } from "../hb.js";

const ENTITY_TPL = hb.compile(
  `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using {{ns}}.Domain.Ids;
using {{ns}}.Domain.Events;
using {{ns}}.Domain.ValueObjects;
using {{ns}}.Domain.Enums;
using {{ns}}.Domain.Common;

namespace {{ns}}.Domain.{{plural aggName}};

public sealed class {{name}}
{
    public {{name}}Id Id { get; private set; }
{{#unless isRoot}}    public {{rootName}}Id ParentId { get; private set; }
{{/unless}}
{{#each fields}}    public {{csType type}} {{pascal name}} { get; private set; }{{#if optional}} = default;{{else}} = default!;{{/if}}
{{/each}}{{#each contains}}{{#if collection}}    private readonly List<{{partName}}> _{{name}} = new();
    public IReadOnlyList<{{partName}}> {{pascal name}} => _{{name}}.AsReadOnly();
{{else}}    public {{partName}} {{pascal name}} { get; private set; } = default!;
{{/if}}{{/each}}
{{#if isRoot}}    private readonly List<IDomainEvent> _domainEvents = new();
    public IReadOnlyList<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();
{{/if}}
    private {{name}}()
    {
        Id = default!;
{{#unless isRoot}}        ParentId = default!;
{{/unless}}{{#each fields}}        {{pascal name}} = default!;
{{/each}}    }

{{#each derived}}    public {{csType type}} {{pascal name}} => {{csExpr expr}};
{{/each}}
{{#each functions}}    private {{csType returnType}} {{pascal name}}({{csParams params}}) => {{csExpr body}};
{{/each}}
{{#if isRoot}}{{#each operations}}    {{#if (isPublic visibility)}}public{{else}}private{{/if}} void {{pascal name}}({{csParams params}})
    {
{{csStmts statements}}
        AssertInvariants();
    }

{{/each}}{{/if}}
{{#if isRoot}}    public IReadOnlyList<IDomainEvent> PullEvents()
    {
        var copy = _domainEvents.ToArray();
        _domainEvents.Clear();
        return copy;
    }

{{/if}}    private void AssertInvariants()
    {
{{#each invariants}}        {{#if guard}}if (({{csExpr guard}}) && !({{csExpr expr}})){{else}}if (!({{csExpr expr}})){{/if}} throw new DomainException({{escapeStr (concat "Invariant violated: " source)}});
{{/each}}    }

    public sealed class State
    {
        public {{name}}Id Id { get; init; } = default!;
{{#unless isRoot}}        public {{rootName}}Id ParentId { get; init; } = default!;
{{/unless}}{{#each fields}}        public {{csType type}} {{pascal name}} { get; init; } = default!;
{{/each}}    }

    public static {{name}} _Create(State s)
    {
        var e = new {{name}}();
        e.Id = s.Id;
{{#unless isRoot}}        e.ParentId = s.ParentId;
{{/unless}}{{#each fields}}        e.{{pascal name}} = s.{{pascal name}};
{{/each}}        e.AssertInvariants();
        return e;
    }
{{#if isRoot}}
    public static {{name}} Create({{#each (requiredFields fields)}}{{csType type}} {{name}}{{#unless @last}}, {{/unless}}{{/each}})
    {
        var e = new {{name}}();
        e.Id = new {{name}}Id({{newIdExpr}});
{{#each (requiredFields fields)}}        e.{{pascal name}} = {{name}};
{{/each}}        e.AssertInvariants();
        return e;
    }
{{/if}}
}
`,
);

export function renderEntity(
  entity: AggregateIR | EntityPartIR,
  isRoot: boolean,
  ns: string,
  rootName: string,
): string {
  const isAgg = "operations" in entity;
  return ENTITY_TPL({
    name: entity.name,
    aggName: rootName,
    rootName,
    isRoot,
    fields: entity.fields,
    contains: entity.contains,
    derived: entity.derived,
    invariants: entity.invariants,
    functions: entity.functions,
    operations: isAgg ? (entity as AggregateIR).operations : [],
    newIdExpr: csNewIdValue(isAgg ? (entity as AggregateIR).idValueType : "guid"),
    ns,
  });
}
