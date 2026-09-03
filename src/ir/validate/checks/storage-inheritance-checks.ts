// -------------------------------------------------------------------------
// Inheritance storage (TPC/TPH), event-sourced storage, provenanced
// storage, `mask unless` read-redaction support + laundering-through-`emit`
// detection, and audited-operation support.  Split out of system-checks.ts
// by packet 2.6 (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { descriptorFor } from "../../../platform/metadata.js";
import type {
  BoundedContextIR,
  EnrichedLoomModel,
  ExprIR,
  StmtIR,
  SystemIR,
} from "../../types/loom-ir.js";
import { nonRootFilterFields, rootBaseOf } from "../../util/inheritance.js";
import { opHasProvSite } from "../../util/prov-id.js";
import { walkExprDeep, walkStmtsDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { firstNonGateRef, GATE_ALLOWED_REFS } from "./query-checks.js";

// Aggregate-inheritance storage gate (aggregate-inheritance.md, I2/I3).
//
// `ownTable` (TPC) emission is wired on every backend: the abstract base is
// dropped from the generation view (system/index.ts `collectContextsFor`) and
// each concrete emits as a standalone table carrying the merged base + own
// fields (the `wireShape` merge in enrichContext).
//
// `sharedTable` (TPH) is implemented on all three DB backends: Hono/Drizzle
// (hand-rolled shared table + `kind` discriminator, per-concrete columns
// nullable, repos filter/stamp `kind`), .NET/EF Core (native
// `HasDiscriminator`), and Phoenix (plain Ecto shared table + a `kind`
// discriminator column). So a TPH hierarchy is allowed iff its context is
// hosted by at least one of those backends; otherwise it's an error (not a
// warning) — there is no implemented emission target.
// `sharedTable` is the omitted-modifier
// default, so an inheritance hierarchy with no `inheritanceUsing: …` is TPH
// too. Polymorphic `Party id` refs and `find all Party` remain deferred (the
// language validator rejects the former); document / TPT shapes are later.

const DEFAULT_INHERITANCE_LAYOUT = "sharedTable" as const;

/** Map each context name to the set of backend (needsDb) platforms that host
 *  it — a context is TPH-capable iff that set intersects TPH_CAPABLE. */

export function backendPlatformsHostingEachContext(
  loom: EnrichedLoomModel,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sys of loom.systems) {
    for (const d of sys.deployables) {
      if (!descriptorFor(d.platform).needsDb) continue;
      for (const cn of d.contextNames) {
        const set = out.get(cn) ?? new Set<string>();
        set.add(d.platform);
        out.set(cn, set);
      }
    }
  }
  return out;
}

export function validateInheritanceStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const byName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  // TPH storage emission ships on Hono (Drizzle shared table + `kind`), .NET
  // (EF Core native `HasDiscriminator`), Phoenix (plain Ecto shared table + a
  // `kind` discriminator column), Python (SQLAlchemy) and Java (Hibernate).
  const TPH_CAPABLE = new Set(["node", "dotnet", "elixir", "python", "java"]);
  const tphList = [...TPH_CAPABLE].sort().join(", ");
  const hostedByCapable = [...backendPlatforms].some((p) => TPH_CAPABLE.has(p));
  for (const agg of ctx.aggregates) {
    if (!agg.isAbstract && !agg.extendsAggregate) continue;
    // A concrete's layout defaults to its base's (resolved within the
    // context); a per-concrete `inheritanceUsing: …` override wins. The
    // abstract base uses its own declared layout. Either way an omitted
    // modifier means `sharedTable` (TPH), the documented default.
    const base = agg.extendsAggregate ? byName.get(agg.extendsAggregate) : undefined;
    const effective = agg.inheritanceUsing ?? base?.inheritanceUsing ?? DEFAULT_INHERITANCE_LAYOUT;
    if (effective !== "sharedTable") continue;
    // Implemented when a TPH-capable backend (Hono / .NET / Phoenix) hosts the context.
    if (hostedByCapable) continue;
    const role = agg.isAbstract ? "abstract base" : `extends ${agg.extendsAggregate}`;
    const how = agg.inheritanceUsing
      ? "inheritanceUsing: sharedTable"
      : "the omitted-modifier default (sharedTable)";
    const others = [...backendPlatforms].filter((p) => !TPH_CAPABLE.has(p));
    const hostNote =
      others.length > 0
        ? `it is hosted by ${others.join(", ")}, where TPH is not implemented`
        : `no TPH-capable (${tphList}) backend deployable hosts this context`;
    diags.push({
      severity: "error",
      code: "loom.tph-backend-unsupported",
      message: diagMessage("loom.tph-backend-unsupported", {
        name: agg.name,
        role,
        how,
        tphList,
        hostNote,
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// ---------------------------------------------------------------------------
// EF Core only: a TPH subtype's capability `filter` must be expressible as a
// ROOT query filter.
//
// EF hosts every query filter in an inheritance hierarchy on the root entity
// type, so a predicate reading a column that exists on ONE subtype cannot be
// registered at all — `nonRootFilterFields` carries the two workarounds and the
// EF Core 10.0.10 errors that rule each of them out.  Without this gate the
// emitter either dropped the filter whole (the old `tph ? [] :` short-circuit,
// a declared read restriction absent from every emitted query with no error at
// all) or emitted a root-typed lambda naming a member the root does not have.
//
// Scoped to the EF adapter, NOT to `platform: dotnet`.  The Dapper adapter
// splices its capability predicates into raw SQL against the shared table, where
// a subtype column is simply a column — so the same model is fine there, and a
// platform-wide gate would reject a shape that works.  Every other backend
// filters per-read, so none of them is affected either.
// ---------------------------------------------------------------------------

export function validateTphFilterExpressibility(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const seen = new Set<string>();
  for (const dep of sys.deployables) {
    if (dep.platform !== "dotnet" || dep.persistence === "dapper") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const stray = nonRootFilterFields(agg, ctx.aggregates);
        if (stray.length === 0) continue;
        // One diagnostic per aggregate, however many .NET deployables host it.
        const key = `${ctx.name}/${agg.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diags.push({
          severity: "error",
          code: "loom.tph-filter-unsupported",
          message: diagMessage("loom.tph-filter-unsupported", {
            name: agg.name,
            fields: stray.map((f) => `'${f}'`).join(", "),
            root: rootBaseOf(agg, ctx.aggregates).name,
          }),
          source: key,
        });
      }
    }
  }
}

// Event-sourced storage emission (`persistedAs: eventLog`, appliers A2) is
// implemented for the Hono (`node`) and .NET (`dotnet`, EF Core) backends:
// the `<agg>_events` stream table + fold-on-load repository. So an
// event-sourced aggregate is allowed iff every backend deployable hosting
// its context implements it. On a backend that doesn't (Phoenix today) the
// aggregate would silently fall back to state persistence, losing the event
// log — an error, not a silent downgrade. Mirrors the TPH storage gate.
//
// Phoenix (plain Ecto/Phoenix) hosts pure ES via the per-aggregate stream +
// fold-on-load data layer (D-VANILLA-ES-HOME), so elixir is ES-capable.

export const EVENT_SOURCING_BACKENDS = new Set(["node", "dotnet", "python", "java", "elixir"]);

export function validateEventSourcedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Every hosting backend must implement event sourcing; flag any that don't.
  const unsupported = [...backendPlatforms].filter((p) => !EVENT_SOURCING_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    if (anyBackend && unsupported.length === 0) continue;
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where event-sourced persistence is not implemented`
        : "no event-sourcing-capable (node / dotnet / java / python / elixir) backend deployable hosts this context";
    diags.push({
      severity: "error",
      code: "loom.event-sourcing-backend-unsupported",
      message: diagMessage("loom.event-sourcing-backend-unsupported", { name: agg.name, hostNote }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced *workflow* storage gate (workflow-and-applier.md A2-S5b).  A
// `workflow X eventSourced { … apply(…) }` folds its own emitted events into
// state via appliers — the saga analogue of a `persistedAs: eventLog`
// aggregate (emit-only handlers + pure `apply` folds, no mutable state table).
// The surface (grammar → `WorkflowIR.eventSourced` / `.appliers`) and the
// emit-only / pure-fold discipline (A1) have landed, and the **node, .NET,
// Python, Java, and elixir backends all emit the event-sourced workflow
// runtime** (per-correlation `<wf>_events` stream, fold-on-load,
// emit→append-own-event dispatch).  A backend that doesn't keeps an
// `eventSourced` workflow gated — otherwise it silently misgenerates as a
// state-based saga (the saga emitters key off `correlationField` alone, emit a
// mutable `<Wf>State` row + dispatcher, and drop the appliers entirely).  A
// parsed-but-unemitted feature is a footgun, so it fails fast — exactly like the
// event-sourced *aggregate* storage gate.

export const EVENT_SOURCING_WORKFLOW_BACKENDS = new Set([
  "node",
  "dotnet",
  "python",
  "java",
  "elixir",
]);

export function validateEventSourcedWorkflowStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !EVENT_SOURCING_WORKFLOW_BACKENDS.has(p));
  if (unsupported.length === 0) return;
  const hosts = unsupported.sort().join(", ");
  for (const wf of ctx.workflows) {
    if (!wf.eventSourced) continue;
    diags.push({
      severity: "error",
      code: "loom.event-sourced-workflow-unsupported",
      message: diagMessage("loom.event-sourced-workflow-unsupported", { name: wf.name, hosts }),
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// the Hono (`node`), .NET (`dotnet`), Java (`java`), Python (`python`) and
// elixir backends — the lineage SDK + co-located `<field>_provenance` column +
// the `provenance_records` flush.  On a backend that doesn't (e.g. react) a
// `provenanced` field silently behaves like a plain field, dropping the audit
// trail it promises — an error, not a silent no-op.  Mirrors the event-sourcing
// storage gate (a parsed-but-unemitted feature is a footgun, so it fails fast).

const PROVENANCE_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);

export function validateProvenancedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !PROVENANCE_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    const provFields = agg.fields.filter((f) => f.provenanced);
    if (provFields.length === 0) continue;
    if (anyBackend && unsupported.length === 0) continue;
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where the provenance runtime is not emitted`
        : "no provenance-capable (node / dotnet / java / python / elixir) backend deployable hosts this context";
    const names = provFields.map((f) => f.name).join(", ");
    diags.push({
      severity: "error",
      code: "loom.provenanced-backend-unsupported",
      message: diagMessage("loom.provenanced-backend-unsupported", {
        name: agg.name,
        names,
        hostNote,
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// `mask unless <expr>` read mask (authorization.md §5) — the aggregate-field
// baseline that redacts a field on the wire unless a `currentUser`-only
// predicate holds.  Two gates:
//   - loom.field-mask-not-current-user — the predicate references something
//     other than `currentUser` (+ constants): the mask is evaluated at DTO
//     projection as a param-free CALLER predicate, so a row/param reference is
//     illegal (mirrors the find gate's currentUser-only rule).
//   - loom.field-mask-unsupported — the field is hosted by a backend whose DTO
//     projection doesn't yet emit the redaction.  A parsed-but-unredacted mask
//     is a SECURITY footgun (the sensitive value ships in the clear), so it
//     fails fast rather than silently no-op'ing.  A backend absent from the set
//     makes a `mask unless` field a compile error there rather than an
//     unenforced no-op; adding read redaction to a backend adds its platform
//     here.
//     `node` emits response-boundary read redaction (`toWireMasked`) across its
//     read routes + explicit handlers; `dotnet` redacts
//     each masked field's DTO-projection arg via the ambient principal; `python`
//     routes response boundaries through `to_wire_masked` (reads the ambient
//     `current_user()` and redacts fail-closed); `java` adds a `<Agg>Response
//     .fromMasked` mapper (static `CurrentUserAccessor.currentOrNull()` guard) the
//     read services + explicit handlers project through (audit keeps `from`);
//     `elixir` (vanilla Phoenix) makes `serialize/1` redact (reading the principal
//     from the process dictionary the Auth plug stashes), moving the raw map to
//     `serialize_unmasked/1` for audit snapshots.
// ---------------------------------------------------------------------------
// `mask unless` LAUNDERING through `emit` (M-T3.15 B0).
//
// The query-time bound below refuses a projection that READS a masked
// aggregate.  A FOLDED projection reaches the same value by a different road:
// the aggregate emits an event carrying the masked field's value, and the
// projection folds that payload into its own row — which every backend serves
// unredacted (a projection row carries no mask marker and no principal is in
// scope on its read routes).  A fold is the ordinary way to build a read model,
// so it is the cheapest of the three bypasses, not the most exotic.
//
// The taint is computed per masked aggregate: an `emit`ted event field whose
// value expression reads a `mask unless` field — directly (`salary`,
// `this.salary`), through a `derived` that reads one, or through a `let` bound
// to either — marks the EVENT as carrying masked data.  A projection folding
// such an event is refused with the same code as the read bypass.
// ---------------------------------------------------------------------------

/** The masked field a single expression reads, or null.  `masked` holds the
 *  aggregate's `mask unless` field names plus every `derived` that reads one;
 *  `taintedLets` maps a body-local `let` name to the masked field it carries. */

function firstMaskedRead(
  e: ExprIR,
  masked: ReadonlySet<string>,
  taintedLets: ReadonlyMap<string, string>,
): string | null {
  let hit: string | null = null;
  walkExprDeep(e, (n) => {
    if (hit !== null) return;
    if (n.kind === "ref") {
      const selfProp =
        n.refKind === "this-prop" || n.refKind === "this-vo-prop" || n.refKind === "this-derived";
      if (selfProp && masked.has(n.name)) {
        hit = n.name;
        return;
      }
      if (n.refKind === "let") {
        const via = taintedLets.get(n.name);
        if (via !== undefined) hit = via;
      }
      return;
    }
    if (n.kind === "member" && n.receiver.kind === "this" && masked.has(n.member)) hit = n.member;
  });
  return hit;
}

/** Map every event whose emitted payload carries a `mask unless` value to the
 *  `<Aggregate>.<field>` that laundered into it. */

export function maskLaunderingEvents(ctx: BoundedContextIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const agg of ctx.aggregates) {
    const maskedFields = agg.fields.filter((f) => f.maskUnless).map((f) => f.name);
    if (maskedFields.length === 0) continue;
    const masked = new Set(maskedFields);
    // A `derived` whose expression reads a masked field carries the same value.
    for (const d of agg.derived) {
      if (firstMaskedRead(d.expr, masked, new Map())) masked.add(d.name);
    }
    for (const op of [...agg.operations, ...(agg.creates ?? []), ...(agg.destroys ?? [])]) {
      const stmts: StmtIR[] = [];
      for (const s of op.statements) walkStmtsDeep(s, (n) => stmts.push(n));
      // Fixpoint over `let` bindings so declaration order (or nesting inside a
      // lambda block) can't hide a chain `let a = salary` / `let b = a`.
      const taintedLets = new Map<string, string>();
      for (let changed = true; changed; ) {
        changed = false;
        for (const s of stmts) {
          if (s.kind !== "let" || taintedLets.has(s.name)) continue;
          const via = firstMaskedRead(s.expr, masked, taintedLets);
          if (via !== null) {
            taintedLets.set(s.name, via);
            changed = true;
          }
        }
      }
      for (const s of stmts) {
        if (s.kind !== "emit" || out.has(s.eventName)) continue;
        for (const f of s.fields) {
          const via = firstMaskedRead(f.value, masked, taintedLets);
          if (via !== null) {
            out.set(s.eventName, `${agg.name}.${via}`);
            break;
          }
        }
      }
    }
  }
  return out;
}

export const FIELD_MASK_BACKENDS = new Set<string>(["node", "dotnet", "python", "java", "elixir"]);

export function validateFieldMask(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const unsupported = [...backendPlatforms].filter((p) => !FIELD_MASK_BACKENDS.has(p));
  const anyBackend = backendPlatforms.size > 0;
  for (const agg of ctx.aggregates) {
    const masked = agg.fields.filter((f) => f.maskUnless);
    if (masked.length === 0) continue;
    for (const f of masked) {
      const offending = firstNonGateRef(f.maskUnless!, GATE_ALLOWED_REFS);
      if (offending !== null) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-not-current-user",
          message: diagMessage("loom.field-mask-not-current-user", {
            name: agg.name,
            fName: f.name,
            offending,
          }),
          source: `${ctx.name}/${agg.name}.${f.name}`,
        });
      }
    }
    if (anyBackend && unsupported.length === 0) continue;
    const names = masked.map((f) => f.name).join(", ");
    diags.push({
      severity: "error",
      code: "loom.field-mask-unsupported",
      message: diagMessage("loom.field-mask-unsupported", {
        name: agg.name,
        names,
        unsupported: unsupported.join("/"),
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  }
  // Query-time projection responses are NOT yet mask-redacted — the shorthand
  // (no `select`) serialises the source aggregate's full wire, and a `select`
  // may read any field — so a masked aggregate can't be a query-time projection
  // source (it would leak the field past the mask).  An honest bound until
  // projection read-masking lands; the field surface itself stays supported.
  const maskedAggNames = new Set(
    ctx.aggregates.filter((a) => a.fields.some((f) => f.maskUnless)).map((a) => a.name),
  );
  if (maskedAggNames.size > 0) {
    const launderingEvents = maskLaunderingEvents(ctx);
    for (const proj of ctx.projections) {
      // `maskedAggNames` holds only aggregate names, so a `source` match is an
      // aggregate source (a workflow / projection source can't collide).
      const src = proj.query?.source;
      if (src && maskedAggNames.has(src)) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-projection-source",
          message: diagMessage("loom.field-mask-projection-source", { name: proj.name, src }),
          source: `${ctx.name}/projection/${proj.name}`,
        });
        continue;
      }
      // A `join` reaches the masked aggregate just as directly as `from` does —
      // `select leaked = c.ssn` off a join alias emitted the raw column on all
      // five backends while the identical read through `from` was rejected.
      // Checking only the source made the bound bypassable by adding a join,
      // which is the opposite of a bound.  Same rule, same diagnostic.
      const joined = (proj.query?.joins ?? []).find((j) => maskedAggNames.has(j.aggregate));
      if (joined) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-projection-source",
          message: diagMessage("loom.field-mask-projection-source", {
            name: proj.name,
            src: joined.aggregate,
            via: "join",
          }),
          source: `${ctx.name}/projection/${proj.name}`,
        });
        continue;
      }
      // A FOLD launders the same value through the event bus: `emit Raised {
      // newSalary: salary }` carries the masked column into a projection row
      // that every backend serves in the clear.  Same rule, same code.
      const laundered = proj.handlers.find((h) => launderingEvents.has(h.event));
      if (laundered) {
        diags.push({
          severity: "error",
          code: "loom.field-mask-projection-source",
          message: diagMessage("loom.field-mask-projection-source#fold", {
            name: proj.name,
            event: laundered.event,
            field: launderingEvents.get(laundered.event),
          }),
          source: `${ctx.name}/projection/${proj.name}`,
        });
      }
    }
  }
}

// Per-operation audit-record emission (`operation … audited`) is implemented for
// the Hono (`node`), .NET (`dotnet`), Java (`java`), Python (`python`) and
// elixir-VANILLA backends — an audited public route / command handler / service
// method appends a who/what/when + before/after snapshot to the audit sink in
// the operation's save transaction.  Audited LIFECYCLE actions
// (`audited create` / `destroy`) ship on the same set — the create/destroy
// handlers stage the audit row (before:null/after=wire on create;
// before=wire/after:null on destroy) in the lifecycle transaction.  Hosting an
// `audited` action on a backend that doesn't emit the runtime would silently
// record nothing — that mismatch is an error, not a silent no-op.  (This gates
// the per-operation `audited` flag only; the `with audit` capability macro emits
// stamping rules via `contextStamps`, a separate concern.)

const AUDIT_OP_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);

const AUDIT_LIFECYCLE_BACKENDS = new Set(["node", "dotnet", "java", "python", "elixir"]);

export function validateAuditedOperationSupport(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const anyBackend = backendPlatforms.size > 0;
  const opUnsupported = [...backendPlatforms].filter((p) => !AUDIT_OP_BACKENDS.has(p));
  const lifecycleUnsupported = [...backendPlatforms].filter(
    (p) => !AUDIT_LIFECYCLE_BACKENDS.has(p),
  );
  const push = (
    agg: BoundedContextIR["aggregates"][number],
    kind: "operation" | "lifecycle action",
    names: string[],
    unsupported: string[],
    capable: string,
  ): void => {
    const hostNote =
      unsupported.length > 0
        ? `it is hosted by ${unsupported.join(", ")}, where audit-record emission is not implemented`
        : `no audit-capable (${capable}) backend deployable hosts this context`;
    diags.push({
      severity: "error",
      code: "loom.audited-backend-unsupported",
      message: diagMessage("loom.audited-backend-unsupported", {
        name: agg.name,
        kind,
        names: names.join(", "),
        capable,
        hostNote,
      }),
      source: `${ctx.name}/${agg.name}`,
    });
  };
  const capableLabel = "Hono (node) / .NET (dotnet) / Java (java) / Python (python) / elixir";
  for (const agg of ctx.aggregates) {
    const auditedOps = agg.operations.filter((o) => o.audited);
    if (auditedOps.length > 0 && (!anyBackend || opUnsupported.length > 0)) {
      push(
        agg,
        "operation",
        auditedOps.map((o) => o.name),
        opUnsupported,
        capableLabel,
      );
    }
    const auditedLifecycle = [...(agg.creates ?? []), ...(agg.destroys ?? [])].filter(
      (o) => o.audited,
    );
    if (auditedLifecycle.length > 0 && (!anyBackend || lifecycleUnsupported.length > 0)) {
      push(
        agg,
        "lifecycle action",
        auditedLifecycle.map((o) => o.name || "<create>"),
        lifecycleUnsupported,
        capableLabel,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// `audited` / `provenanced` × a RETURNING operation (audit 2026-08-24, A6).
//
// The Hono route builder dispatches to `emitReturningOperationRoute` only when
// `op.returnType && !audit && !prov && !op.extern`; otherwise the operation
// falls into the void-204 handler.  For
// `operation take(n: int) audited : Item or NotFound` that means the route
// DECLARES 204 only, throws the tagged result away, and audits `status: "ok"`
// even when the operation returned its error variant — one keyword silently
// rewriting the HTTP contract, with no diagnostic anywhere.  An in-code comment
// called it "a later slice"; nothing gated it.
//
// Python emits both halves correctly (the audit record AND the tagged result +
// its 7807 translation), so this is a per-backend gap, not a language one —
// hence a hosting check rather than a structural one.  The refusal is the
// honest version of the existing behaviour until the node returning route
// folds the audit transaction in.

const AUDITED_RETURNING_UNSUPPORTED = new Set(["node"]);

export function validateAuditedReturningOperationSupport(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const offending = [...backendPlatforms].filter((p) => AUDITED_RETURNING_UNSUPPORTED.has(p));
  if (offending.length === 0) return;
  for (const agg of ctx.aggregates) {
    for (const op of agg.operations) {
      // Only a PUBLIC op drives a route at all, and only a route can lose a
      // return contract — mirrors `auditOps`/`provOps` in the route builder.
      if (!op.returnType || op.visibility !== "public") continue;
      // `extern` returning ops are a separate (declared) seam — the body lives
      // outside the toolchain, so the void fall-through is not this bug.
      if (op.extern) continue;
      const modifier = op.audited ? "audited" : opHasProvSite(op) ? "provenanced" : undefined;
      if (!modifier) continue;
      diags.push({
        severity: "error",
        code: "loom.audited-returning-operation-unsupported",
        message: diagMessage("loom.audited-returning-operation-unsupported", {
          name: agg.name,
          op: op.name,
          modifier,
          platforms: offending.join(", "),
        }),
        source: `${ctx.name}/${agg.name}`,
      });
    }
  }
}
