import type { BoundedContextIR, TypeIR } from "../../../ir/loom-ir.js";
import { hb } from "../hb.js";

const EVENTS_TPL = hb.compile(
  `// Auto-generated.
import type * as Ids from "./ids.js";
{{#if voImports.length}}import type { {{#each voImports}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from "./value-objects.js";
{{/if}}{{#if enumImports.length}}import type { {{#each enumImports}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} } from "./value-objects.js";
{{/if}}
{{#each events}}
export interface {{name}} {
  readonly type: "{{name}}";
{{#each fields}}  readonly {{name}}: {{tsType type}};
{{/each}}
}

{{/each}}
{{#if events.length}}
export type DomainEvent = {{#each events}}{{name}}{{#unless @last}} | {{/unless}}{{/each}};
{{else}}
export type DomainEvent = never;
{{/if}}

/**
 * Pluggable boundary for domain events drained from aggregates by the
 * repository.  The default no-op implementation lives in this file; replace
 * it with an outbox writer / message-bus publisher to wire events into
 * your infrastructure.
 */
export interface DomainEventDispatcher {
  dispatch(event: DomainEvent): Promise<void>;
}

export const NoopDomainEventDispatcher: DomainEventDispatcher = {
  async dispatch(_event: DomainEvent): Promise<void> {
    /* no-op */
  },
};
`,
);

export function renderEvents(ctx: BoundedContextIR): string {
  const voImports = new Set<string>();
  const enumImports = new Set<string>();
  const visit = (t: TypeIR): void => {
    if (t.kind === "valueobject") voImports.add(t.name);
    if (t.kind === "enum") enumImports.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const ev of ctx.events) for (const f of ev.fields) visit(f.type);
  return EVENTS_TPL({
    events: ctx.events,
    voImports: [...voImports],
    enumImports: [...enumImports],
  });
}
