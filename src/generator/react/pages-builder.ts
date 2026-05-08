import type { AggregateIR } from "../../ir/loom-ir.js";

// ---------------------------------------------------------------------------
// Per-aggregate React pages — utility helpers shared with the
// templating layer's preparers.
//
// Phase 0 / 1.1 / 1.2 / 1.3 / 1.4 of the template-pack rollout
// moved every page emission (list, detail, new, theme, project
// shell, operation modals) into per-pack templates.  This module
// no longer emits TSX directly; it just owns small utilities the
// preparers consume:
//
//   - `iconForOp`           verb-prefix → tabler icon name
//   - `stringIdHeuristic`   `<Aggregate>Id: string` → soft FK link
//
// Phase 1.5 ports the workflow / view emission, which will allow
// retiring `formInput` from form-helpers.ts (currently still used
// by workflow-builder.ts — to be ported next).
// ---------------------------------------------------------------------------

/** Pick a tabler-icon component name for an operation based on its
 *  verb prefix.  Returns `undefined` when nothing matches so the
 *  button stays plain rather than getting a misleading icon. */
export function iconForOp(opName: string): string | undefined {
  const lower = opName.toLowerCase();
  if (/^(add|append|create|insert|new)/.test(lower)) return "IconPlus";
  if (/^(remove|delete|drop|clear)/.test(lower)) return "IconTrash";
  if (/^(confirm|approve|complete|finish|finalize|finalise|publish)/.test(lower)) return "IconCheck";
  if (/^(cancel|abort|reject|deny)/.test(lower)) return "IconX";
  if (/^(ship|deliver|dispatch|send)/.test(lower)) return "IconTruckDelivery";
  if (/^(pay|charge|refund)/.test(lower)) return "IconCreditCard";
  if (/^(start|begin|open)/.test(lower)) return "IconPlayerPlay";
  if (/^(stop|close|end)/.test(lower)) return "IconPlayerStop";
  if (/^(update|edit|change|modify|rename|set)/.test(lower)) return "IconPencil";
  if (/^(assign|attach|link)/.test(lower)) return "IconLink";
  return undefined;
}

/** When a `string` field is conventionally named `<Aggregate>Id`
 *  (e.g. `customerId: string` referencing aggregate `Customer`),
 *  treat it as a soft foreign key so the cell can link to the
 *  target's detail page without requiring the source DSL to upgrade
 *  to an explicit `Id<Customer>`.  Returns the aggregate match when
 *  one applies, otherwise undefined. */
export function stringIdHeuristic(
  fieldName: string,
  t: { kind: string; name?: string },
  aggregatesByName: Map<string, AggregateIR>,
): { targetName: string } | undefined {
  if (t.kind !== "primitive" || t.name !== "string") return undefined;
  const m = /^([a-z][A-Za-z0-9]*)Id$/.exec(fieldName);
  if (!m) return undefined;
  const candidate = m[1]![0]!.toUpperCase() + m[1]!.slice(1);
  if (aggregatesByName.has(candidate)) return { targetName: candidate };
  return undefined;
}
