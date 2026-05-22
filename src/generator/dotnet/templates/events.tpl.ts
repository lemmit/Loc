import type { EventIR } from "../../../ir/loom-ir.js";
import { pascal } from "../../../util/naming.js";
import { renderCsType } from "../render-expr.js";

// One sealed record per event, plus the empty IDomainEvent marker
// interface.  Field list maps to record-positional parameters in
// PascalCase.

export function renderEvent(e: EventIR, ns: string): string {
  const params = e.fields.map((f) => `${renderCsType(f.type)} ${pascal(f.name)}`).join(", ");
  return `// Auto-generated.
using ${ns}.Domain.Ids;

namespace ${ns}.Domain.Events;

public sealed record ${e.name}(${params}) : IDomainEvent;
`;
}

export function renderIDomainEvent(ns: string): string {
  return `// Auto-generated.
namespace ${ns}.Domain.Events;

public interface IDomainEvent { }
`;
}
