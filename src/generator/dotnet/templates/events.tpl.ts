import type { EventIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const EVENT_TPL = hb.compile(
  `// Auto-generated.
using {{ns}}.Domain.Ids;

namespace {{ns}}.Domain.Events;

public sealed record {{name}}({{#each fields}}{{csType type}} {{pascal name}}{{#unless @last}}, {{/unless}}{{/each}}) : IDomainEvent;
`,
);

const IDOMAINEVENT_TPL = hb.compile(
  `// Auto-generated.
namespace {{ns}}.Domain.Events;

public interface IDomainEvent { }
`,
);

export function renderEvent(e: EventIR, ns: string): string {
  return EVENT_TPL({ ...e, ns });
}

export function renderIDomainEvent(ns: string): string {
  return IDOMAINEVENT_TPL({ ns });
}
