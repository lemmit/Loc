// ---------------------------------------------------------------------------
// `loom.sensitive-wire-unsupported` — what `sensitive(...)` actually buys you
// today (M-T3.8, diagnostic slice).
//
// `field: T sensitive(pii)` reads like a protection marker, and the surface was
// built to become one: `FieldIR.sensitivity` is documented as "captured at the
// declaration site only — neither the wire-shape, the DTO emitters, nor sink
// type-checking read it yet" (`src/ir/types/loom-ir.ts`).  What ships is one
// consequence, and only one:
//
//   * HONOURED — the synthesized `derived inspect` replaces every sensitive
//     leaf with the literal `<redacted>` (`src/ir/enrich/enrichments.ts`), so
//     `ToString()` / `Inspect` / `__str__` on the domain object does not print
//     the value.  That reaches all five backends; the Elixir `@derive
//     Inspect` opt-out (`src/generator/elixir/vanilla/inspect-emit.ts`) is the
//     one emitter that reads the tags directly.
//
//   * NOT HONOURED — the WIRE.  The response DTO every backend emits is built
//     from `wireShape` with no sensitivity arm, so a `sensitive(pii)` field is
//     serialized in cleartext to any caller allowed to read the aggregate at
//     all.  There is no sink classification either: the value flows into logs,
//     events, projections and external `resource` calls unmarked.
//
// So the declaration protects the DEBUG surface and not the API surface — the
// inverse of what an author reading the word expects, and the reason this is a
// security-class row rather than an ergonomics one.  Until the masking lands
// (mission M-T3.8 phases 2-4 — route `sensitivity` through the same
// response-boundary seam `mask unless` already uses on all five backends), the
// honest move is to say so at the declaration, exactly as the repo does for
// every other capability no backend emits.
//
// SEVERITY is `warning`: the source is not wrong, and a `sensitive(...)` field
// that is already `mask unless`-guarded, `internal` or `secret` is not exposed
// at all — those are excluded below, so the warning marks real cleartext
// exposure only.  It never gates a build.
//
// SELF-EMPTYING: when the wire masking lands, this module and its
// `unsupported-register.ts` row are DELETED in the same PR — a stale honest
// gate is worse than none, because it teaches the author to ignore it.
// ---------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import type { EnrichedBoundedContextIR, EnrichedLoomModel } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** Access roles that never reach an API read.  `forApiRead`
 *  (`src/ir/enrich/wire-projection.ts`) filters exactly these two out of the
 *  response projection, so a sensitive field carrying one is not disclosed and
 *  there is nothing to warn about.  Read off `FieldIR.access` rather than the
 *  recomputed wire shape: `sensitive(...)` is a PROPERTY-site declaration, so
 *  the property is the whole population, and the phase-6 projection helper
 *  stays on the far side of the phase boundary. */
const NOT_DISCLOSED_ON_READ: ReadonlySet<string> = new Set(["internal", "secret"]);

/** Warn once per sensitive field that a caller actually receives in cleartext.
 *  Ordered by system, context, aggregate then declaration order, so the output
 *  is stable. */
export function validateSensitiveWireSupport(
  loom: EnrichedLoomModel,
  diags: LoomDiagnostic[],
): void {
  // `<system>/<context>` for a context inside a system; a bare `<context>` for
  // a top-level one (the same shape `allContexts` folds together, kept split
  // here only so the `source` can name the owning system).
  const scoped: { prefix: string; ctx: EnrichedBoundedContextIR }[] = [];
  for (const sys of loom.systems) {
    for (const sub of sys.subdomains) {
      for (const ctx of sub.contexts) scoped.push({ prefix: `${sys.name}/`, ctx });
    }
  }
  for (const ctx of loom.contexts) scoped.push({ prefix: "", ctx });

  for (const { prefix, ctx } of scoped) {
    for (const agg of ctx.aggregates) {
      for (const f of agg.fields) {
        const tags = f.sensitivity;
        if (!tags || tags.length === 0) continue;
        // Never served on a read.
        if (f.access && NOT_DISCLOSED_ON_READ.has(f.access)) continue;
        // Already redacted at the response boundary by the surface that IS
        // wired — `mask unless` (authorization.md 5).  The author has the
        // protection they asked for; saying otherwise would be noise.
        if (f.maskUnless) continue;
        diags.push({
          severity: "warning",
          code: "loom.sensitive-wire-unsupported",
          message: diagMessage("loom.sensitive-wire-unsupported", {
            field: f.name,
            aggregate: agg.name,
            tags: tags.join(", "),
          }),
          source: `${prefix}${ctx.name}/${agg.name}.${f.name}`,
        });
      }
    }
  }
}
