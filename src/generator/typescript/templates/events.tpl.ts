import type {
  BoundedContextIR,
  EventIR,
  TypeIR,
} from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { renderTsType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `events.ts` — one interface per event (with a tagged `type` literal),
// plus a `DomainEvent` discriminated union and a no-op dispatcher.
// ---------------------------------------------------------------------------

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

  const voList = [...voImports];
  const enumList = [...enumImports];

  return (
    lines(
      "// Auto-generated.",
      'import type * as Ids from "./ids";',
      voList.length > 0
        ? `import type { ${voList.join(", ")} } from "./value-objects";`
        : null,
      enumList.length > 0
        ? `import type { ${enumList.join(", ")} } from "./value-objects";`
        : null,
      ...ctx.events.flatMap(renderEvent),
      ctx.events.length > 0
        ? `export type DomainEvent = ${ctx.events.map((e) => e.name).join(" | ")};`
        : "export type DomainEvent = never;",
      "",
      "/**",
      " * Pluggable boundary for domain events drained from aggregates by the",
      " * repository.  The default no-op implementation lives in this file; replace",
      " * it with an outbox writer / message-bus publisher to wire events into",
      " * your infrastructure.",
      " */",
      "export interface DomainEventDispatcher {",
      "  dispatch(event: DomainEvent): Promise<void>;",
      "}",
      "",
      "export const NoopDomainEventDispatcher: DomainEventDispatcher = {",
      "  async dispatch(_event: DomainEvent): Promise<void> {",
      "    /* no-op */",
      "  },",
      "};",
    ) + "\n"
  );
}

function renderEvent(ev: EventIR): string[] {
  return [
    `export interface ${ev.name} {`,
    `  readonly type: "${ev.name}";`,
    ...ev.fields.map((f) => `  readonly ${f.name}: ${renderTsType(f.type)};`),
    "}",
    "",
  ];
}
