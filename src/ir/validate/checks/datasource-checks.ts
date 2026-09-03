// -------------------------------------------------------------------------
// DataSource coverage, file-field object-storage, saving-shape support, the
// vanilla-document (Phoenix/Ecto document-shaped) op-body support gate, and
// the honest-note pass over unwired dataSource knobs.  Split out of
// system-checks.ts by packet 2.6 (wave-2) — mechanical move, no logic
// change.  (`coverageGapReason`, `UnwiredKnob` and `UNWIRED_KNOBS` were
// physically far from their sole caller/user in the original file; moved
// alongside it here — a pure relocation of private, non-exported helpers,
// no behavior change.)
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import {
  platformOwnsBackend,
  platformSavingShapes,
} from "../../../language/validators/data/platform-rules.js";
import { lowerFirst, snake } from "../../../util/naming.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DataSourceIR,
  EnrichedAggregateIR,
  ExprIR,
  FunctionIR,
  OperationIR,
  SavingShape,
  StmtIR,
  SystemIR,
} from "../../types/loom-ir.js";
import { aggregateFileField } from "../../util/file-field.js";
import { opHasProvSite } from "../../util/prov-id.js";
import {
  dataSourceKindForAggregate,
  effectiveSavingShape,
  isDocumentShaped,
  resolveDataSourceConfig,
} from "../../util/resolve-datasource.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// ---------------------------------------------------------------------------
// DataSource coverage — every backend deployable must declare a
// matching `dataSource` for every (context, persistence-kind) pair it
// hosts.  A stateBased aggregate needs `kind: state`; an eventSourced
// aggregate needs `kind: eventLog`.  Without a binding, the emitter
// has no schema / connection routing config to emit — so the omission
// is an authoring mistake, not a meaningful default.
//
// Only fires for backend deployables (dotnet, node, phoenix).
// Frontend-only platforms (react, static) own no database and can't
// have a dataSource to point at.
// ---------------------------------------------------------------------------

export function validateDataSourceCoverage(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const dsByName = new Map<string, DataSourceIR>();
  for (const d of sys.dataSources) dsByName.set(d.name, d);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    // Resolve the listed dataSources to their (ctx, kind) coverage set.
    const covered = new Set<string>();
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      covered.add(`${ds.contextName}:${ds.kind}`);
    }
    // For every hosted aggregate, demand a matching dataSource entry.
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const kind = dataSourceKindForAggregate(agg as EnrichedAggregateIR);
        const key = `${ctxName}:${kind}`;
        if (covered.has(key)) continue;
        diags.push({
          severity: "error",
          code: "loom.persistence-mode-unsupported",
          message: diagMessage("loom.persistence-mode-unsupported", {
            name: dep.name,
            ctxName,
            aggName: agg.name,
            persistedAs: agg.persistedAs ?? "state",
            kind,
            ctxName2: lowerFirst(ctxName),
            kind2: kind === "state" ? "State" : "EventLog",
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }

    // Inverse direction: a dataSource listed on a deployable but
    // covering nothing in the hosted contexts is dead config.  An
    // `eventLog` binding against a context that has only stateBased
    // aggregates routes no data; a `state` binding when every
    // aggregate is eventSourced is similarly inert.  This catches
    // edits-in-progress (renamed a strategy and forgot to drop the
    // old binding) and copy-paste from another deployable.  Warning
    // (not error) because the user may be staging a binding for an
    // aggregate they're about to add — but we still want it on the
    // Problems panel.
    const hostedContexts = new Set(dep.contextNames);
    for (const dsName of dep.dataSourceNames ?? []) {
      const ds = dsByName.get(dsName);
      if (!ds) continue;
      if (!hostedContexts.has(ds.contextName)) continue;
      // The 'for: <ctx> not in contexts:' error is already raised by
      // the AST validator (checkDeployableDataSources); skip here so
      // the user gets one diagnostic per mistake, not two.
      const ctx = ctxByName.get(ds.contextName);
      if (!ctx) continue;
      const reason = coverageGapReason(ds.kind, ctx);
      if (!reason) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-unused",
        message: diagMessage("loom.datasource-unused", {
          name: dep.name,
          dsName: ds.name,
          kind: ds.kind,
          contextName: ds.contextName,
          reason,
        }),
        source: `${sys.name}/${dep.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// File-field object-storage coverage.  A `File` primitive is passive/
// wire-only: it stores a `FileRef` reference in the row (JSONB), while the
// bytes live in an object store.  A backend deployable that hosts a
// File-bearing aggregate must therefore bind at least one `objectStore`
// dataSource (an `s3` / `localDisk` storage), or the upload/download
// endpoints have nowhere to put the bytes.  Frontend-only platforms own no
// storage and can't bind one, so they're skipped (a react frontend serves
// the wire shape, not the object).
// ---------------------------------------------------------------------------

export function validateFileFieldObjectStorage(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const dsByName = new Map<string, DataSourceIR>();
  for (const d of sys.dataSources) dsByName.set(d.name, d);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const hasObjectStore = (dep.dataSourceNames ?? []).some(
      (n) => dsByName.get(n)?.kind === "objectStore",
    );
    if (hasObjectStore) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const fileField = aggregateFileField(agg as AggregateIR);
        if (!fileField) continue;
        diags.push({
          severity: "error",
          code: "loom.file-field-needs-object-storage",
          message: diagMessage("loom.file-field-needs-object-storage", {
            name: dep.name,
            ctxName,
            aggName: agg.name,
            fileField,
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Saving-shape capability (D-DOCUMENT-AXIS).  An aggregate's effective
// `shape: …` must be one the hosting backend can actually emit.  Today
// the matrix is partial — .NET / Hono emit all three (relational /
// embedded / document); Phoenix emits only relational — so a
// `shape: document` aggregate on a Phoenix deployable would otherwise
// emit *relationally*, silently mismatching the per-shape migration.
// This turns that footgun into a clear error (the capability tier).
//
// Per-projection: the effective shape is resolved binding-aware (a
// `resource { shape: … }` override wins over the aggregate header), the
// same way the migration + backend emitters resolve it, so the check
// matches what would actually be produced.  Frontend platforms own no
// persistence (platformSavingShapes → undefined) and are skipped.
// ---------------------------------------------------------------------------

export function validateSavingShapeSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const base = platformSavingShapes(dep.platform);
    if (!base) continue;
    // elixir (plain Ecto) emits the opaque `(id, data, version)` document table
    // + a schemaless-changeset validated fold, so it supports `document` on top
    // of the platform's relational / embedded set.
    const supported =
      dep.platform === "elixir" ? ([...base, "document"] as readonly SavingShape[]) : base;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        if (supported.includes(shape)) continue;
        diags.push({
          severity: "error",
          code: "loom.saving-shape-unsupported",
          message: diagMessage("loom.saving-shape-unsupported", {
            name: dep.name,
            platform: dep.platform,
            ctxName,
            aggName: agg.name,
            shape,
            supported: supported.join(", "),
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Vanilla `shape: document` scope (DEBT-07).  The vanilla document path emits the
// CRUD surface (list / get / create / update / delete) over the `(id, data,
// version)` jsonb row, PLUS — since DEBT-07 — SCALAR custom finds (in-memory
// filter over the loaded rows) and SCALAR named operations (the body runs over
// the normalised `data` map, then persists through the document repository's
// `update/2`).  A document blob has no flattened struct columns, so a handful of
// op/find shapes still need machinery the document path deliberately omits, and
// those stay gated (an honest error rather than a mis-emit):
//
//   - a PROVENANCED op — it drains a per-write history buffer into co-located
//     `<field>_provenance` COLUMNS, and a jsonb blob has none;
//   - a body/filter that reads a DERIVED (not persisted, so no `data` key) or a
//     *dereferenced-entity* member (a cross-aggregate `X id` → needs a join);
//   - a value-object METHOD call, or a value-object / private-operation /
//     domain-service / resource call — these need the loaded struct the blob
//     stores as a plain map;
//   - a collection op over a REFERENCE collection (`X id[]`): the relational
//     path resolves it through a `many_to_many` join table, and a blob has no
//     join to resolve.
//
// Everything else is emitted — scalar `assign` / `+=` / `-=` / `precondition` /
// `requires` / `let` / `emit`, value-object SUB-field reads, pure `function`
// calls, RETURNING and AUDITED ops (the persist tail runs in a
// `Repo.transaction`), containment mutation, paged and union finds, and
// collection READS over the aggregate's own in-memory lists (Route A made a
// containment a real `embeds_many` and a scalar array an `{:array, _}` field,
// so `lines.sum(l => l.qty)` renders through the shared collection-op table
// verbatim — see `docInMemoryList`).
// ---------------------------------------------------------------------------

const VANILLA_DOC_CRUD_OPS = new Set(["create", "update", "delete", "destroy", "list", "get"]);

/** Is `e` a read of a list the DOCUMENT path holds IN MEMORY?
 *
 *  Route A made a containment a real `embeds_many` on the `<Agg>.Data` embed,
 *  so `record.lines` rehydrates to a list of part STRUCTS and a scalar array is
 *  an `{:array, _}` field — both are ordinary Elixir lists by the time an op
 *  body or find predicate runs, which is exactly what the shared collection-op
 *  renderers expect.
 *
 *  A REFERENCE collection (`X id[]`) is NOT one of these: the relational path
 *  resolves it through a `many_to_many` join table (`__ref_id_list` /
 *  `__resolve_refs`), and a jsonb blob has no join to resolve. */

function docInMemoryList(e: ExprIR, agg: AggregateIR): boolean {
  // Both spellings of the same read: the bare `lines` an op body writes
  // (`refKind: "this-prop"`) and the explicit `this.lines`.
  const field =
    e.kind === "ref" && (e.refKind === "this-prop" || e.refKind === "this-vo-prop")
      ? e.name
      : e.kind === "member" && e.receiver.kind === "this"
        ? e.member
        : undefined;
  if (field === undefined) return false;
  if (agg.contains.some((c) => c.name === field)) return true;
  const f = agg.fields.find((x) => x.name === field);
  return !!f && f.type.kind === "array" && f.type.element.kind !== "id";
}

/** Does an expression reach a shape the vanilla document scalar path can't emit?
 *  A derived read, a *dereferenced-entity* member (cross-aggregate `X id` join),
 *  a collection METHOD over anything but an in-memory list, a constructor /
 *  match — anything beyond scalar arithmetic, whole-field /
 *  value-object-subfield / `.count` reads over the `data` map, collection reads
 *  over the aggregate's own containments, and (when `allowFnCall`) calls to the
 *  aggregate's own pure `function`s.
 *
 *  `allowFnCall` is true when the aggregate's `function` members are all
 *  themselves doc-safe (verified once per aggregate) — then a `callKind:
 *  "function"` is emittable (the function is rendered in the same `docMap` mode).
 *  It is also passed `true` while verifying each function body, so a function
 *  that calls a sibling function stays admissible (the sibling is verified too —
 *  the whole call graph is checked, no recursion needed here). */

function docExprUnsupported(e: ExprIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  const bad = (x: ExprIR): boolean => docExprUnsupported(x, allowFnCall, agg);
  switch (e.kind) {
    case "ref":
      // A `this-derived` read has no stored `data` key (derived aren't
      // persisted); every other ref (this-prop / this-vo-prop whole read / param
      // / let / enum-value / current-user / a lambda binding) is a plain read.
      return e.refKind === "this-derived";
    case "member":
      // Supported: `this.<scalar>` (receiver `this`, entity type → `data[k]`), a
      // value-object SUB-field (`this.money.amount` → `data["money"]["amount"]`),
      // an array `.count`/`.length` (→ `Enum.count`), and a field of a
      // LAMBDA-BOUND containment element (`lines.sum(l => l.qty)` → `l.qty` over
      // the `%OrderLine{}` structs the embed rehydrates to — the enclosing
      // collection-op arm is what vouches for the list itself).  NOT supported:
      // a member off a *dereferenced* entity (a cross-aggregate `X id` ref →
      // needs a join the document path can't do).
      if (
        e.receiverType.kind === "entity" &&
        e.receiver.kind !== "this" &&
        !(e.receiver.kind === "ref" && e.receiver.refKind === "lambda")
      ) {
        return true;
      }
      return bad(e.receiver);
    case "method-call":
      // A collection op over an IN-MEMORY list — the aggregate's own containment
      // or a scalar array — renders through the shared collection-op table
      // verbatim (`lines.sum(l => l.qty)` → `Enum.sum(Enum.map(record.lines, fn
      // l -> l.qty end))`), because Route A already made those real lists on the
      // rehydrated embed.  Over anything else it is still gated: a REFERENCE
      // collection needs the join table a blob has no equivalent for, and a
      // value-object method needs the loaded VO struct the blob stores as a map.
      if (e.isCollectionOp) {
        return !docInMemoryList(e.receiver, agg) || bad(e.receiver) || e.args.some(bad);
      }
      return (
        e.receiverType.kind === "valueobject" ||
        e.receiverType.kind === "array" ||
        bad(e.receiver) ||
        e.args.some(bad)
      );
    case "lambda":
      // Only reachable as a collection-op argument (the arm above vouches for
      // the receiver list); its body is checked like any other expression.  A
      // statement-bodied lambda has no `body` expression — it is not a shape
      // the document path emits.
      return e.body === undefined || bad(e.body);
    case "call":
      // A pure aggregate `function` call is emittable when the aggregate's
      // functions are doc-safe; every other call kind (value-object ctor, private
      // operation, domain service, resource op) still needs machinery the scalar
      // path omits.
      if (e.callKind === "function" && allowFnCall) return e.args.some(bad);
      return true;
    case "object":
      // A bare object literal — the data map a returning op's error-variant
      // `return TooMany { … }` ships — is a plain map on the document path.
      return e.fields.some((f) => bad(f.value));
    case "binary":
      return bad(e.left) || bad(e.right);
    case "unary":
      return bad(e.operand);
    case "paren":
      return bad(e.inner);
    case "ternary":
      return bad(e.cond) || bad(e.then) || bad(e.otherwise);
    case "convert":
      return bad(e.value);
    case "literal":
    case "id":
    case "this":
      return false;
    default:
      // new / match / list / *-call — all need the struct / list / tuple
      // machinery the document scalar path omits.
      return true;
  }
}

/** Does a pure `function` body reach a non-doc-safe shape?  Sibling-function
 *  calls are admitted (`allowFnCall` true) because every function is checked, so
 *  the whole graph is verified without recursing here. */

function docFunctionUnsupported(fn: FunctionIR, agg: AggregateIR): boolean {
  const body = fn.body;
  const exprs: ExprIR[] = "expr" in body ? [body.expr] : [];
  if ("stmts" in body) {
    for (const s of body.stmts) {
      switch (s.kind) {
        case "precondition":
        case "requires":
        case "let":
        case "expression":
          exprs.push(s.expr);
          break;
        case "return":
          exprs.push(s.value);
          break;
        case "call":
          exprs.push(...s.args);
          break;
      }
    }
  }
  return exprs.some((e) => docExprUnsupported(e, /* allowFnCall */ true, agg));
}

/** Is the value of a containment `+=`/`-=` a doc-safe part constructor?  Route A:
 *  `lines += OrderLine { sku: …, qty: … }` appends a part struct to the embed's
 *  `embeds_many` list, so the value must be a part ctor (`new`/`object`) whose
 *  field values are themselves doc-safe scalars/VOs. */

function docContainmentValueUnsupported(
  e: ExprIR,
  allowFnCall: boolean,
  agg: AggregateIR,
): boolean {
  if (e.kind === "new" || e.kind === "object") {
    return e.fields.some((f) => docExprUnsupported(f.value, allowFnCall, agg));
  }
  // A `-=` may pass a bare element/predicate — fall back to the scalar check.
  return docExprUnsupported(e, allowFnCall, agg);
}

/** Does an operation statement fall outside the vanilla document op surface?
 *  `allowFnCall` mirrors {@link docExprUnsupported}; `agg` distinguishes a
 *  CONTAINMENT collection (embeds_many — mutable on document, Route A) from a
 *  reference/value collection (still gated). */

function docStmtUnsupported(s: StmtIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  const bad = (e: ExprIR): boolean => docExprUnsupported(e, allowFnCall, agg);
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      return bad(s.expr);
    case "assign":
      // A nested write target (`money.amount := …`, `segments.length > 1`) has no
      // single field to struct-update — the path only writes top-level fields.  A
      // whole-field write (incl. replacing a value object) is fine.
      return s.target.segments.length > 1 || bad(s.value);
    case "add":
    case "remove": {
      // Scalar compound arithmetic (`total += n`) is fine.  A COLLECTION mutation
      // is supported ONLY for a CONTAINMENT (`lines += Item{…}`): the relational
      // add/remove arm appends/removes a part struct and the op re-embeds the
      // mutated list via `put_embed` (boot-verified).  A
      // reference collection (`X id[]` → many_to_many) and a scalar value
      // collection stay gated (no join table / not-yet-wired on a document blob).
      if (s.collection) {
        const field = snake(s.target.segments[0] ?? "");
        const isContainment = agg.contains.some((c) => snake(c.name) === field);
        if (!isContainment) return true;
        return (
          s.target.segments.length > 1 || docContainmentValueUnsupported(s.value, allowFnCall, agg)
        );
      }
      return s.target.segments.length > 1 || bad(s.value);
    }
    case "emit":
      return s.fields.some((f) => bad(f.value));
    case "return":
      // A returning op's `return <value>` — an error-variant object literal is a
      // plain response map.  A private-operation self-call in tail position stays
      // gated (`docExprUnsupported` rejects the non-function call).
      return bad(s.value);
    default:
      // call / variant-match — need the self-call / frontend machinery the
      // document op path doesn't carry.
      return true;
  }
}

/** A user-defined document operation the path can't emit.  `allowFnCall` is set
 *  once per aggregate from whether its `function`s are all doc-safe.  A RETURNING
 *  op is admitted (persisting tagged tuple, #1774) and CONTAINMENT mutation is
 *  admitted; an AUDITED op — named or returning — is admitted (the persist tail
 *  records an audit row in a `Repo.transaction`).  A
 *  PROVENANCED op stays gated (a jsonb blob has no co-located `<field>_provenance`
 *  columns to drain a history buffer into). */

function docOpUnsupported(op: OperationIR, allowFnCall: boolean, agg: AggregateIR): boolean {
  return opHasProvSite(op) || op.statements.some((s) => docStmtUnsupported(s, allowFnCall, agg));
}

export function validateVanillaDocumentScope(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (dep.platform !== "elixir") continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        if (!isDocumentShaped(enriched, resolveDataSourceConfig(enriched, ctx, sys))) continue;
        // A pure `function` call is emittable only when every function on the
        // aggregate is itself doc-safe (they render in the same `docMap` mode —
        // reading the jsonb `data` map); if any is not, a body that calls one is
        // gated.  Computed once here and threaded into the op/find checks.
        const allowFnCall = (agg.functions ?? []).every((fn) => !docFunctionUnsupported(fn, agg));
        // A custom find is unsupported only when its predicate reads a non-scalar
        // shape.  PAGED and UNION finds are supported: `renderDocFindFn`
        // returns the single-get `{:ok, nil}`/
        // `{:ok, record}` tuple the shared find controller translates to the tagged
        // union wire (found → 200 body, absent → 404 / RFC-7807 via `problem_variant`).
        const badFinds = (
          (ctx.repositories ?? []).find((r) => r.aggregateName === agg.name)?.finds ?? []
        )
          .filter((f) => f.name !== "all")
          .filter((f) => f.filter != null && docExprUnsupported(f.filter, allowFnCall, agg));
        const badOps = agg.operations
          .filter((op) => !VANILLA_DOC_CRUD_OPS.has(op.name))
          .filter((op) => docOpUnsupported(op, allowFnCall, agg));
        if (badFinds.length === 0 && badOps.length === 0) continue;
        const bits: string[] = [];
        if (badOps.length > 0)
          bits.push(`named operation(s) ${badOps.map((o) => o.name).join(", ")}`);
        if (badFinds.length > 0)
          bits.push(`custom find(s) ${badFinds.map((f) => f.name).join(", ")}`);
        diags.push({
          severity: "error",
          code: "loom.vanilla-document-unsupported",
          message: diagMessage("loom.vanilla-document-unsupported", {
            ctxName,
            name: agg.name,
            bits: bits.join(" and "),
          }),
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

function coverageGapReason(kind: string, ctx: BoundedContextIR): string | undefined {
  const aggs = ctx.aggregates;
  if (aggs.length === 0) return "the context declares no aggregates";
  const hasState = aggs.some((a) => (a.persistedAs ?? "state") === "state");
  const hasES = aggs.some((a) => a.persistedAs === "eventLog");
  if (kind === "state" && !hasState) {
    return "every aggregate is persistedAs: eventLog (none need kind: state persistence)";
  }
  if ((kind === "eventLog" || kind === "snapshot") && !hasES) {
    return "no aggregate is persistedAs: eventLog (kind: " + kind + " has no event stream to back)";
  }
  // cache / replica only require at least one aggregate, already
  // checked above.
  return undefined;
}

// ---------------------------------------------------------------------------
// Honest-note pass: warn on dataSource knobs the AST validator accepts
// but no current emitter consumes.
//
// At time of writing, three knobs route through to generated code:
//   - `schema`       — EF Core ToTable, Drizzle pgSchema, Ecto schema prefix
//   - `tablePrefix`  — same three emitters (table-name prefix)
//
// The other six knobs validate against the kind/storage compatibility
// matrix in `src/language/validators/datasource.ts` but no emitter
// reads them.  Setting one is a no-op at runtime:
//
//   - `ttl`            — would gate a Redis-backed cache adapter that
//                        doesn't exist yet
//   - `every` / `retain` — would gate snapshot policy on an event-
//                        sourced persister (Marten / hono-ES adapter)
//                        that doesn't exist yet
//   - `readonly`       — would gate a replica-aware DbContext that
//                        doesn't exist yet
//   - `keyPrefix`      — would gate the same Redis cache adapter
//                        gated by `ttl`
//
// `isolationLevel` is NOT on this list: it flows through
// `resolveWorkflowIsolation` into the .NET BeginTransactionAsync and
// Phoenix `Repo.transaction` opts when a workflow in the context is
// transactional and doesn't carry its own per-workflow isolation.
//
// We surface this as a warning at IR-validate time so the author sees
// "validation accepts this but it's a no-op" instead of believing the
// knob has effect.  When an adapter lands that consumes one of these,
// the corresponding entry comes off the list — the truth-telling is
// in code, not in a doc that goes stale.
// ---------------------------------------------------------------------------

interface UnwiredKnob {
  property: keyof DataSourceIR;
  description: string;
}

const UNWIRED_KNOBS: readonly UnwiredKnob[] = [
  { property: "ttl", description: "no Redis-backed cache adapter is implemented yet" },
  {
    property: "every",
    description: "no event-sourced persister with snapshot policy is implemented yet",
  },
  {
    property: "retain",
    description: "no event-sourced persister with snapshot policy is implemented yet",
  },
  { property: "readonly", description: "no replica-aware persister is implemented yet" },
  { property: "keyPrefix", description: "no Redis-backed cache adapter is implemented yet" },
  // Note: the `shape:` knob (D-DOCUMENT-AXIS) is NOT listed here — it is
  // consumed by the backend emitters (relational / embedded / document),
  // and an unsupported shape for a given backend is rejected by the
  // per-PLATFORM saving-shape capability check, not warned as inert.
];

export function validateDataSourceUnwiredKnobs(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const ds of sys.dataSources) {
    for (const knob of UNWIRED_KNOBS) {
      const value = ds[knob.property];
      if (value === undefined) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-knob-unwired",
        message: diagMessage("loom.datasource-knob-unwired", {
          name: ds.name,
          property: knob.property,
          description: knob.description,
        }),
        source: `${sys.name}/${ds.name}`,
      });
    }
  }
}
