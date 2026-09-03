// -------------------------------------------------------------------------
// Split out of system-checks.ts by packet 2.6 (wave-2) — mechanical move,
// no logic change.  (The section header below moved here from its
// original position, ~1200 lines away, alongside AUTH_UI_FRAMEWORKS in the
// monolith — a pure relocation of an orphaned comment block, no code
// change.)
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { descriptorFor } from "../../../platform/metadata.js";
import type { AggregateIR, SystemIR, TypeIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// `X id` validation for React deployables.
//
// The React form generator renders an `X id` form field as a `<Select>`
// populated by `useAll<X>()` with the target aggregate's `display`-marked
// field as the option label.  Two preconditions must hold for the form
// to be usable:
//
//   1. The target aggregate has a `display` field (otherwise no option
//      label can be derived; the generator falls back to a `<TextInput>`
//      with a placeholder explaining the gap, but the user only sees
//      that at render time).
//   2. The target aggregate is mounted by this deployable's targeted
//      backend (otherwise `useAll<X>()` is not importable and the API
//      can't fetch the list).
//
// We check both up-front per react deployable.  Backends-only
// deployables don't trigger these checks — `X id` on the wire is
// just a string/uuid and doesn't depend on a display label.
// ---------------------------------------------------------------------------

export function validateReactIdReferences(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Build an aggregate registry across the whole system so we can
  // look up display fields regardless of which module declares the
  // target aggregate.
  const allAggregates = new Map<string, AggregateIR>();
  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) allAggregates.set(a.name, a);
    }
  }

  for (const d of sys.deployables) {
    // UI-mounting deployables emit per-aggregate forms whose `X id`
    // inputs need the target aggregate to be reachable from the
    // deployable's mounted set.  Backend-only deployables (hono)
    // skip — no UI.  `dotnet` is dual-mode now (`mountsUi: true` to
    // admit the fullstack `ui:` branch); when no `ui:` is declared
    // it stays backend-only and skips too — without this guard a
    // backend-only dotnet deployable would trigger spurious
    // Id-reachability errors against the (then irrelevant) UI.
    if (!descriptorFor(d.platform).mountsUi) continue;
    // Dual-mode platforms (dotnet) with no `ui:` are backend-only —
    // skip the UI-reachability walk.  `mountsUi && !isFrontend` is the
    // dual-mode shape today (frontend-only platforms always declare ui).
    if (!d.uiName && !descriptorFor(d.platform).isFrontend) continue;
    // Aggregates mounted by this deployable's `contextNames` set —
    // UI generators only emit per-aggregate hooks/queries for
    // these; anything outside is unreachable.
    const mounted = new Set<string>();
    const wantedContexts = new Set(d.contextNames);
    for (const sd of sys.subdomains) {
      for (const c of sd.contexts) {
        if (wantedContexts.has(c.name)) {
          for (const a of c.aggregates) mounted.add(a.name);
        }
      }
    }

    // Walk every operation param + every aggregate field that lowers to
    // an `X id` and check both invariants against the system-wide
    // registry + this deployable's mounted set.
    for (const aggName of mounted) {
      const agg = allAggregates.get(aggName);
      if (!agg) continue;
      // Aggregate root fields.
      for (const f of agg.fields) {
        checkIdReference(f.type, `${aggName}.${f.name}`, d.name, allAggregates, mounted, diags);
      }
      // Operation parameters.
      for (const op of agg.operations) {
        for (const p of op.params) {
          checkIdReference(
            p.type,
            `${aggName}.${op.name}(${p.name})`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
      // Part fields too — entity-parts on the wire surface as nested
      // shapes, but their `X id` properties show up as foreign
      // references in the part's row.  Forms for parts go through
      // the same Select picker pattern.
      for (const part of agg.parts) {
        for (const f of part.fields) {
          checkIdReference(
            f.type,
            `${aggName}.${part.name}.${f.name}`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
    }
  }
}

function checkIdReference(
  t: TypeIR,
  source: string,
  deployableName: string,
  allAggregates: Map<string, AggregateIR>,
  mounted: Set<string>,
  diags: LoomDiagnostic[],
): void {
  const inner = unwrap(t);
  if (inner.kind !== "id") {
    if (inner.kind === "array") {
      checkIdReference(inner.element, source, deployableName, allAggregates, mounted, diags);
    }
    return;
  }
  const target = inner.targetName;
  // 1. Target aggregate must exist somewhere in the system.
  const agg = allAggregates.get(target);
  if (!agg) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unknown-aggregate",
      message: diagMessage("loom.ui-id-ref-unknown-aggregate", { deployableName, source, target }),
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 2. Target aggregate must be mounted by this deployable's modules
  //    so `useAll<Target>()` is importable + the backend can serve
  //    the list.
  if (!mounted.has(target)) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unmounted",
      message: diagMessage("loom.ui-id-ref-unmounted", { deployableName, source, target }),
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 3. Target aggregate must declare a `derived display: string` (so the
  //    Select picker has a sensible option label).
  if (!agg.displayDerived) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-no-display",
      message: diagMessage("loom.ui-id-ref-no-display", { deployableName, source, target }),
      source: `${deployableName}/${source}`,
    });
  }
}

function unwrap(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}
