import type { BoundedContextIR, EventIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { renderTsType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `events.ts` — one interface per event (with a tagged `type` literal),
// plus a `DomainEvent` discriminated union and a no-op dispatcher.
// ---------------------------------------------------------------------------

export function renderEvents(ctx: BoundedContextIR): string {
  const voImports = new Set<string>();
  const enumImports = new Set<string>();
  let usesIds = false;
  let usesDecimal = false;
  const visit = (t: TypeIR): void => {
    if (t.kind === "valueobject") voImports.add(t.name);
    if (t.kind === "enum") enumImports.add(t.name);
    if (t.kind === "id") usesIds = true;
    // The `money` primitive renders as decimal.js `Decimal` — needs an import.
    if (t.kind === "primitive" && t.name === "money") usesDecimal = true;
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const ev of ctx.events) for (const f of ev.fields) visit(f.type);

  const voList = [...voImports];
  const enumList = [...enumImports];

  return (
    lines(
      "// Auto-generated.",
      usesDecimal ? 'import Decimal from "decimal.js";' : null,
      usesIds ? 'import type * as Ids from "./ids";' : null,
      voList.length > 0 ? `import type { ${voList.join(", ")} } from "./value-objects";` : null,
      enumList.length > 0 ? `import type { ${enumList.join(", ")} } from "./value-objects";` : null,
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
      "  /**",
      "   * Transactional-outbox capture (dispatch-delivery-semantics.md §1).",
      "   * Called by a repository from INSIDE its save transaction, with that",
      "   * transaction's handle, so a durable event's outbox row commits",
      "   * atomically with the aggregate write.  Returns the events that still",
      "   * need in-process dispatch after the commit.  Optional: a dispatcher",
      "   * without a durable tier omits it and every event is dispatched",
      "   * post-commit (the at-most-once inline path).",
      "   */",
      "  recordDurable?(events: readonly DomainEvent[], tx: unknown): Promise<DomainEvent[]>;",
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
