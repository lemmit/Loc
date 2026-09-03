// -------------------------------------------------------------------------
// Per-backend support gates for the query-time / grouped / columnless /
// document-aggregation / paged / workflow-source / projection-source
// projection shapes (read-path-architecture.md).  Split out of
// system-checks.ts by packet 2.6 (wave-2) — mechanical move, no logic
// change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import {
  platformFamily,
  platformOwnsBackend,
} from "../../../language/validators/data/platform-rules.js";
import { pagedReturn } from "../../stdlib/generics.js";
import type { SystemIR } from "../../types/loom-ir.js";
import { isGroupedProjection, isQueryTimeProjection } from "../../types/loom-ir.js";
import {
  columnlessProjectionSource,
  documentAggregationSource,
  unappliedCapabilityFilters,
} from "../../util/query-projection-arm.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// paged-run (paged-queryHandler): a `queryHandler H(...): <Agg> paged` is
// emitted by each backend whose explicit-handler emitter has grown the paged
// branch (mirroring Hono's `emitPagedRunHandler`).  A backend NOT in
// `PAGED_QH_SUPPORTED` would crash on the `paged` generic carrier at its
// return-type render, so gate a paged queryHandler hosted on such a deployable
// with an honest diagnostic until its emitter fans out — a reviewed gap rather
// than a silent codegen crash.

export const PAGED_QH_SUPPORTED = new Set(["node", "python", "java", "dotnet", "elixir"]);

// query-time projection (read-path-architecture.md rev.13): the always-current
// read model (`projection X { from … where … join … select … }`, no folds) is
// emitted by each backend whose emitter has ported the query-time read.
// A backend NOT in `PROJECTION_QT_SUPPORTED` has no emitter for it, so gate a
// query-time projection hosted on such a deployable with an honest diagnostic
// until its port lands — the same reviewed-gap discipline as the paged gate.
// All five backends have ported it: node (PR-C), python (PR-D), elixir (PR-E),
// java (PR-F), dotnet (PR-G).

export const PROJECTION_QT_SUPPORTED = new Set(["node", "python", "elixir", "java", "dotnet"]);

// Whole-table aggregation in a query-time projection's `select`
// (`select orders = count`, `select revenue = sum(o.total)`) — the SINGLETON
// read model of read-path-architecture.md rev. 8, whose motivating use is a
// dashboard total / running count.  It pushes the aggregation down to SQL
// (`COUNT(*)` / `SUM(col)`) instead of loading and folding rows, so it is a
// distinct emit path from the per-row `select` every backend already renders.
// Backends in `PROJECTION_AGG_SUPPORTED` have ported it; the rest gate HONESTLY
// rather than emit the operator name as a free identifier.  Same reviewed-gap
// discipline as `validateQueryTimeProjectionBackend` above; node is first.
// Every shipping backend emits the SQL push-down, so the set is currently
// exhaustive.  It is kept — not deleted — because it is the seam a new backend
// gates on until it ports, and the diagnostic below is its message.

export const PROJECTION_AGG_SUPPORTED = new Set(["node", "python", "dotnet", "java", "elixir"]);

export function validateWholeTableAggregationBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_AGG_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        for (const s of p.query?.selects ?? []) {
          if (!s.aggregate) continue;
          diags.push({
            severity: "error",
            code: "loom.projection-whole-table-aggregation-unsupported",
            message: diagMessage("loom.projection-whole-table-aggregation-unsupported", {
              name: p.name,
              field: s.field,
              op: s.aggregate.op,
              dName: d.name,
              platform: d.platform,
            }),
            source: `${c.name}/${p.name}`,
          });
        }
      }
    }
  }
}

// GROUPED projection (`group by`, M-T4.2) — one row per distinct grouping-key
// combination, aggregates computed per group in SQL, the LIST response shape.
// A distinct emit arm from both the singleton aggregation (one row) and the
// per-row read (rows mapped in the app), so a new backend gates on it
// separately until its port lands — the same reviewed-gap discipline as
// `PROJECTION_AGG_SUPPORTED` above.  All five current backends emit it.

export const PROJECTION_GROUPBY_SUPPORTED = new Set(["node", "python", "dotnet", "java", "elixir"]);

export function validateGroupedProjectionBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_GROUPBY_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (!isGroupedProjection(p)) continue;
        diags.push({
          severity: "error",
          code: "loom.projection-groupby-unsupported-backend",
          message: diagMessage("loom.projection-groupby-unsupported-backend", {
            name: p.name,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// COLUMN-LESS direct-table projection source — universal, not per-backend.
//
// The two direct-table arms (`select n = count()/sum(o.x)`, `group by`) push
// the aggregation into SQL, which means they name COLUMNS on the source
// aggregate's own table.  Three source shapes have no such columns:
// `persistedAs: eventLog` (no state table at all), `shape: document` (one
// `(id, data, version)` triple, declared fields inside the jsonb blob), and a
// TPC abstract base (no table of its own).  Every backend then emitted a
// reference to something that does not exist — `schema.orders.total` (TS2339),
// `_db.Orders` / `o.Total` (CS0117 / CS1061), `sum(e.total)` in JPQL,
// `OrderRow.total` in SQLAlchemy, `record.total` in Ecto — with nothing said at
// generate time.
//
// This was a `persistence: dapper` gate until now, on the premise that EF Core
// translated the JSON itself.  It does not; Loom maps a document aggregate to
// a hand-rolled `<Agg>Document` row type.  So the gate is universal, and it is
// NOT a gate-SET: no backend emits this correctly, so there is no per-platform
// membership to keep honest.
//
// It stays PRECISE about the document case: a document table really does have
// an `id` column, so `select n = count()` over a document source emits and runs
// on all five backends — and must keep doing so, since that is the row-count
// tile `scaffoldDashboard` synthesises.  Only a reference to some OTHER member
// is refused.  The condition is `columnlessProjectionSource`, which keys off the
// same `queryProjectionArm` classification the .NET emitter switches on
// (`ir/util/query-projection-arm.ts`), so the gate and the emission arm cannot
// disagree about WHICH arm is being refused.
// ---------------------------------------------------------------------------

export function validateColumnlessProjectionSources(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const sd of sys.subdomains) {
    for (const ctx of sd.contexts) {
      for (const p of ctx.projections ?? []) {
        if (!isQueryTimeProjection(p)) continue;
        const reason = columnlessProjectionSource(p, ctx, sys);
        if (!reason) continue;
        diags.push({
          severity: "error",
          code: "loom.projection-columnless-source",
          message: diagMessage("loom.projection-columnless-source", {
            name: p.name,
            ctxName: ctx.name,
            reason,
          }),
          source: `${ctx.name}/${p.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CAPABILITY-FILTERED direct-table aggregation over a `shape: document` source
// — universal, and the one gate here that closes a SILENT DATA LEAK rather
// than a miscompile.
//
// `columnlessProjectionSource` above deliberately lets `select n = count()`
// through over a document source: a document table really is `(id, data,
// version)`, so a row count names a real column and four of the five backends
// emit it correctly.  What that gate cannot see is the OTHER half of the SQL —
// the capability filters (tenancy scope, `softDeletable`, any `filter`
// capability) that the aggregation emitters splice in themselves, because the
// read bypasses the repository that would otherwise apply them.  Those
// predicates name `tenant_id` / `is_deleted`, and a document table has neither:
//
//   node/drizzle    `eq(schema.orders.tenantId, …)`        TS2339
//   node/mikroorm   `qb.where({ tenantId: … })`            not a property of OrderRow
//   python          `OrderRow.tenant_id == …`              AttributeError / mypy
//   elixir          `record.tenant_id`                     `mix compile` error
//   dotnet/dapper   `WHERE tenant_id = @__cu_org`          Postgres 42703 at runtime
//   dotnet/EF       — NOTHING —                            counts every tenant's rows
//
// The last row is why this is refused universally instead of being left to the
// per-backend compile.  EF applies capability filters through
// `modelBuilder.Entity<T>().HasQueryFilter(…)`, which Loom registers only for a
// RELATIONALLY-mapped aggregate; a document aggregate's filters live in-app, in
// the repository's `_CapabilityVisible`.  So the EF aggregation compiles clean,
// ships, and silently counts other tenants' (and soft-deleted) rows — the exact
// failure a compile gate can never catch.
//
// `ignoring` is honoured: a projection that explicitly waives the filters needs
// none applied, so it is not gated (`unappliedCapabilityFilters`).  That is the
// documented way out for an author who genuinely wants the unscoped total.
// ---------------------------------------------------------------------------

export function validateDocumentAggregationFilters(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const sd of sys.subdomains) {
    for (const ctx of sd.contexts) {
      for (const p of ctx.projections ?? []) {
        if (!isQueryTimeProjection(p)) continue;
        const agg = documentAggregationSource(p, ctx, sys);
        if (!agg) continue;
        const caps = unappliedCapabilityFilters(p, agg);
        if (caps.length === 0) continue;
        diags.push({
          severity: "error",
          code: "loom.projection-document-source-capability-filtered",
          message: diagMessage("loom.projection-document-source-capability-filtered", {
            name: p.name,
            ctxName: ctx.name,
            source: agg.name,
            caps: caps.join(", "),
          }),
          source: `${ctx.name}/${p.name}`,
        });
      }
    }
  }
}

// Direct-table aggregation over a `shape: document` source — the BARE case, the
// one `validateDocumentAggregationFilters` above leaves alone.  Four backends
// aggregate a document table correctly (`count(*)` over `(id, data, version)`
// is a real query): node/drizzle and node/mikroorm select over the row table,
// python over the `OrderRow` model, elixir over the document Ecto schema, and
// both .NET adapters over `DbSet<OrderDocument>` / the raw table.
//
// Java cannot.  Its aggregation runs JPQL through the `EntityManager`
// (`select count(e) from Order e`), and a document aggregate has NO JPA
// `@Entity` at all — it round-trips one jsonb column through a `JdbcTemplate`
// repository — so Hibernate fails the query with "could not resolve root
// entity" at request time.  Broken with NO capabilities in play, which is what
// makes this a SECOND, per-backend gate rather than part of the universal one
// above.
//
// It reuses the two codes that already mean exactly "deployable D (platform P)
// cannot generate this aggregation arm" —
// `loom.projection-whole-table-aggregation-unsupported` for the singleton arm
// and `loom.projection-groupby-unsupported-backend` for the grouped one — via
// their `#document` message variants.  Minting a third code would have said the
// same thing in a third way, and both of these are already carried as `gap`
// rows in the `*-unsupported` register: this membership set is a REFINEMENT of
// theirs (which source shapes the ported emitter can reach), not a new kind of
// claim.  The set is the seam java's emitter drops out of the moment it learns
// to read a document table (a native `select count(*) from <schema>.<table>`).

const PROJECTION_DOCUMENT_AGG_SUPPORTED = new Set(["node", "python", "elixir", "dotnet"]);

export function validateDocumentAggregationBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform)) continue;
    if (PROJECTION_DOCUMENT_AGG_SUPPORTED.has(platformFamily(d.platform) ?? "")) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (!isQueryTimeProjection(p)) continue;
        const agg = documentAggregationSource(p, c, sys);
        if (!agg) continue;
        const params = {
          name: p.name,
          source: agg.name,
          dName: d.name,
          platform: d.platform,
        };
        // Two separate pushes, each with a LITERAL `code:`, rather than one
        // push with a ternary — `test/ir/diagnostic-codes-completeness.test.ts`
        // reads the code straight out of the source text, and a computed code is
        // exactly the "which code does this arm raise?" question it exists to
        // keep answerable by grep.
        const where = `${c.name}/${p.name}`;
        if (isGroupedProjection(p)) {
          diags.push({
            severity: "error",
            code: "loom.projection-groupby-unsupported-backend",
            message: diagMessage("loom.projection-groupby-unsupported-backend#document", params),
            source: where,
          });
        } else {
          diags.push({
            severity: "error",
            code: "loom.projection-whole-table-aggregation-unsupported",
            message: diagMessage(
              "loom.projection-whole-table-aggregation-unsupported#document",
              params,
            ),
            source: where,
          });
        }
      }
    }
  }
}

export function validatePagedQueryHandlerBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    // Only backend platforms emit application-layer handlers; the ones in
    // `PAGED_QH_SUPPORTED` render the paged branch.  Frontends / non-backend
    // platforms are skipped (they host no handlers).
    if (!platformOwnsBackend(d.platform) || PAGED_QH_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const h of c.queryHandlers ?? []) {
        if (!pagedReturn(h.returnType)) continue;
        diags.push({
          severity: "error",
          code: "loom.paged-query-handler-unsupported-backend",
          message: diagMessage("loom.paged-query-handler-unsupported-backend", {
            name: h.name,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${h.name}`,
        });
      }
    }
  }
}

export function validateQueryTimeProjectionBackend(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    // Only backend platforms emit read routes; the ones in
    // `PROJECTION_QT_SUPPORTED` have ported the query-time emit.  Frontends /
    // non-backend platforms host no read model and are skipped.
    if (!platformOwnsBackend(d.platform) || PROJECTION_QT_SUPPORTED.has(d.platform)) continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (!isQueryTimeProjection(p)) continue;
        diags.push({
          severity: "error",
          code: "loom.projection-query-time-unsupported",
          message: diagMessage("loom.projection-query-time-unsupported", {
            name: p.name,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

// A query-time projection sourced `from <Workflow>` (its persisted instance /
// saga-state rows, `instanceWireShape`) reads the workflow store, not an
// aggregate repository — a distinct per-backend emit path.  Backends in
// `PROJECTION_WF_SOURCE_SUPPORTED` have ported it; others gate the read HONESTLY
// (rather than emit a broken reference to a non-existent workflow repository)
// until their port lands.  Mirrors `validateQueryTimeProjectionBackend`.

export const PROJECTION_WF_SOURCE_SUPPORTED = new Set([
  "node",
  "python",
  "java",
  "dotnet",
  "elixir",
]);

export function validateWorkflowSourceProjectionBackend(
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_WF_SOURCE_SUPPORTED.has(d.platform))
      continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (p.query?.sourceKind !== "workflow") continue;
        diags.push({
          severity: "error",
          code: "loom.projection-workflow-source-unsupported-backend",
          message: diagMessage("loom.projection-workflow-source-unsupported-backend", {
            name: p.name,
            source: p.query.source,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}

// A query-time projection sourced `from <OtherProjection>` reads that
// projection's persisted `<Proj>Row` read-model table, not an aggregate
// repository — a distinct per-backend emit path.  Backends in
// `PROJECTION_PROJ_SOURCE_SUPPORTED` have ported it; others gate the read
// HONESTLY until their port lands.  Mirrors `validateWorkflowSourceProjectionBackend`.

export const PROJECTION_PROJ_SOURCE_SUPPORTED = new Set([
  "node",
  "python",
  "java",
  "dotnet",
  "elixir",
]);

export function validateProjectionSourceProjectionBackend(
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  const ctxByName = new Map(sys.subdomains.flatMap((sd) => sd.contexts.map((c) => [c.name, c])));
  for (const d of sys.deployables) {
    if (!platformOwnsBackend(d.platform) || PROJECTION_PROJ_SOURCE_SUPPORTED.has(d.platform))
      continue;
    for (const cn of d.contextNames) {
      const c = ctxByName.get(cn);
      if (!c) continue;
      for (const p of c.projections ?? []) {
        if (p.query?.sourceKind !== "projection") continue;
        diags.push({
          severity: "error",
          code: "loom.projection-source-unsupported-backend",
          message: diagMessage("loom.projection-source-unsupported-backend", {
            name: p.name,
            source: p.query.source,
            dName: d.name,
            platform: d.platform,
          }),
          source: `${c.name}/${p.name}`,
        });
      }
    }
  }
}
