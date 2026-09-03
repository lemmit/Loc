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
      "",
      "/**",
      " * Buffer events raised inside a CALLER-OWNED transaction, and dispatch",
      " * them only once that transaction has committed.",
      " *",
      " * A repository dispatches at the end of `save()`, which is correct when it",
      " * owns its handle: its own `db.transaction(...)` has committed by then.",
      " * The audit / provenance routes hand the repository the ROUTE's `tx`, so",
      " * that same line runs while the request transaction is still OPEN — and an",
      " * in-process subscriber that touches the database then either",
      " * self-deadlocks (a single-connection driver such as PGlite: the handle it",
      " * queries is the one the open transaction holds) or reads pre-commit state",
      " * on a pool.  The workflow routes already avoid this by dispatching after",
      " * the callback returns; this makes the aggregate routes do the same.",
      " *",
      " * `flush()` runs only on the success path, so a rollback discards the",
      " * buffer rather than announcing writes that were undone.",
      " */",
      "export function deferredDispatcher(",
      "  inner: DomainEventDispatcher,",
      "): DomainEventDispatcher & { flush(): Promise<void> } {",
      "  const buffered: DomainEvent[] = [];",
      "  return {",
      "    async dispatch(event: DomainEvent): Promise<void> {",
      "      buffered.push(event);",
      "    },",
      "    // Durable capture still belongs INSIDE the transaction — that is the",
      "    // whole point of the outbox row committing atomically with the write —",
      "    // so it is delegated straight through rather than buffered.",
      "    recordDurable: inner.recordDurable?.bind(inner),",
      "    async flush(): Promise<void> {",
      "      for (const event of buffered.splice(0)) await inner.dispatch(event);",
      "    },",
      "  };",
      "}",
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
