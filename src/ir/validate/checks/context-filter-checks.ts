// -------------------------------------------------------------------------
// Split out of system-checks.ts by packet 2.6 (wave-2) — mechanical move,
// no logic change.  (The `ignoring` filter-bypass section keeps its own
// header below the capability-filter one — no duplication with the
// reattached comment.)
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import {
  platformFamily,
  platformOwnsBackend,
} from "../../../language/validators/data/platform-rules.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  SystemIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import { exprUsesCurrentUser } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// Capability-filter support on the Hono and Phoenix backends (partial
// today).  A `filter <expr>` capability installs at the query layer on
// every read.  On .NET it rides EF Core's `HasQueryFilter` (global,
// DI-resolved) — no restriction.  Hono AND-s the predicate into each
// Drizzle read site; Phoenix AND-s it into each Ecto read.  Two cases are
// not yet wired on either and would otherwise emit silently-wrong query
// behaviour (a soft-delete / tenancy-isolation footgun), so reject them
// with a clear error instead:
//
//   1. Principal-referencing filters (`this.tenantId ==
//      currentUser.tenantId`).  Binding the request principal into the
//      always-on read path is deferred (Hono: thread through findById +
//      callers; Phoenix: an actor-bound Ecto `where:`) — see
//      docs/old/proposals/criterion-everywhere.md.
//   2. Non-relational shapes (`shape: document` / `shape: embedded`).
//      Fields live inside a jsonb column, so `this.isDeleted` is not a
//      top-level column the predicate can reference without JSON-path
//      lowering — deferred.  (Phoenix only emits relational anyway, so
//      the saving-shape validator usually blocks this upstream.)
//
// Non-principal capability filters on a relational aggregate
// (`filter !this.isDeleted`) ARE emitted on both backends.
// ---------------------------------------------------------------------------
// Java/JPA gate: a SINGLE (non-collection) containment has no clean
// unidirectional JPA mapping with the FK on the part table (the shared
// schema's shape) — @OneToOne + @JoinColumn puts the FK on the owner,
// and mappedBy needs an entity-typed back-reference the domain model
// doesn't carry.  Fail fast (the parity contract: never silently
// downgrade) until the shadow-parent mapping lands.  Collection
// containments (the overwhelmingly common case) are fully supported via
// unidirectional @OneToMany.

export function validateContextFilterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  // Every backend family x every saving shape wires capability filters, so this
  // gate carries no per-backend deferral table — including elixir +
  // `shape: document`, which evaluates the predicate IN-APP over the rehydrated
  // `%<Agg>.Data{}` embed on every read (`vanillaDocCapabilityFilter`).  A
  // stale deferral table is worse than none: it reads as an authoritative
  // statement of what a backend cannot do, and sends the author to a
  // workaround they do not need.
  //
  // What this check DOES enforce is shape- and backend-independent: a principal-referencing filter needs a REQUEST PRINCIPAL to scope
  // by.  Without `auth: required` on the deployable and a system `user {}`
  // block there is no actor at all — node/python never emit the ambient
  // `requireCurrentUser()` accessor, elixir has no `current_user` to thread,
  // and .NET's `HasQueryFilter` NREs on `RequestContext.Current!.CurrentUser!`
  // on every read (finding 20 / B16).  Mirrors the `validateStampSupport`
  // precedent with a clear, actionable error.
  //
  // Scoped to the five DOMAIN backend families (canonical names per
  // D-NODE-PLATFORM / D-ELIXIR-PLATFORM): a deployable with no database read
  // path never carries a capability filter to begin with.
  const DOMAIN_FAMILIES = new Set(["node", "elixir", "java", "python", "dotnet"]);

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    if (!fam || !DOMAIN_FAMILIES.has(fam)) continue;
    if (dep.auth?.required && sys.user) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const filters = (agg as EnrichedAggregateIR).contextFilters ?? [];
        if (!filters.some((p) => exprUsesCurrentUser(p))) continue;
        diags.push({
          severity: "error",
          code: "loom.context-filter-unsupported",
          message: diagMessage("loom.context-filter-unsupported#no-auth-user", {
            name: dep.name,
            platform: dep.platform,
            ctxName,
            aggName: agg.name,
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `ignoring` filter-bypass support gate (named-filter-bypass.md §11).
//
// A read (repository `find`, or inline `Repo.findAll(...)`/`Repo.run`)
// may carry an `ignoring *` / `ignoring <Cap>, …` clause that bypasses a
// capability's query-filter(s).  Three fail-fast gates run over the FULLY-
// RESOLVED IR (the capability provenance lives on `agg.contextFilterOrigins`):
//
//   loom.filter-bypass-unknown-capability — `ignoring X` where the target
//       aggregate does NOT implement capability X (X ∉ agg.capabilities).
//   loom.filter-bypass-no-filter — X is implemented but contributes NO filter
//       (X ∉ agg.contextFilterOrigins), e.g. `ignoring auditable` (stamps-only).
//       `ignoring *` is a harmless no-op when the aggregate has zero capability
//       filters (only an EXPLICIT named cap errors) — bypassing "all of nothing"
//       is intent-neutral, whereas naming a specific cap that contributes no
//       filter is a likely authoring mistake.
//   loom.filter-bypass-unsupported — the read is served by a deployable whose
//       backend family is NOT in the supported set.  Honored by dotnet (EF
//       `IgnoreQueryFilters`), node (Drizzle), elixir (plain Ecto omits the
//       bypassed `where:`), java (§11.6 @SQLRestriction→bypassable @Filter triage,
//       disabled per-read via the Hibernate Session), and python (SQLAlchemy
//       has no global filter, so each read AND-s its predicates explicitly —
//       a bypassing find/inline-run simply OMITS the named conjunct).
//       Every honoring family is in the set, so the diagnostic only fires for
//       a backend with no DB read path (which never carries `ignoring`).
// ---------------------------------------------------------------------------

/** Backend families that honor an `ignoring` filter-bypass clause.  `dotnet`
 *  (EF `IgnoreQueryFilters`), `node` (Drizzle — omits the bypassed conjunct
 *  from the `and(...)` chain), `elixir` (plain Ecto omits the
 *  bypassed `where:`), and `java` (§11.6 hybrid — a bypassed capability leaves the
 *  always-on `@SQLRestriction` for a bypassable Hibernate named `@Filter`, which
 *  a bypassing read disables via `session.disableFilter`/`enableFilter`;
 *  principal filters omit the JPQL conjunct; document repos re-apply promoted
 *  caps per-find), and `python` (SQLAlchemy has no global filter, so each read
 *  AND-s its capability predicates explicitly via `contextFilterPredicate`; a
 *  bypassing find omits the named conjunct statically, and a shared
 *  `run_<retrieval>` omits the union of its inline call-sites' bypasses) all
 *  honor it. */

export const FILTER_BYPASS_FAMILIES = new Set(["dotnet", "node", "elixir", "java", "python"]);

/** Whether `dep`'s backend honors `ignoring` filter-bypass.  A backend must
 *  not pass this gate while still silently filtering — a family is supported
 *  only once its emitter actually OMITS the bypassed predicate.  Elixir (plain
 *  Ecto) omits the bypassed `where:` on the reads that `ignoring` it. */

function bypassSupported(dep: { platform: string }): boolean {
  const fam = platformFamily(dep.platform);
  if (!fam) return false;
  return FILTER_BYPASS_FAMILIES.has(fam);
}

/** A read carrying an `ignoring` clause, plus the aggregate it targets and a
 *  human-readable site label for diagnostics. */

interface BypassRead {
  bypassAll?: boolean;
  bypassCaps?: string[];
  aggName: string;
  site: string;
}

/** Recursively collect inline `Repo.findAll(...)`/`Repo.run(...)` reads that
 *  carry an `ignoring` clause from a workflow-statement body (descends into
 *  `for-each` + `if-let` bodies). */

function collectBypassRepoRuns(
  stmts: readonly WorkflowStmtIR[],
  wfName: string,
  out: BypassRead[],
): void {
  for (const s of stmts) {
    if (s.kind === "repo-run" && (s.bypassAll || (s.bypassCaps?.length ?? 0) > 0)) {
      out.push({
        bypassAll: s.bypassAll,
        bypassCaps: s.bypassCaps,
        aggName: s.aggName,
        site: `workflow '${wfName}' inline read '${s.name}'`,
      });
    }
    if (s.kind === "for-each") collectBypassRepoRuns(s.body, wfName, out);
    if (s.kind === "if-let") {
      collectBypassRepoRuns(s.thenBody, wfName, out);
      collectBypassRepoRuns(s.elseBody ?? [], wfName, out);
    }
  }
}

/** Every `ignoring`-bearing read in a context, paired with its target
 *  aggregate: repository finds, views over an aggregate source, and inline
 *  repo-runs in workflow bodies. */

function bypassReadsInContext(ctx: BoundedContextIR): BypassRead[] {
  const out: BypassRead[] = [];
  for (const repo of ctx.repositories) {
    for (const f of repo.finds) {
      if (f.bypassAll || (f.bypassCaps?.length ?? 0) > 0) {
        out.push({
          bypassAll: f.bypassAll,
          bypassCaps: f.bypassCaps,
          aggName: repo.aggregateName,
          site: `find '${repo.name}.${f.name}'`,
        });
      }
    }
  }
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) collectBypassRepoRuns(c.statements, wf.name, out);
    for (const h of wf.handlers ?? []) collectBypassRepoRuns(h.statements, wf.name, out);
    for (const on of wf.subscriptions ?? []) collectBypassRepoRuns(on.statements, wf.name, out);
  }
  // A query-time projection's `ignoring` clause bypasses its `from` source
  // aggregate's capability filters — same triage as a repository find.
  for (const p of ctx.projections ?? []) {
    const q = p.query;
    if (!q?.source) continue;
    if (q.bypassAll || (q.bypassCaps?.length ?? 0) > 0) {
      out.push({
        bypassAll: q.bypassAll,
        bypassCaps: q.bypassCaps,
        aggName: q.source,
        site: `query-time projection '${p.name}'`,
      });
    }
  }
  return out;
}

/** Capitalize the first letter of a diagnostic site label (sentence-start). */

function capitalizeSite(s: string): string {
  return s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

export function validateFilterBypassSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    // Only backend deployables serve reads; a frontend (react/static/vue/…)
    // owns no repository read path, so it can't bypass a filter.
    if (!fam || !platformOwnsBackend(dep.platform)) continue;
    const supported = bypassSupported(dep);
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      const aggByName = new Map<string, AggregateIR>();
      for (const a of ctx.aggregates) aggByName.set(a.name, a);
      for (const read of bypassReadsInContext(ctx)) {
        const agg = aggByName.get(read.aggName);
        const caps = new Set(agg?.capabilities ?? []);
        const filterOrigins = new Set(
          (agg?.contextFilterOrigins ?? []).filter((o): o is string => o != null),
        );
        // 1. Unsupported backend — gate FIRST so an `ignoring` read on a
        //    non-dotnet backend always fails (regardless of cap validity).
        if (!supported) {
          diags.push({
            severity: "error",
            code: "loom.filter-bypass-unsupported",
            message: diagMessage("loom.filter-bypass-unsupported", {
              name: dep.name,
              platform: dep.platform,
              site: read.site,
              ctxName,
              aggName: read.aggName,
            }),
            source: `${sys.name}/${dep.name}`,
          });
          continue;
        }
        // 2. Per named capability: must be implemented AND contribute a filter.
        //    `ignoring *` skips both checks (it's keyed on nothing specific).
        for (const cap of read.bypassCaps ?? []) {
          if (!caps.has(cap)) {
            diags.push({
              severity: "error",
              code: "loom.filter-bypass-unknown-capability",
              message: diagMessage("loom.filter-bypass-unknown-capability", {
                site: capitalizeSite(read.site),
                ctxName,
                aggName: read.aggName,
                cap,
              }),
              source: `${sys.name}/${dep.name}`,
            });
            continue;
          }
          if (!filterOrigins.has(cap)) {
            diags.push({
              severity: "error",
              code: "loom.filter-bypass-no-filter",
              message: diagMessage("loom.filter-bypass-no-filter", {
                site: capitalizeSite(read.site),
                ctxName,
                aggName: read.aggName,
                cap,
              }),
              source: `${sys.name}/${dep.name}`,
            });
          }
        }
      }
    }
  }
}
