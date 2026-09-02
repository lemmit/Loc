// ---------------------------------------------------------------------------
// M-T9.29 — COMPILE-tier waivers for the pairwise corpus (ALL FIVE backends).
//
// Same ratchet as `waivers.ts`: an entry here means "this crossing GENERATES
// but the emitted project does not compile, and that is a recorded finding".
// The gate fails when an unwaived case fails to compile AND when a waived case
// starts compiling (fix landed → the entry goes, in the same PR).
//
// (The header used to say "Hono/node, strict tsc" — that was slice 1's scope.
// #2690 gave every backend a compile leg, and all five share this register via
// the `platform` field.)
//
// Diagnoses live in `docs/audits/pairwise-corpus-findings-2026-08.md`.
// ---------------------------------------------------------------------------

import type { Waiver } from "./waivers.js";

export const COMPILE_WAIVERS: readonly Waiver[] = [
  {
    // ---- F11 (W3) ------------------------------------------------------
    // `shape: embedded` × TPH (`inheritanceUsing: sharedTable`).  The drizzle
    // repository builder for the EMBEDDED shape names the aggregate's own
    // pluralised table (`schema.things`); under TPH the row lives in the
    // abstract base's shared table and the only export the schema module emits
    // is `thingBases`.  19 × TS2339 per case.
    //
    // The relational builder already gets this right, through
    // `tableOwnerName(agg, ctx.aggregates)` from `src/ir/util/inheritance.ts`,
    // and even carries the comment naming the trap ("not the subtype's own
    // pluralised name, which has no `schema` export").  The embedded builder
    // was cloned before that fix and never picked it up — the same
    // clone-and-diverge shape as F3/F5 (drizzle → MikroORM) one slice earlier.
    //
    // NOT fixed here, and the reason is that the repository is only half of it:
    // the schema emitter does not put the embedded jsonb containment column on
    // the TPH owner table either (it emits a relational `lines` child table
    // instead), so re-pointing the repository would move the error rather than
    // remove it.  Both halves, plus the phase-⑨ migration DDL, plus the same
    // crossing on python (which emits BOTH tables) and .NET (which maps no
    // containment at all) — a cross-emitter mission, not a harness slice.
    // See docs/audits/pairwise-corpus-findings-2026-08.md § F11.
    //
    // SCOPE — deliberately narrow.  50 of the 600 node/default source
    // crossings hit this, and they are exactly `embedded × tph`: every
    // capability, every authz, both reads, and NOT `tpc`.  So the entry pins
    // shape+inheritance and stars the rest, rather than waiving `embedded` on
    // node wholesale (which would hide the next embedded bug).
    platform: "node",
    persistence: "*",
    capability: "*",
    shape: "embedded",
    authz: "*",
    inheritance: "tph",
    read: "*",
    reason:
      "F11 — shape: embedded × TPH: the drizzle embedded repository targets " +
      "schema.<own plural>, but a TPH concrete's row lives in the base's " +
      "shared table and no such export exists (TS2339)",
  },
  {
    // ---- F12 (W3) ------------------------------------------------------
    // `paged` × a NON-RELATIONAL saving shape.  The CALLER honours the carrier
    // (five query params in, `.items` / `.page` / `.page_size` / `.total` /
    // `.total_pages` out); the document and event-sourced repository builders
    // DROP it.  Two backends, one defect, two ways of showing it:
    //
    //   python  `async def by_label(self, l: str) -> Thing` — not even a list.
    //           mypy `Too many arguments for "by_label"` + 5 × `attr-defined`.
    //   dotnet  the repository PORT declares the paged signature and the
    //           implementation emits the plain one:
    //           CS0535 'ThingRepository' does not implement interface member
    //           'IThingRepository.ByLabel(string, int, int, string, string,
    //           CancellationToken)'.  ALL FIVE of the .NET cover's
    //           document/eventLog × paged rows, both adapters (efcore + dapper).
    //
    // MEASURED across the shapes, because "python's paging is broken" would
    // have been the wrong summary: relational × paged is CORRECT (imports
    // `PagedResult`, returns the envelope), embedded × paged emits the envelope
    // but forgets the import (F13 below), document / eventLog drop the carrier
    // entirely.  One construct, three behaviours, one backend — the pairwise
    // thesis stated as a bug.
    //
    // Node and Java both get every shape right; Phoenix gets it wrong a THIRD
    // way that no compile leg here proves (see F14 in the register: the
    // document-shape repository defines `by_label/3` while the context
    // delegate declares arity 5).
    platform: "python|dotnet",
    persistence: "*",
    capability: "*",
    shape: "document|eventLog",
    authz: "*",
    inheritance: "*",
    read: "paged",
    reason:
      "F12 — paged × document/eventLog on python + dotnet: the caller expects the " +
      "envelope, the non-relational repository builders drop the carrier " +
      "(mypy call-arg/attr-defined; CS0535)",
  },
  {
    // ---- F13 (W3) ------------------------------------------------------
    // Two IMPORT GATES the python embedded repository builder never grew, both
    // ruff F821 (undefined name) in the same generated file:
    //
    //   * `ThingBaseRow` — the find body correctly resolves the TPH owner
    //     table (unlike node, see F11), but the schema import still names only
    //     `ThingRow`;
    //   * `PagedResult` — a `paged` find's return annotation and its
    //     constructor call, with no `from app.domain.paging import PagedResult`.
    //     Independent of inheritance: MEASURED on a flat `shape: embedded` ×
    //     `paged` system too, which this cover does not currently sample.
    //
    // Both are one-line additions to the builder's import gate — the same
    // class as the duplicate `authUserImport(...)` the register's postscript
    // records, and typecheck-invisible for the same reason (the emitter builds
    // strings).  Registered rather than fixed only because this slice's tree is
    // the harness; the fix is minutes of work for whoever picks it up.
    platform: "python",
    persistence: "*",
    capability: "*",
    shape: "embedded",
    authz: "*",
    inheritance: "tph",
    read: "*",
    reason:
      "F13 — python embedded repository: ThingBaseRow (TPH owner table) and " +
      "PagedResult are used but never imported (ruff F821)",
  },
  {
    // ---- F15 (W3) ------------------------------------------------------
    // `softDeletable` × TPH, on python.  TPH makes every SUBTYPE column
    // nullable on the shared table — that is what sharing a table means — so
    // the capability's own `is_deleted` column types as
    // `Mapped[bool | None]`, and `not_(ThingBaseRow.is_deleted)` no longer
    // satisfies mypy --strict's `ColumnElement[bool]`.  Four `[arg-type]`.
    //
    // This is the exact class the inheritance axis was added for: the
    // capability is correct, the layout is correct, and the INTERACTION —
    // inheritance changing the nullability of a column the capability filter
    // reads — is what breaks.  .NET refuses the same crossing by name
    // (`loom.tph-filter-unsupported`, for a different EF-shaped reason);
    // python neither refuses it nor compiles it.
    platform: "python",
    persistence: "*",
    capability: "softDeletable",
    shape: "relational",
    authz: "*",
    inheritance: "tph",
    read: "*",
    reason:
      "F15 — softDeletable × TPH on python: the TPH-nullable is_deleted column " +
      "makes not_(...) fail mypy --strict (arg-type)",
  },
  // Above are the register's W3 entries.  Empty remains the target state —
  // same rule as the wire-differential register: a new divergence is a BUG to
  // fix on the emitter first, and a waiver only when fixing it is a mission of
  // its own with a named exit.
  //
  // Both original entries were closed by #2528 and are deleted here:
  //
  //   F2 — `mask unless` × a NON-RELATIONAL saving shape (drizzle): the route
  //        builder called `repo.toWireMasked(...)` for any masked aggregate,
  //        but only the RELATIONAL repository builder emitted the method
  //        (TS2339).  The document / embedded / event-sourced builders now
  //        emit it too.
  //   F5 — a principal-referencing capability filter × `shape: document` ×
  //        `persistence: mikroorm`: the in-app document predicate read
  //        `currentUser` with no `requireCurrentUser()` bind (TS2304).  The
  //        MikroORM document repository now binds it, as drizzle's already did.
  //
  // Both outlived their fix because this leg had no CI workflow to run the
  // stale-waiver ratchet (see the note in `waivers.ts`).  `pairwise.yml` runs
  // it now.
];
