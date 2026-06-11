import type { BoundedContextIR, EventIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { emptyPyTypeImports, visitPyTypeImports } from "../py-type-imports.js";
import { renderPyType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// `app/domain/events.py` — one frozen dataclass per event (class
// identity is the discriminator; the `type` ClassVar carries the wire
// tag for the event-sourcing store, S14), a `DomainEvent` union alias,
// and the pluggable dispatcher boundary with its no-op default.
// ---------------------------------------------------------------------------

export function renderPyEvents(ctx: BoundedContextIR): string {
  const types = emptyPyTypeImports();
  for (const ev of ctx.events) for (const f of ev.fields) visitPyTypeImports(f.type, types);
  const idNames = [...types.idNames].sort();
  const voEnumNames = [...new Set([...types.voNames, ...types.enumNames])].sort();
  const hasEvents = ctx.events.length > 0;

  return lines(
    `"""Domain events + the dispatcher boundary.  Auto-generated."""`,
    "",
    hasEvents ? "from dataclasses import dataclass" : null,
    types.usesDatetime ? "from datetime import datetime" : null,
    types.usesDecimal ? "from decimal import Decimal" : null,
    hasEvents ? "from typing import ClassVar, Protocol" : "from typing import Never, Protocol",
    idNames.length > 0 || voEnumNames.length > 0 ? "" : null,
    idNames.length > 0
      ? `from app.domain.ids import ${idNames.map((n) => `${n}Id`).join(", ")}`
      : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    ...ctx.events.flatMap(renderPyEvent),
    "",
    "",
    hasEvents
      ? `DomainEvent = ${ctx.events.map((e) => e.name).join(" | ")}`
      : "DomainEvent = Never",
    "",
    "",
    "class DomainEventDispatcher(Protocol):",
    `    """Pluggable boundary for events drained from aggregates by the`,
    "    repository.  Replace the no-op default with an outbox writer /",
    "    message-bus publisher to wire events into your infrastructure.",
    `    """`,
    "",
    "    async def dispatch(self, event: DomainEvent) -> None: ...",
    "",
    "",
    "class NoopDomainEventDispatcher:",
    "    async def dispatch(self, event: DomainEvent) -> None:",
    "        return None",
    "",
  );
}

function renderPyEvent(ev: EventIR): string[] {
  return [
    "",
    "",
    "@dataclass(frozen=True)",
    `class ${ev.name}:`,
    `    type: ClassVar[str] = "${ev.name}"`,
    ...ev.fields.map((f) => `    ${snake(f.name)}: ${renderPyType(f.type)}`),
  ];
}
