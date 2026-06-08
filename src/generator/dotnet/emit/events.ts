import type { EventIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { renderCsType } from "../render-expr.js";

// One sealed record per event, plus the empty IDomainEvent marker
// interface.  Field list maps to record-positional parameters in
// PascalCase.

export function renderEvent(e: EventIR, ns: string): string {
  const params = e.fields.map((f) => `${renderCsType(f.type)} ${upperFirst(f.name)}`).join(", ");
  return `// Auto-generated.
using System;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Domain.Events;

public sealed record ${e.name}(${params}) : IDomainEvent;
`;
}

export function renderIDomainEvent(ns: string, hasSubscriptions = false): string {
  // When the deployable has channel-routed subscriptions, domain events are
  // Mediator notifications so the in-process dispatcher can publish them to
  // the reactor / starter `INotificationHandler<T>`s.  Otherwise it stays a
  // plain marker (byte-identical for non-dispatch projects).
  if (hasSubscriptions) {
    return `// Auto-generated.
using Mediator;

namespace ${ns}.Domain.Events;

public interface IDomainEvent : INotification { }
`;
  }
  return `// Auto-generated.
namespace ${ns}.Domain.Events;

public interface IDomainEvent { }
`;
}
