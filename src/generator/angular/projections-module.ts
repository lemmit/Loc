import type { BoundedContextIR } from "../../ir/types/loom-ir.js";
import { readableProjections } from "../_frontend/projections-module.js";

// ---------------------------------------------------------------------------
// Angular query-time PROJECTION client (`src/api/projections.ts`) — M-T1.3
// Phase 1.  The Angular sibling of `_frontend/projections-module.ts`.
//
// WHY THIS IS A FORK, not another options-widening of the shared module.
//
// #2366 (the Vue port) set the rule the frontend ports follow: REUSE the shared
// emitter while the divergence is LEAF-SHAPED — a string substituted into
// otherwise identical output — and FORK when it is STRUCTURAL, i.e. when the
// emitted unit stops being "a zod schema plus a query hook".  Svelte (#2369)
// was the reuse case and cost three leaf options.  Angular is the first fork,
// and it is not a close call — four independent structural divergences:
//
//   1. NO ZOD.  Angular's client surface is TS-interface shaped (`<Proj>Row`),
//      typed through `HttpClient`'s generic, so there is no `z.object({…})` and
//      no `.parse(r)` runtime boundary check to emit at all.
//   2. A SERVICE.  The read goes through an `@Injectable({providedIn:"root"})`
//      class wrapping `HttpClient`, not a free `api.get(...)` call.
//   3. DI IN THE FACTORY.  `use<Proj>()` must `inject(ProjectionsService)` and
//      wrap an Observable — `injectQuery(() => ({ queryFn: () =>
//      firstValueFrom(service.x()) }))`.
//   4. NO DECIMAL.  Angular maps wire `money` to `string`, so the shared
//      module's `moneySchema` import has no counterpart here.
//
// Growing the shared options object to cover any of those would mean passing
// the caller a *shape* rather than a spelling — which is the line the rule
// draws.  Same call `angular/workflows-module.ts` already made against
// `_frontend/workflows-module.ts`, for the same four reasons.
//
// What IS still shared: `readableProjections` — the readability predicate and
// declaration-order inventory are IR facts, identical on every frontend, and
// they stay in one place (`ir/util/projection-read.ts` via the shared module).
// A fork of the EMITTER is not a fork of the RULE about what is emittable.
// ---------------------------------------------------------------------------

/** Whether this deployable serves any frontend-readable projection. */
export function hasReadableProjections(contexts: BoundedContextIR[]): boolean {
  return readableProjections(contexts).length > 0;
}
