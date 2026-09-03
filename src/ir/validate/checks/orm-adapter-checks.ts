// -------------------------------------------------------------------------
// Per-backend ORM/adapter support gates: Dapper, MikroORM, and find-predicate
// adapters. Split out of system-checks.ts by packet 2.6 (wave-2) —
// mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  SystemIR,
} from "../../types/loom-ir.js";
import { exprUsesCurrentUser, isQueryTimeProjection } from "../../types/loom-ir.js";
import {
  firstUnlowerableForAdapter,
  isFindPredicateAdapter,
} from "../../util/find-predicate-capability.js";
import { effectiveSavingShape, resolveDataSourceConfig } from "../../util/resolve-datasource.js";
import { isDeepScopeFilter } from "../../util/tenant-stance.js";
import { typeLabel } from "../../util/type-label.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// `persistence: dapper` capability gate (D-REALIZATION-AXES).
//
// The .NET Dapper adapter is at full parity with EF Core: every
// relational/document/embedded/ES/inheritance shape, containment (incl.
// recursive part-in-part), associations, audit/provenance, managed fields,
// retrievals, seeds, and the workflow outbox all emit.  This check fires ONLY
// for a genuinely-impossible shape (an un-owned by-value entity-array part
// field — no relational storage form on any adapter), a fail-fast guard like
// the category-A stamp guard.
// ---------------------------------------------------------------------------
// Element kinds a Dapper part collection field can round-trip as one `jsonb`
// column (System.Text.Json list serialisation) — kept in lockstep with
// `arrayElemCs` in `src/generator/dotnet/emit/dapper.ts` (ir/validate may not
// import generator/, so the two lists are mirrored, not shared).

export function validateDapperSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "dapper") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.dapper-unsupported", { name: dep.name, subject, reason }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.dapper-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      // Not gated here, and why:
      //
      // QUERY-TIME PROJECTIONS emit — the four direct-table arms render as raw
      // Npgsql (the same `NpgsqlDataSource` + private row DTO + `Map` shape the
      // FOLDED read controller uses).  A direct-table arm over a COLUMN-LESS
      // source is refused UNIVERSALLY in
      // `validateColumnlessProjectionSources`, not per-adapter: every backend
      // names the same missing column (a document aggregate maps to a
      // hand-rolled `<Agg>Document` row type, so `o.Total` is CS1061 on EF
      // Core too).
      // `retrieval` bundles emit — `Run<Name>Async` renders as parameterised
      // SQL (where + sort + offset/limit paging); a predicate outside the
      // Dapper subset stubs (NotImplementedException), mirroring the find path.
      // `seed` data emits — the Dapper seeder (Seed.cs) frames the marker table
      // / raw inserts on Npgsql+Dapper while reusing the persistence-agnostic
      // domain-`Create` path (I<Agg>Repository.SaveAsync).
      // Workflow event subscriptions (and therefore channels/outbox) are wired
      // on the Dapper adapter: the saga handlers depend on the
      // persistence-neutral Domain.Common ports, whose raw-Npgsql adapters
      // (DapperPersistencePorts.cs) replace the EF AppDbContext ones; the outbox
      // dispatcher/relay + workflow-instances read controller + saga / outbox /
      // event tables are all emitted through NpgsqlDataSource + DbSchema.
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // Event sourcing IS supported on this adapter (appliers): the
        // `<agg>_events` stream + fold reuse the persistence-agnostic
        // domain/CQRS layer.  An event-sourced aggregate has no state table,
        // so the `shape: ...` axis is moot — skip that check for it.
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        // shape: document IS supported (D-DOCUMENT-AXIS, Dapper edition): the
        // whole aggregate persists as one JSONB `data` blob (a `(id, data,
        // version)` table), reusing the persistence-agnostic ToSnapshot/
        // FromSnapshot round-trip.  Contained parts + `X id[]` references fold
        // INTO the blob, so the relational-only containment/association gates
        // below are moot for it — skip them.  shape: embedded is still gated.
        // shape: embedded IS supported too (Dapper edition): flat root columns
        // PLUS one JSONB column per containment (the part sub-graph folds into
        // it via the ToSnapshot/FromSnapshot round-trip), no child tables.  A
        // part-in-part folds through the same snapshot recursion (the nested
        // `<Part>Snapshot` records + FromSnapshot loop), so it is supported —
        // only a part-collection field whose element kind is outside the
        // jsonb-serialisable set stays gated by the shared containment block.
        const isDocShape = a.persistedAs !== "eventLog" && shape === "document";
        if (
          a.persistedAs !== "eventLog" &&
          shape !== "relational" &&
          shape !== "document" &&
          shape !== "embedded"
        )
          reject(where, `is persisted as shape(${shape})`);
        // Aggregate inheritance: TPC (`ownTable`) IS supported — each concrete
        // is a standalone table with the merged base fields (a normal Dapper
        // repository), and the polymorphic `find all <Base>` base reader is
        // persistence-agnostic (it delegates to each concrete's `All()`).  TPH
        // (`sharedTable`) IS supported too — one shared table named for the base
        // (id + `kind` discriminator + base columns + the nullable union of
        // every concrete's own columns), each concrete repo targeting that table
        // with a spliced `kind = '<Concrete>'` read filter + discriminator-literal
        // INSERT, threading the shared `<Base>Id`.  A TPH member carrying
        // `contains` (nested parts) or an `X id[]` reference collection NOW
        // composes with the containment child-table + association join-table
        // passes: those child / join tables FK the SHARED BASE row's id (EF's
        // TPT-via-contains under a TPH root), so no gate.
        if (isDocShape) continue;
        // Reference-collection associations (`X id[]`) are supported: one
        // ordinal-ordered join table each (DbSchema), bulk-loaded on every
        // read and full-list-replaced on save by the Dapper repository.
        //
        // Nested entity parts (`contains lineItems: LineItem[]`) are supported
        // for STATE aggregates whose parts are FLAT: one child table per
        // containment (`id` PK + `<agg>_id` FK + the part's scalar/enum/vo/id
        // columns), bulk-loaded on every read and hydrated through the root's
        // `_Create(State)` seam, full-list-replaced on save, and cascade-deleted.
        //
        // Event-sourced (`persistedAs: eventLog`) aggregates persist to the
        // `<ctx>_events` stream, NOT a state table — their contained parts fold
        // in-memory from the event stream (the `apply(...)` bodies), so the
        // relational containment emitters (child tables, HydrateAsync, the
        // array-throwing `fieldColumn`) never run for them.  The Dapper event
        // store reuses the persistence-agnostic domain fold unchanged, so
        // `contains` (in any shape) needs no gate on an event-sourced aggregate.
        //
        // Nested entity parts + reference-collection associations (`X id[]`)
        // COMPOSE: every read hydrates the child tables through `_Create(State)`
        // first, then `LoadRefsAsync` post-sets the writable ref-collection list
        // on the reconstructed roots — the two hydrate paths run in sequence,
        // not exclusively.
        //
        // Part-in-part (a contained part with its OWN `contains`) is supported
        // for BOTH shapes.  RELATIONAL child-table shape: `partChildrenOf` builds
        // the containment TREE, each grandchild a table FK'd to its DIRECT parent
        // part; hydration recurses bottom-up (children grouped by parent-part id,
        // slotted into the parent's `Map`), save recurses the object graph, and
        // delete relies on the FK cascade.  The `shape: embedded` fold (one JSONB
        // column per root containment) folds a part-in-part too — the containment
        // column serialises `part.ToSnapshot()`, whose `<Part>Snapshot` recurses
        // into the part's own `contains` (nested snapshot records + the
        // FromSnapshot rehydrate loop), so the whole subtree round-trips through
        // the one column.  No gate.
        //
        // A scalar / enum / value-object / id COLLECTION field on a part IS
        // supported — it stores as one `jsonb` column holding the serialised
        // list (System.Text.Json round-trip, the raw-Npgsql mirror of EF's
        // primitive-collection JSON mapping).  A part FIELD typed as an array of
        // a sibling ENTITY needs no gate: it lowers to a containment (its own
        // grandchild table, part-in-part above), never a by-value column, and a
        // cross-aggregate entity is a structural error — so no un-owned entity
        // collection can reach this check.
        // Lifecycle stamping is supported (onUpdate mutates the aggregate
        // pre-save; onCreate binds INSERT-only parameters excluded from the
        // upsert SET), INCLUDING principal-referencing stamp values — the
        // Dapper repository reaches the request principal through the ambient
        // `RequestContext.Current!.CurrentUser!` accessor (a bare `currentUser`
        // → the principal id, `currentUser.<claim>` → the claim), exactly as
        // the EF AuditableInterceptor.  A principal stamp on a no-auth
        // deployable stays rejected by the category-A loom.stamp-principal-without-auth.
        //
        // HIERARCHICAL TENANCY.  The `deep`/`global` read level lowers to the
        // materialized-path `authz-filter` sentinel, whose `currentUser.<claim>`
        // sub-expressions the Dapper principal-param collector does not descend
        // into — so it cannot bind the `@__cu_*` params the fragment would need.
        // Gated here as an honest boundary rather than left to crash codegen.
        // The `deny` sentinel is principal-free and DOES render (`1 = 0`), so it
        // is deliberately not gated.
        for (const f of [...(a.contextFilters ?? []), a.writeScopeFilter].filter(
          (x): x is ExprIR => x != null,
        )) {
          if (isDeepScopeFilter(f)) {
            diags.push({
              severity: "error",
              message: diagMessage("loom.dapper-unsupported#deep-scope", {
                name: dep.name,
                subject: where,
                reason: "carries a hierarchical (deep/global) tenancy scope filter",
              }),
              source: `${sys.name}/${dep.name}`,
              code: "loom.dapper-unsupported",
            });
            break;
          }
        }
        // Capability filters are supported too (spliced into every SELECT's
        // WHERE); a principal-referencing one lowers `currentUser.<claim>` to a
        // `@__cu_<claim>` Dapper param bound from the same ambient principal.
        // Access modifiers (`managed` / `token` / `internal` / `secret`) are
        // wire-projection concerns handled by the shared Domain/CQRS layers
        // (create-input shaping, `forApiRead` response stripping) — the Dapper
        // column round-trips like any other field, so no gate.  Provenanced
        // fields are supported too: the co-located `<field>_provenance` jsonb
        // column round-trips the ProvLineage (ProvJson.Options) and the Dapper
        // SaveAsync flushes the drained lineage into the `provenance_records`
        // history table (DbSchema owns its DDL) — the raw-Npgsql mirror of the
        // EF value-converter + ProvenanceRecord flush.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: mikroorm` capability gate (D-REALIZATION-AXES).
//
// The node/hono MikroORM adapter is the SECOND node persistence backend
// (alongside the default `drizzle`).  On the PERSISTENCE axis it is at full
// parity with drizzle: every shape / inheritance / containment / association /
// audit / provenance / managed-field / seed / event-sourcing intersection
// emits; persist-time audit stamping injects the audit columns into
// `em.upsert(...)` from the ambient principal; and server-managed access
// (`managed` / `token` / `internal` / `secret`) stores as an ordinary column.
// Hierarchical (`deep`/`global`) tenancy scope is expressible through a `raw()`
// FilterQuery key, so it is not gated here either.
//
// The `loom.mikroorm-unsupported` CODE is also raised by `migration-checks.ts`
// (`#migrations`), for declared migration steps this adapter's
// `orm.schema.updateSchema()` can never apply.  Before adding a clause under
// it, answer both questions this gate exists to ask: is the shape really
// inexpressible on THIS adapter, and is it really specific to it?  A shape
// impossible on every backend belongs in a target-neutral AST rule instead —
// abstract-inheritance-base-with-`contains` lives in
// `loom.abstract-aggregate-contains`
// (`src/language/validators/inheritance.ts` Rule 3b) for exactly that reason.
// ---------------------------------------------------------------------------
//
// ONE adapter-specific reject lives here, and it answers both
// questions: a SCALAR collection field on the aggregate root (`tags: string[]`,
// `kinds: Status[]`).  Inexpressible on THIS adapter (no column arm — see the
// function body), and specific to it (drizzle stores the same field as a
// native Postgres array).

export function validateMikroOrmSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "mikroorm") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        // SCALAR COLLECTION field on the aggregate ROOT (`tags: string[]`,
        // `kinds: Status[]`).  `columnsOf` (typescript/emit/mikroorm.ts) filters
        // out the two collection shapes it CAN map — `X id[]` (a pivot Row) and
        // `<VO>[]` (one inline jsonb column) — and routes everything else into
        // `columnsForType`, whose four arms are primitive / enum / id / value
        // object.  An `array` falls to the default arm, which THROWS
        // `unsupported field kind 'array' … (validator gap)` — codegen aborts on
        // a `.ddd` that parsed and validated clean.  The throw named the gap; it
        // was never gated.  Drizzle stores the same field as a native Postgres
        // array, so this is the one place mikroorm is genuinely BEHIND drizzle
        // rather than at parity — hence its own `#scalar-array` message instead
        // of the "no relational mapping anywhere" generic tail.
        //
        // Scoped to the shapes that actually reach the row emitter:
        //   • `persistedAs: eventLog` — no state table; the collection folds
        //     in-memory from the event stream, so `columnsOf` never runs.
        //   • `shape: document` — the whole aggregate is one jsonb blob, arrays
        //     included (verified: it generates).  `relational` and `embedded`
        //     BOTH go through the root column emitter, so both are gated.
        // The safe interim fix per the parity policy: an honest refusal now, and
        // it drains when the emitter grows a jsonb (or PG-array) column arm —
        // exactly the one a contained PART's collection field already gets.
        const rootShape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        if (a.persistedAs !== "eventLog" && rootShape !== "document") {
          for (const f of a.fields) {
            const t = f.type.kind === "optional" ? f.type.inner : f.type;
            if (t.kind !== "array") continue;
            // `X id[]` (pivot table) and `<VO>[]` (inline jsonb) are mapped —
            // only a PRIMITIVE / ENUM element array has no column arm.
            if (t.element.kind !== "primitive" && t.element.kind !== "enum") continue;
            diags.push({
              severity: "error",
              code: "loom.mikroorm-unsupported",
              message: diagMessage("loom.mikroorm-unsupported#scalar-array", {
                name: dep.name,
                subject: where,
                field: f.name,
                element: typeLabel(t.element),
              }),
              source: `${sys.name}/${dep.name}`,
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-persistence-adapter find-predicate capability gate (Bucket V / P0).
//
// Every relational adapter lowers a `find` / `filter` / retrieval
// predicate to SQL, but each lowers a DIFFERENT subset of the queryable
// expression sublanguage.  A predicate that passes the general queryable
// check (`firstNonQueryableNode`) can still fall outside the SELECTED
// adapter's narrower subset, and the generator then throws at codegen
// (MikroORM `whereToMikroFilter`, Dapper `whereToSql`) or emits a runtime-
// broken TODO stub (Drizzle's null fallback).  This gate fails fast instead,
// keyed off the deployable's explicit `persistence:` selector.
//
// EF Core / Drizzle lower the full queryable subset, so only an explicit
// `persistence: dapper` / `persistence: mikroorm` narrows anything — the
// gate is silent for the (full-subset) defaults, matching the Dapper /
// MikroORM capability gates above.  The per-adapter narrowing lives in the
// platform-neutral descriptor `src/ir/util/find-predicate-capability.ts`
// (ir/validate may not import generator/, so the subset table lives here).
// ---------------------------------------------------------------------------

export function validateFindPredicateAdapterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    const adapter = dep.persistence;
    if (!adapter || !isFindPredicateAdapter(adapter)) continue;
    const report = (subject: string, label: string): void => {
      diags.push({
        severity: "error",
        message: diagMessage("loom.find-predicate-unsupported", {
          name: dep.name,
          adapter,
          subject,
          label,
        }),
        source: `${sys.name}/${dep.name}`,
        code: "loom.find-predicate-unsupported",
      });
    };
    const check = (predicate: ExprIR | undefined, subject: string): void => {
      if (!predicate) return;
      const label = firstUnlowerableForAdapter(predicate, adapter);
      if (label) report(subject, label);
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const repo of ctx.repositories) {
        for (const find of repo.finds) {
          check(find.filter, `repository '${repo.name}' find '${find.name}'`);
        }
      }
      for (const r of ctx.retrievals) {
        check(r.where, `retrieval '${r.name}'`);
      }
      // A QUERY-TIME projection's `where` lowers into a relational SELECT too —
      // through the synthesised `repo.<projName>()` find for the row-sourced
      // shape, and directly into the aggregation query for the pushed-down ones.
      // Walked here because on the MikroORM adapter an aggregation whose filter
      // falls outside the FilterQuery subset would otherwise answer a plausible
      // WRONG NUMBER (the filter silently dropped) instead of being refused.
      // Adapter-generic, like every other position here.
      for (const proj of ctx.projections ?? []) {
        if (!isQueryTimeProjection(proj)) continue;
        check(proj.query?.filter, `query-time projection '${proj.name}'`);
      }
      // Capability `filter` predicates also lower into every SELECT.  The
      // Dapper / MikroORM capability gates already handle principal-
      // referencing ones (and MikroORM rejects ALL capability filters), so
      // only the non-principal predicates can reach a relational SELECT here.
      for (const agg of ctx.aggregates) {
        const filters = (agg as EnrichedAggregateIR).contextFilters ?? [];
        for (const predicate of filters) {
          if (exprUsesCurrentUser(predicate)) continue;
          check(predicate, `a 'filter' capability predicate on aggregate '${agg.name}'`);
        }
      }
    }
  }
}
