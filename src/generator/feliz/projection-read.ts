// ---------------------------------------------------------------------------
// Feliz (F#/Fable/Elmish) query-time PROJECTION read — M-T1.3 Phase 1.
//
// WHY THIS IS SHAPED UNLIKE THE OTHER FOUR PORTS.
//
// React (#2324), Vue (#2366) and Svelte (#2369) reuse the shared
// `_frontend/projections-module.ts`; Angular (#2376) forks it into an
// @Injectable service.  All four still emit ONE THING: a client module whose
// `use<Proj>()` the page calls.  Feliz has no such thing to emit, because
// Elmish has no hooks — `feliz-target.ts`'s `buildHookUse` returns a MODEL
// FIELD name, `renderApiHoisting` emits nothing at all, and the fetch is
// issued by a page-entry `Cmd`.  A projection read therefore is not "a client
// module" here; it is four coordinated emissions:
//
//   1. a `Remote<<Proj>Row>` field on the page Model,
//   2. a Thoth decoder + `Api.<proj>` fetch function (wire.ts),
//   3. an init/page-entry `Cmd.OfAsync.perform Api.<proj> () <Proj>Loaded`,
//   4. an update arm storing `Loaded data` (update-emit.ts).
//
// STRATEGY: do NOT build a parallel path for any of that.  The generator
// already models exactly this shape as a READ DESCRIPTOR — the `reads`
// collection whose entries carry `{ field, msgCase, apiFn, loadedType, paging }`
// and from which the Model field, the `Msg` case, the init `Cmd` and the update
// arm are all derived.  A projection read is one more descriptor in that
// collection: unkeyed (no `pageCase` id), no paging, `loadedType` = the row
// record.  Joining the existing pipeline is what keeps this a small diff and
// keeps the four emissions consistent with each other by construction.
//
// The readability PREDICATE stays shared (`ir/util/projection-read.ts`), as on
// every other port: forking the EMITTER is never forking the rule about what is
// emittable.
// ---------------------------------------------------------------------------

import type { BoundedContextIR } from "../../ir/types/loom-ir.js";
import { readableProjections } from "../_frontend/projections-module.js";

/** Whether this deployable serves any frontend-readable projection. */
export function hasReadableProjections(contexts: BoundedContextIR[]): boolean {
  return readableProjections(contexts).length > 0;
}
