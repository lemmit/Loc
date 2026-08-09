// M-T1.3 Phase 1 — a Flutter page READS a query-time projection.
//
// SIXTH and last leg, after React (#2324), Vue (#2366), Svelte (#2369),
// Angular (#2376) and Feliz (#2467).  This file holds the strategy note; the
// emission itself belongs in the modules that already own each half, for the
// reason recorded below.
//
// ── Why this is not a client-module port ────────────────────────────────────
//
// The four JS/TS frontends each emit ONE artefact: a client module whose
// `use<Proj>()` the page calls.  React/Vue/Svelte share
// `_frontend/projections-module.ts` through leaf options; Angular forks it into
// an `@Injectable` service.  The rule the Vue port wrote into that module's
// header — reuse while the divergence is LEAF-shaped, fork when it is
// STRUCTURAL — puts Flutter firmly on the fork side: there is no zod, no
// TanStack Query, no TypeScript, and the unit a page consumes is not a hook but
// a Riverpod `FutureProvider` the page `ref.watch`es.
//
// ── The strategy: join the existing read-descriptor pipeline ────────────────
//
// Flutter is shaped like Feliz, not like the JS frontends: `reads-emit.ts`
// already collects the reads a ui's pages issue into `FlutterRead` descriptors
// and derives the provider from each.  Its `collectFlutterReads` says so out
// loud today —
//
//     "projection / workflow-instance reads are skipped (a follow-up)"
//
// — so the port is to fill that hole rather than to build a parallel path:
//
//   1. `FlutterRead` gains a `projection` flavour (row class + no id key)
//   2. `dart-model-emit.ts` emits a `<Proj>Row` class + `fromJson`, off the
//      SAME `wireShape` every other frontend's row type is built from
//   3. `reads-emit.ts` derives a paramless `FutureProvider<<Proj>Row>`
//   4. `flutter-target.ts`'s `buildHookUse` resolves the read to that provider
//
// Deriving (3) and (4) from one descriptor is what keeps the provider the page
// watches and the provider the emitter writes from ever disagreeing — the same
// argument the Feliz port made, and there it meant `update-emit.ts` needed no
// edits at all.
//
// ── What is NOT forked ─────────────────────────────────────────────────────
//
// The readability predicate, `ir/util/projection-read.ts`.  Forking the
// emitter is never forking the rule about WHAT is emittable; every previous
// port held that line and this one does too, asserted by test.

export { readableProjectionNames } from "../../ir/util/projection-read.js";
