// -------------------------------------------------------------------------
// Structural checks — workspace-scope uniqueness, find-name collisions,
// unimplemented generics, extern ops, event-sourced discipline,
// current-user scope, permission refs, and whole-model expr integrity.
// -------------------------------------------------------------------------

import { allPlatforms } from "../../../platform/registry.js";
import { isStdlibError } from "../../../util/error-defaults.js";
import type {
  BoundedContextIR,
  EnrichedLoomModel,
  ExprIR,
  FunctionIR,
  StmtIR,
  TypeIR,
} from "../../types/loom-ir.js";
import { allContexts } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

// ---------------------------------------------------------------------------
// Workspace uniqueness — multi-file (Stage A) makes it easy to declare
// two `valueobject Money` in different files, two `context Sales`, or
// shadow a context-local VO with a root-level one of the same name.
// Each of those would silently merge / collide in IR; surface them as
// errors here so the user sees a clear message instead of a confused
// downstream failure (duplicate import in the emitted TS, duplicate
// class in .NET, etc.).
// ---------------------------------------------------------------------------

export function validateWorkspaceUniqueness(
  loom: EnrichedLoomModel,
  diags: LoomDiagnostic[],
): void {
  // Duplicate root-level value object names.
  const rootVoSeen = new Set<string>();
  for (const vo of loom.rootValueObjects) {
    if (rootVoSeen.has(vo.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-valueobject",
        source: `valueobject ${vo.name}`,
        message: `duplicate root-level value object '${vo.name}' — declare it once in the workspace.`,
      });
    } else {
      rootVoSeen.add(vo.name);
    }
  }
  // Duplicate root-level enum names.
  const rootEnumSeen = new Set<string>();
  for (const e of loom.rootEnums) {
    if (rootEnumSeen.has(e.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-enum",
        source: `enum ${e.name}`,
        message: `duplicate root-level enum '${e.name}' — declare it once in the workspace.`,
      });
    } else {
      rootEnumSeen.add(e.name);
    }
  }
  // Duplicate system names.
  const sysSeen = new Set<string>();
  for (const s of loom.systems) {
    if (sysSeen.has(s.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-system",
        source: `system ${s.name}`,
        message: `duplicate system '${s.name}' — declare each system once across the workspace.`,
      });
    } else {
      sysSeen.add(s.name);
    }
  }
  // Duplicate context names across the workspace (any combination
  // of loose contexts + module-nested ones).  A context name is the
  // unit of governance and emission; duplicates would silently merge
  // in the file map.
  const ctxSeen = new Set<string>();
  for (const c of allContexts(loom)) {
    if (ctxSeen.has(c.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-context",
        source: `context ${c.name}`,
        message: `duplicate context '${c.name}' — context names must be unique across the workspace.`,
      });
    } else {
      ctxSeen.add(c.name);
    }
  }
  // Root-level VO / enum names that collide with a context-local
  // declaration of the same name.  The enrichment pass keeps the
  // context-local version (the root one is dropped for that context)
  // — surface this as an error so the user can rename instead of
  // silently shadowing.
  for (const c of allContexts(loom)) {
    for (const vo of c.valueObjects) {
      if (rootVoSeen.has(vo.name)) {
        // `c.valueObjects` already includes injected root VOs after
        // enrichment; skip the injected copy (same instance as in
        // `loom.rootValueObjects`).
        const injected = loom.rootValueObjects.find((r) => r.name === vo.name);
        if (injected && injected === vo) continue;
        diags.push({
          severity: "error",
          code: "loom.valueobject-shadows-root",
          source: `${c.name}.${vo.name}`,
          message: `context '${c.name}' declares value object '${vo.name}' that shadows the root-level declaration; rename one of them.`,
        });
      }
    }
    for (const e of c.enums) {
      if (rootEnumSeen.has(e.name)) {
        const injected = loom.rootEnums.find((r) => r.name === e.name);
        if (injected && injected === e) continue;
        diags.push({
          severity: "error",
          code: "loom.enum-shadows-root",
          source: `${c.name}.${e.name}`,
          message: `context '${c.name}' declares enum '${e.name}' that shadows the root-level declaration; rename one of them.`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Find-name collision check.  The TS repository emits two methods every
// repo gets for free: `save(aggregate)` and `findById(id)`.  A
// user-declared `find save(...)` or `find findById(...)` produces two
// methods of the same name in the same class — TS's "duplicate
// function implementation" (TS2393) breaks compilation.  The auto-
// included `all` find is enrichment-guarded (`enrichLoomModel` skips
// auto-injection if a user-declared `all` exists) so it doesn't
// collide; `findById` is a reserved keyword in the grammar so the
// parser already rejects it; that leaves `save` as the practical
// failure mode.  We reject any of these names early, with a clear
// message, instead of letting tsc report a confusing duplicate-impl
// error against the generated output.
// ---------------------------------------------------------------------------

/** Union of every registered platform's `reservedRepositoryFindNames`.
 * The validator treats a DSL find name as reserved if ANY platform's
 * generator would emit a colliding repository method, so a context
 * generated for both Hono and .NET stays valid on both. */
function unionReservedFindNames(): Set<string> {
  const out = new Set<string>();
  for (const p of allPlatforms()) {
    for (const n of p.reservedRepositoryFindNames) out.add(n);
  }
  return out;
}

export function validateFindNameCollisions(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  const reserved = unionReservedFindNames();
  for (const repo of ctx.repositories) {
    const seen = new Set<string>();
    for (const find of repo.finds) {
      if (reserved.has(find.name)) {
        diags.push({
          severity: "error",
          code: "loom.find-reserved-name",
          message:
            `repository '${repo.name}' find '${find.name}': name collides with the auto-emitted repository method '${find.name}(...)'. ` +
            `Choose a different find name (e.g. 'persist', 'fetchById').`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
      if (seen.has(find.name)) {
        diags.push({
          severity: "error",
          code: "loom.duplicate-find",
          message: `repository '${repo.name}' declares find '${find.name}' more than once.`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
      seen.add(find.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Generic-payload instantiation gate (payload-transport-layer.md, P3a).
//
// The `paged` / `envelope` carriers parse, lower to a `genericInstance`
// TypeIR, and pass the AST-level carrier-bound check — but emission
// (monomorphization → per-instance DTOs across the four backends) is P3b.
// Until then, any `genericInstance` reachable from a type position is a
// hard error: a generic in a field / find-return / op-signature must be
// emittable, so this blocks the pipeline before a backend renderer sees it
// (the renderers also carry a defensive `throw` for the same kind).  Mirrors
// the "parses + represents in IR, then a not-implemented IR error" staging
// the inheritance track used for TPH.
// ---------------------------------------------------------------------------

/** First generic-constructor name reachable inside a type, or undefined.
 *  Descends array / optional / generic-instance wrappers. */
function firstGenericCtor(type: TypeIR): string | undefined {
  switch (type.kind) {
    case "genericInstance":
      return type.ctor;
    case "array":
      return firstGenericCtor(type.element);
    case "optional":
      return firstGenericCtor(type.inner);
    default:
      return undefined;
  }
}

export function validateGenericInstancesUnimplemented(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Backends that can emit generic carriers (`paged` / `envelope`) today.
  // Grows one slice at a time; when a context is served only by these (or by
  // no backend at all — the legacy single-context path), the carrier is
  // emittable and the gate stays quiet.  React is a frontend, not a backend,
  // so it never appears here — its hooks consume whatever the backend serves.
  // `"node"` is the hono/TS backend's platform identity (realization axes);
  // `"dotnet"` the EF/ASP.NET backend; `"phoenix"` the Ash/Phoenix backend
  // (the `phoenixLiveView` framework keyword canonicalizes to `phoenix`).
  // All four backends now emit generic carriers.
  const SUPPORTED_PAGED_BACKENDS = new Set(["node", "dotnet", "phoenix"]);
  const unsupported = [...backendPlatforms].filter((p) => !SUPPORTED_PAGED_BACKENDS.has(p));
  if (unsupported.length === 0) return;

  const flag = (type: TypeIR, where: string): void => {
    const ctor = firstGenericCtor(type);
    if (!ctor) return;
    diags.push({
      severity: "error",
      code: "loom.generic-carrier-unsupported",
      message:
        `${where} uses the generic carrier '${ctor}', but the backend(s) serving this context ` +
        `(${unsupported.sort().join(", ")}) don't emit it yet (payload-transport-layer.md, P3b). ` +
        `It's supported on: ${[...SUPPORTED_PAGED_BACKENDS].sort().join(", ")}.`,
      source: `${ctx.name}/${where}`,
    });
  };

  // Payload fields.
  for (const p of ctx.payloads) {
    for (const f of p.fields) flag(f.type, `payload ${p.name}.${f.name}`);
  }
  // Repository find returns + params.
  for (const repo of ctx.repositories) {
    for (const find of repo.finds) {
      flag(find.returnType, `repository ${repo.name}.${find.name} return`);
      for (const param of find.params)
        flag(param.type, `repository ${repo.name}.${find.name}(${param.name})`);
    }
  }
  // Aggregates — and their parts — fields, derived, function signatures,
  // operation params.
  for (const agg of ctx.aggregates) {
    flagAggregateLike(agg, `aggregate ${agg.name}`, flag);
    for (const op of agg.operations) {
      for (const param of op.params)
        flag(param.type, `aggregate ${agg.name}.${op.name}(${param.name})`);
    }
    for (const part of agg.parts) flagAggregateLike(part, `part ${part.name}`, flag);
  }
  // Value objects.
  for (const vo of ctx.valueObjects) flagAggregateLike(vo, `valueobject ${vo.name}`, flag);
}

// ---------------------------------------------------------------------------
// Discriminated-union instantiation gate (payload-transport-layer.md, P4a).
//
// Both union surfaces — anonymous `A or B` (in any type position) and named
// `payload Foo = A | B` — lower to a `union` TypeIR, and `T option` lowers to
// `union[T, none]`.  P4a represents these in the IR and validates them
// (duplicate-variant, exhaustiveness), but emission across the four backends
// is P4b–d.  Until then, any `union` reachable from a type position is a hard
// error — emission is wired in slice by slice, releasing this gate per
// backend.  Unconditional (not platform-aware): no backend emits unions yet,
// so a union anywhere blocks the pipeline before a renderer sees it.  Mirrors
// the P3a `genericInstance` staging above.
// ---------------------------------------------------------------------------

/** True iff a `union` (or its `none` unit) is reachable inside a type,
 *  descending array / optional / generic-instance / union wrappers. */
function containsUnion(type: TypeIR): boolean {
  switch (type.kind) {
    case "union":
    case "none":
      return true;
    case "array":
      return containsUnion(type.element);
    case "optional":
      return containsUnion(type.inner);
    case "genericInstance":
      return containsUnion(type.arg);
    default:
      return false;
  }
}

export function validateUnionsUnimplemented(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Backends that emit discriminated-union tagged wire today.  Grows one slice
  // at a time (P4b: hono/TS; P4c: dotnet; P4d: phoenix); React is a frontend,
  // not a backend, so it never appears here — its hooks consume whatever the
  // backend serves.  `"node"` is the hono/TS backend's platform identity.
  // When a context is served only by these (or by no backend at all — the
  // legacy single-context path), unions are emittable and the gate stays quiet.
  const SUPPORTED_UNION_BACKENDS = new Set(["node", "dotnet", "phoenix"]);
  const unsupported = [...backendPlatforms].filter((p) => !SUPPORTED_UNION_BACKENDS.has(p));
  if (unsupported.length === 0) return;

  const flag = (type: TypeIR, where: string): void => {
    if (!containsUnion(type)) return;
    diags.push({
      severity: "error",
      code: "loom.union-unsupported",
      message:
        `${where} uses a discriminated union (\`A or B\` / \`payload = A | B\` / \`T option\`), but ` +
        `the backend(s) serving this context (${unsupported.sort().join(", ")}) don't emit it yet ` +
        `(payload-transport-layer.md, P4c–d). It's supported on: ${[...SUPPORTED_UNION_BACKENDS]
          .sort()
          .join(", ")}.`,
      source: `${ctx.name}/${where}`,
    });
  };

  // Named-union payloads carry `variants`; record payloads carry `fields`.
  for (const p of ctx.payloads) {
    if (p.variants) for (const v of p.variants) flag(v, `payload ${p.name} variant`);
    for (const f of p.fields) flag(f.type, `payload ${p.name}.${f.name}`);
  }
  for (const repo of ctx.repositories) {
    for (const find of repo.finds) {
      flag(find.returnType, `repository ${repo.name}.${find.name} return`);
      for (const param of find.params)
        flag(param.type, `repository ${repo.name}.${find.name}(${param.name})`);
    }
  }
  for (const agg of ctx.aggregates) {
    flagAggregateLike(agg, `aggregate ${agg.name}`, flag);
    for (const op of agg.operations) {
      for (const param of op.params)
        flag(param.type, `aggregate ${agg.name}.${op.name}(${param.name})`);
    }
    for (const part of agg.parts) flagAggregateLike(part, `part ${part.name}`, flag);
  }
  for (const vo of ctx.valueObjects) flagAggregateLike(vo, `valueobject ${vo.name}`, flag);
}

// ---------------------------------------------------------------------------
// Operation-return gate (exception-less.md, spike).
//
// `operation foo(...): X or NotFound { ... return ... }` parses, lowers to an
// `OperationIR.returnType` + `return` statements, and prints — and the Hono/TS
// backend (`"node"`) now emits the producer side: the returned union value is
// tagged at lowering and the operation route translates an `error`-variant
// result to an RFC-7807 ProblemDetails status (a success → HTTP 200).  The
// other backends (dotnet, phoenix) don't emit the route translation yet, so a
// return-typed operation stays a hard error while any of them serve the
// context — mirroring the P3a/P4a/P4c surface-first staging.
// ---------------------------------------------------------------------------

export function validateOperationReturnsUnimplemented(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Backends that emit the operation-return ProblemDetails translation today.
  // `"node"` is the Hono/TS backend (exception-less.md spike); the others land
  // in later slices.  No backend (legacy single-context path) → emittable, gate
  // stays quiet.
  const SUPPORTED_RETURN_BACKENDS = new Set(["node"]);
  const unsupported = [...backendPlatforms].filter((p) => !SUPPORTED_RETURN_BACKENDS.has(p));
  if (unsupported.length === 0) return;

  for (const agg of ctx.aggregates) {
    for (const op of agg.operations) {
      if (!op.returnType) continue;
      diags.push({
        severity: "error",
        code: "loom.operation-return-unsupported",
        message:
          `operation '${agg.name}.${op.name}' declares an \`or\`-union return type, but the ` +
          `backend(s) serving this context (${unsupported.sort().join(", ")}) don't emit the ` +
          `producer-side route translation yet (exception-less.md). It's supported on: ${[
            ...SUPPORTED_RETURN_BACKENDS,
          ]
            .sort()
            .join(", ")}.`,
        source: `${ctx.name}/aggregate ${agg.name}.${op.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Unmapped error status (exception-less.md A1).
//
// A user-declared `error` returned by an operation that is neither a blessed
// stdlib error (which carries a default status) nor given an api `httpStatus
// <Error> <Code>` mapping falls through to a 500 ProblemDetails — almost never
// what the author intended for a domain-specific failure.  Warn (not error) so
// the pipeline still runs, prompting an explicit mapping.
// ---------------------------------------------------------------------------

export function validateUnmappedErrorStatuses(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
  const overrides = ctx.errorStatusOverrides ?? {};
  const errorNames = new Set(ctx.payloads.filter((p) => p.kind === "error").map((p) => p.name));
  for (const agg of ctx.aggregates) {
    for (const op of agg.operations) {
      if (op.returnType?.kind !== "union") continue;
      const flagged = new Set<string>();
      for (const v of op.returnType.variants) {
        if (v.kind !== "entity") continue;
        const name = v.name;
        if (!errorNames.has(name)) continue; // only `error` payloads
        if (isStdlibError(name)) continue; // carries a stdlib default
        if (name in overrides) continue; // explicit api mapping
        if (flagged.has(name)) continue;
        flagged.add(name);
        diags.push({
          severity: "warning",
          code: "loom.unmapped-error-status",
          message:
            `error '${name}' returned by '${agg.name}.${op.name}' has no stdlib default HTTP ` +
            `status and no api \`httpStatus ${name} <code>\` mapping, so it defaults to 500. Add ` +
            `a \`httpStatus ${name} <code>\` line to the api serving this context to set an ` +
            `explicit status.`,
          source: `${ctx.name}/aggregate ${agg.name}.${op.name}`,
        });
      }
    }
  }
}

/** Shared field / derived / function-signature walk for the structural
 *  shapes (aggregate, entity part, value object) that carry all three. */
function flagAggregateLike(
  node: {
    fields: { name: string; type: TypeIR }[];
    derived: { name: string; type: TypeIR }[];
    functions: FunctionIR[];
  },
  where: string,
  flag: (type: TypeIR, where: string) => void,
): void {
  for (const f of node.fields) flag(f.type, `${where}.${f.name}`);
  for (const d of node.derived) flag(d.type, `${where}.${d.name}`);
  for (const fn of node.functions) {
    flag(fn.returnType, `${where}.${fn.name} return`);
    for (const param of fn.params) flag(param.type, `${where}.${fn.name}(${param.name})`);
  }
}

// ---------------------------------------------------------------------------
// `extern` operation validation.
//
// An `operation X(...) extern { precondition ... }` declares that
// the body of X is supplied by user code outside the generated
// tree.  The DSL keeps its grip on:
//   - the operation's parameter list (becomes the request DTO),
//   - the precondition gates (run BEFORE the user's handler fires),
//   - persistence + event drainage (run AFTER the user's handler
//     returns).
//
// The user owns: state mutation, event emission, and integration
// with services Loom doesn't model.
//
// Validator rules:
//   1. extern operations must be public.  A private extern is
//      meaningless — there's no caller inside the aggregate.
//   2. extern bodies must contain ONLY precondition statements.
//      Anything else (assignments, emits, calls, lets) belongs in
//      the user's handler.  Reject up-front so the contract is
//      legible.
// ---------------------------------------------------------------------------

export function validateExternOperations(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const agg of ctx.aggregates) {
    for (const op of agg.operations) {
      if (!op.extern) continue;
      if (op.visibility === "private") {
        diags.push({
          severity: "error",
          code: "loom.extern-on-private-operation",
          message:
            `aggregate '${agg.name}' operation '${op.name}': 'extern' isn't valid on a private operation. ` +
            `Private operations are callable only from inside the aggregate, so there's nowhere for an external handler to plug in. Make the operation public, or drop 'extern'.`,
          source: `${ctx.name}/${agg.name}.${op.name}`,
        });
      }
      for (const stmt of op.statements) {
        if (stmt.kind === "precondition") continue;
        diags.push({
          severity: "error",
          code: "loom.extern-body-not-precondition",
          message:
            `aggregate '${agg.name}' operation '${op.name}': 'extern' bodies may only contain 'precondition' statements (found '${stmt.kind}'). ` +
            `The user-supplied handler owns mutation, emit, and any other logic — leave the .ddd body to the gates that run before it.`,
          source: `${ctx.name}/${agg.name}.${op.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event-sourcing body discipline (D-DOCUMENT-AXIS, appliers Phase A1).
//
// `persistedAs(eventLog)` makes an aggregate event-sourced: its truth is
// the event stream, and state is a fold of that stream.  That imposes a
// body contract distinct from a state-based aggregate:
//
//   1. Appliers (`apply(e: E) { … }`) are only meaningful on an
//      event-sourced aggregate.  On a state-based one they have nothing
//      to fold — flag them.
//   2. Command bodies (`operation` / `create` / `destroy`) decide and
//      `emit`; they must not mutate `this` directly.  The state
//      transition is the applier's job — a command that assigns to
//      `this.x` would bypass the stream and desync the fold.
//   3. Every event a command emits needs a matching applier, or the
//      fold silently drops that transition.
//   4. Applier bodies are pure folds: assignments / collection mutations
//      and `let` bindings only.  No `emit` (an applier reacts to an
//      event, it doesn't raise one), and no side-effecting calls (the
//      fold must be deterministic and replayable).
//   5. At most one applier per event type — two folds for one event are
//      ambiguous.
//
// Emission of the event store / fold / projection layer is the deferred
// Phase A2; this validator establishes the contract the surface promises
// so authors get the discipline checked before any code is generated.
// ---------------------------------------------------------------------------

export function validateEventSourcedDiscipline(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
  for (const agg of ctx.aggregates) {
    const isEventSourced = agg.persistedAs === "eventLog";
    const appliers = agg.appliers ?? [];

    // Rule 1 — appliers require an event-sourced aggregate.
    if (!isEventSourced && appliers.length > 0) {
      diags.push({
        severity: "error",
        code: "loom.applier-on-non-event-sourced",
        message:
          `aggregate '${agg.name}' declares apply(...) but is not event-sourced. ` +
          `Appliers fold events into state; they only apply to a 'persistedAs(eventLog)' aggregate. ` +
          `Add 'persistedAs(eventLog)' to the aggregate header, or remove the applier.`,
        source: `${ctx.name}/${agg.name}`,
      });
    }

    if (!isEventSourced) continue;

    // Rule 6 — event-sourced construction goes through a single canonical
    // creator: the `create` action whose emit-only body raises the creation
    // event drives the `create(...)` factory + POST route.  More than one is
    // ambiguous (the factory would silently use the first); zero is allowed
    // (the aggregate is then constructed out-of-band — e.g. by a workflow —
    // and exposes no create route).
    const creates = agg.creates ?? [];
    if (creates.length > 1) {
      diags.push({
        severity: "error",
        code: "loom.event-sourced-multiple-creates",
        message:
          `aggregate '${agg.name}' is persistedAs(eventLog) and declares ${creates.length} 'create' actions. ` +
          `An event-sourced aggregate has a single canonical creator (v1) — keep one 'create(...)'.`,
        source: `${ctx.name}/${agg.name}`,
      });
    }

    // Rule 5 — one applier per event type.
    const appliersByEvent = new Map<string, number>();
    for (const ap of appliers) {
      appliersByEvent.set(ap.event, (appliersByEvent.get(ap.event) ?? 0) + 1);
    }
    for (const [eventName, count] of appliersByEvent) {
      if (count > 1) {
        diags.push({
          severity: "error",
          code: "loom.duplicate-applier",
          message:
            `aggregate '${agg.name}' declares ${count} appliers for event '${eventName}'. ` +
            `An event folds into state exactly one way — declare a single apply(${eventName}).`,
          source: `${ctx.name}/${agg.name}`,
        });
      }
    }

    // Rules 2 + 3 — command bodies emit-only; emitted events covered.
    const appliedEvents = new Set(appliers.map((a) => a.event));
    const commands: { label: string; statements: StmtIR[] }[] = [
      ...agg.operations.map((op) => ({
        label: `operation '${op.name}'`,
        statements: op.statements,
      })),
      ...(agg.creates ?? []).map((c) => ({
        label: `create '${c.name}'`,
        statements: c.statements,
      })),
      ...(agg.destroys ?? []).map((d) => ({
        label: `destroy '${d.name}'`,
        statements: d.statements,
      })),
    ];
    for (const cmd of commands) {
      for (const stmt of cmd.statements) {
        if (stmt.kind === "assign" || stmt.kind === "add" || stmt.kind === "remove") {
          diags.push({
            severity: "error",
            code: "loom.event-sourced-direct-mutation",
            message:
              `aggregate '${agg.name}' ${cmd.label} mutates 'this' directly, but the aggregate is event-sourced. ` +
              `Command bodies on a 'persistedAs(eventLog)' aggregate decide and 'emit'; the state change belongs in an apply(...) block. ` +
              `Replace the assignment with an 'emit', and fold it in an applier.`,
            source: `${ctx.name}/${agg.name}`,
          });
        }
        if (stmt.kind === "emit" && !appliedEvents.has(stmt.eventName)) {
          diags.push({
            severity: "error",
            code: "loom.emitted-event-unhandled",
            message:
              `aggregate '${agg.name}' ${cmd.label} emits '${stmt.eventName}' but no applier folds it. ` +
              `Every emitted event needs a matching apply(${stmt.eventName}: ${stmt.eventName}) on the aggregate, ` +
              `or the event is recorded but never reflected in state.`,
            source: `${ctx.name}/${agg.name}`,
          });
        }
      }
    }

    // Rule 4 — applier bodies are pure folds.
    for (const ap of appliers) {
      for (const stmt of ap.statements) {
        if (stmt.kind === "emit") {
          diags.push({
            severity: "error",
            code: "loom.applier-emits",
            message:
              `aggregate '${agg.name}' apply(${ap.event}) emits an event. ` +
              `An applier reacts to an event by folding it into state — it must not emit. ` +
              `Move the 'emit' to the command body that decides it.`,
            source: `${ctx.name}/${agg.name}`,
          });
        } else if (stmt.kind === "call") {
          diags.push({
            severity: "error",
            code: "loom.applier-impure-call",
            message:
              `aggregate '${agg.name}' apply(${ap.event}) calls '${stmt.name}'. ` +
              `Applier bodies must be deterministic, replayable folds — assignments and 'let' only, no side-effecting calls.`,
            source: `${ctx.name}/${agg.name}`,
          });
        } else if (stmt.kind === "precondition" || stmt.kind === "requires") {
          diags.push({
            severity: "error",
            code: "loom.applier-guard",
            message:
              `aggregate '${agg.name}' apply(${ap.event}) contains a '${stmt.kind}' statement. ` +
              `Guards belong in the command that decides the event; by the time it is applied the decision is already made.`,
            source: `${ctx.name}/${agg.name}`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Expression-integrity pass.
//
// Catches un-expanded scaffold primitives that escape `walker-primitive-
// expander.ts` (the file's documented contract is that downstream phases
// — enrichment, validation, every backend — "never see the un-expanded
// form"; the early-exit branches at lines 104, 117, 127 violate that
// contract silently when the target aggregate/workflow/view can't be
// resolved).  Backends have no handler for an un-expanded scaffold
// primitive, so they either crash or emit something nonsensical; this
// pass turns the failure into a clear validator error pointing at the
// offending page.
//
// NOTE: `refKind === "unknown"` is NOT a bug — `src/ir/lower/lower-expr.ts:606-608`
// documents it as the intentional shape for e2e test bodies and
// member-chain receivers (e.g. `Order.byId(...)` where `Order` is
// rendered verbatim and the surrounding member node carries the
// resolved semantics).  The workflow-scope check at line 1098 below
// catches the cases where it IS a bug (precondition / requires
// expressions where bare unresolved references are nonsense); we keep
// that check and don't extend it.
// ---------------------------------------------------------------------------

const SCAFFOLD_PRIMITIVE_NAMES: ReadonlySet<string> = new Set([
  "scaffoldDetails",
  "scaffoldOperations",
  "scaffoldList",
  "scaffoldNewForm",
  "scaffoldWorkflowForm",
  "scaffoldViewList",
  "Home",
  "WorkflowsIndex",
  "ViewsIndex",
]);

export function validateExprIntegrity(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  const visitor = (source: string) => (e: ExprIR) => {
    if (e.kind === "call" && SCAFFOLD_PRIMITIVE_NAMES.has(e.name)) {
      diags.push({
        severity: "error",
        code: "loom.scaffold-unexpanded",
        message: `un-expanded scaffold primitive '${e.name}' — walker-primitive-expander could not resolve its target aggregate/workflow/view; check that the referenced symbol exists in the surrounding context.`,
        source,
      });
    }
  };

  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      for (const page of ui.pages) {
        const source = `${sys.name}/${ui.name}/${page.name}`;
        const visit = visitor(source);
        walkExpr(page.body, visit);
        walkExpr(page.title, visit);
        walkExpr(page.requires, visit);
        for (const s of page.state) walkExpr(s.init, visit);
      }
    }
  }

  for (const c of allContexts(loom)) {
    // Workflows — walk every expression-bearing statement.
    for (const wf of c.workflows) {
      const source = `${c.name}/${wf.name}`;
      const visit = visitor(source);
      for (const st of wf.statements) walkExprsInWorkflowStmt(st, visit);
    }
    // Aggregate operations + invariants.
    for (const agg of c.aggregates) {
      for (const op of agg.operations) {
        const source = `${c.name}/${agg.name}/${op.name}`;
        const visit = visitor(source);
        for (const st of op.statements) walkExprsInStmt(st, visit);
      }
      for (const ap of agg.appliers ?? []) {
        const source = `${c.name}/${agg.name}/apply(${ap.event})`;
        const visit = visitor(source);
        for (const st of ap.statements) walkExprsInStmt(st, visit);
      }
      for (const inv of agg.invariants) {
        const source = `${c.name}/${agg.name}/invariant`;
        const visit = visitor(source);
        walkExpr(inv.expr, visit);
        walkExpr(inv.guard, visit);
      }
    }
    // Views — filter + custom output binds.
    for (const v of c.views) {
      const source = `${c.name}/${v.name}`;
      const visit = visitor(source);
      walkExpr(v.filter, visit);
      if (v.output) {
        for (const b of v.output.binds) walkExpr(b.expr, visit);
      }
    }
  }
}

function walkExprsInWorkflowStmt(
  s: import("../../types/loom-ir.js").WorkflowStmtIR,
  visit: (e: ExprIR) => void,
): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
      walkExpr(s.expr, visit);
      break;
    case "emit":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
    case "factory-let":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
    case "repo-let":
      for (const a of s.args) walkExpr(a, visit);
      break;
    case "expr-let":
      walkExpr(s.expr, visit);
      break;
    case "op-call":
      for (const a of s.args) walkExpr(a, visit);
      break;
    // Other WorkflowStmtIR shapes that carry no expression payload
    // (savepoints, mark-as-failed, etc.) need no traversal.
  }
}

function walkExprsInStmt(
  s: import("../../types/loom-ir.js").StmtIR,
  visit: (e: ExprIR) => void,
): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
    case "let":
    case "expression":
      walkExpr(s.expr, visit);
      break;
    case "assign":
    case "add":
    case "remove":
      walkExpr(s.value, visit);
      break;
    case "emit":
      for (const f of s.fields) walkExpr(f.value, visit);
      break;
    case "call":
      for (const a of s.args) walkExpr(a, visit);
      break;
  }
}

/** Walk every expression inside an entity's invariants, derived
 *  properties, function bodies, view filters, and repository find
 *  filters; flag any `current-user` ref found there.  Uses the
 *  existing `walkExpr` helper. */
export function validateCurrentUserScope(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  const flag = (location: string, expr: ExprIR | undefined): void => {
    if (!expr) return;
    walkExpr(expr, (e) => {
      if (e.kind === "ref" && e.refKind === "current-user") {
        diags.push({
          severity: "error",
          code: "loom.currentuser-not-in-request-scope",
          message:
            `currentUser is only available in per-request handlers (operations, workflows, view bind expressions, repository find / view where filters). ` +
            `Found in ${location}; remove the reference or move the logic into a per-request body.`,
          source: `${ctx.name}/${location}`,
        });
      }
    });
  };
  for (const agg of ctx.aggregates) {
    for (const inv of agg.invariants) flag(`${agg.name}.invariant`, inv.expr);
    for (const inv of agg.invariants) flag(`${agg.name}.invariant`, inv.guard);
    for (const d of agg.derived) flag(`${agg.name}.derived[${d.name}]`, d.expr);
    for (const fn of agg.functions) flag(`${agg.name}.function[${fn.name}]`, fn.body);
    for (const part of agg.parts) {
      for (const inv of part.invariants) flag(`${part.name}.invariant`, inv.expr);
      for (const inv of part.invariants) flag(`${part.name}.invariant`, inv.guard);
      for (const d of part.derived) flag(`${part.name}.derived[${d.name}]`, d.expr);
      for (const fn of part.functions) flag(`${part.name}.function[${fn.name}]`, fn.body);
    }
  }
  for (const vo of ctx.valueObjects) {
    for (const inv of vo.invariants) flag(`${vo.name}.invariant`, inv.expr);
    for (const inv of vo.invariants) flag(`${vo.name}.invariant`, inv.guard);
    for (const d of vo.derived) flag(`${vo.name}.derived[${d.name}]`, d.expr);
    for (const fn of vo.functions) flag(`${vo.name}.function[${fn.name}]`, fn.body);
  }
  // Repository find filters and view filters DO get to use currentUser
  // (row-level visibility); the renderer threads the user through as a
  // closure-captured parameter.  Workflow / operation / test /
  // view-bind bodies were never in this rejection set.
}

// ---------------------------------------------------------------------------
// Permissions validation.
//
// Two passes:
//
//   1. Per-module: each `permissions { }` block declares typed
//      identifiers; names must be unique within the module.
//
//   2. Per-context: every expression in operation / workflow / view /
//      derived / invariant / find / function / test bodies is walked
//      for the `__unknown_permission__:<name>` sentinel produced by
//      lowering when `permissions.X` references an undeclared name
//      (or is referenced from a context whose module has no
//      permissions catalogue).  The sentinel keeps lowering's output
//      well-typed; this validator translates it into a friendly
//      diagnostic.
// ---------------------------------------------------------------------------

const UNKNOWN_PERMISSION_SENTINEL = "__unknown_permission__:";

export function validatePermissionRefs(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  const flag = (location: string, expr: ExprIR | undefined): void => {
    if (!expr) return;
    walkExpr(expr, (e) => {
      if (
        e.kind === "literal" &&
        e.lit === "string" &&
        e.value.startsWith(UNKNOWN_PERMISSION_SENTINEL)
      ) {
        const name = e.value.slice(UNKNOWN_PERMISSION_SENTINEL.length);
        diags.push({
          severity: "error",
          code: "loom.unknown-permission",
          message:
            `permissions.${name}: no permission named '${name}' is declared in this subdomain's 'permissions { ... }' block. ` +
            `Either add the declaration or fix the reference.`,
          source: `${ctx.name}/${location}`,
        });
      }
    });
  };
  for (const agg of ctx.aggregates) {
    for (const inv of agg.invariants) {
      flag(`${agg.name}.invariant`, inv.expr);
      flag(`${agg.name}.invariant`, inv.guard);
    }
    for (const d of agg.derived) flag(`${agg.name}.derived[${d.name}]`, d.expr);
    for (const fn of agg.functions) flag(`${agg.name}.function[${fn.name}]`, fn.body);
    for (const op of agg.operations) {
      for (const s of op.statements) {
        flagStmt(`${agg.name}.operation[${op.name}]`, s, flag);
      }
    }
    for (const t of agg.tests) {
      for (const s of t.statements) {
        flagStmt(`${agg.name}.test[${t.name}]`, s, flag);
      }
    }
    for (const part of agg.parts) {
      for (const inv of part.invariants) {
        flag(`${part.name}.invariant`, inv.expr);
        flag(`${part.name}.invariant`, inv.guard);
      }
      for (const d of part.derived) flag(`${part.name}.derived[${d.name}]`, d.expr);
      for (const fn of part.functions) flag(`${part.name}.function[${fn.name}]`, fn.body);
    }
  }
  for (const vo of ctx.valueObjects) {
    for (const inv of vo.invariants) {
      flag(`${vo.name}.invariant`, inv.expr);
      flag(`${vo.name}.invariant`, inv.guard);
    }
    for (const d of vo.derived) flag(`${vo.name}.derived[${d.name}]`, d.expr);
    for (const fn of vo.functions) flag(`${vo.name}.function[${fn.name}]`, fn.body);
  }
  for (const repo of ctx.repositories) {
    for (const f of repo.finds) {
      flag(`repository[${repo.name}].find[${f.name}]`, f.filter);
    }
  }
  for (const view of ctx.views) {
    flag(`view[${view.name}].filter`, view.filter);
    for (const b of view.output?.binds ?? []) {
      flag(`view[${view.name}].bind[${b.name}]`, b.expr);
    }
  }
  for (const wf of ctx.workflows) {
    for (const s of wf.statements) {
      switch (s.kind) {
        case "precondition":
        case "requires":
          flag(`workflow[${wf.name}]`, s.expr);
          break;
        case "emit":
          for (const f of s.fields) flag(`workflow[${wf.name}]`, f.value);
          break;
        case "factory-let":
          for (const f of s.fields) flag(`workflow[${wf.name}]`, f.value);
          break;
        case "repo-let":
          for (const a of s.args) flag(`workflow[${wf.name}]`, a);
          break;
        case "expr-let":
          flag(`workflow[${wf.name}]`, s.expr);
          break;
        case "op-call":
          for (const a of s.args) flag(`workflow[${wf.name}]`, a);
          break;
      }
    }
  }
}

/** Flag every expression nested inside a regular operation / test
 *  statement.  Mirrors the StmtIR union; new statement kinds need a
 *  branch here (TS exhaustiveness check guards against drift). */
function flagStmt(
  prefix: string,
  s: import("../../types/loom-ir.js").TestStmtIR,
  flag: (location: string, expr: ExprIR | undefined) => void,
): void {
  switch (s.kind) {
    case "precondition":
    case "requires":
      flag(prefix, s.expr);
      break;
    case "let":
      flag(prefix, s.expr);
      break;
    case "assign":
    case "add":
    case "remove":
      flag(prefix, s.value);
      break;
    case "emit":
      for (const f of s.fields) flag(prefix, f.value);
      break;
    case "call":
      for (const a of s.args) flag(prefix, a);
      break;
    case "expression":
      flag(prefix, s.expr);
      break;
    case "expect":
    case "expect-throws":
      flag(prefix, s.expr);
      break;
  }
}
