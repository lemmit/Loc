import {
  platformFamily,
  platformOwnsBackend,
  platformSavingShapes,
} from "../../language/validators/data/platform-rules.js";
import { allPlatforms, platformFor } from "../../platform/registry.js";
import { lowerFirst, plural, snake } from "../../util/naming.js";
import { capabilitiesFor, configSchemaFor, supportsSurfaceKind } from "../../util/source-types.js";
import { createInputFields, omittableCreateInputs } from "../enrich/wire-projection.js";
import { verbsForKind } from "../resource-verbs.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ConfigEntryIR,
  ConfigValueIR,
  DataSourceIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedLoomModel,
  EnrichedSystemIR,
  ExprIR,
  FunctionIR,
  StmtIR,
  SubdomainIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
  TypeIR,
  WorkflowIR,
} from "../types/loom-ir.js";
import { allContexts, exprUsesCurrentUser, findUsesCurrentUser } from "../types/loom-ir.js";
import {
  dataSourceKindForAggregate,
  effectiveSavingShape,
  resolveDataSourceConfig,
} from "../util/resolve-datasource.js";

// ---------------------------------------------------------------------------
// Loom IR validator — semantic checks that need the full IR (not just
// the AST).  Runs after `enrichLoomModel`; abort generation on
// non-empty `errors`.
//
// What this catches today: `test e2e` bodies referencing
// `api.<unknown>.<verb>` or `ui.<unknown>.<verb>`, or invoking an
// unknown verb on a known aggregate.  Previously these surfaced as
// thrown Errors from the e2e renderers — useful messages, but
// produced lazily during generation.  Doing it here means:
//
//   - Errors are collected up-front (one pass over the model), not
//     surfaced one-by-one as the renderer hits them.
//   - The CLI can decide whether to print all of them and abort,
//     vs. continuing past warnings.
//   - Renderers can assume the input is valid and stop carrying
//     defensive try/catch + descriptive-error logic.
// ---------------------------------------------------------------------------

export interface LoomDiagnostic {
  severity: "error" | "warning";
  message: string;
  /** Where the diagnostic came from — `<system>/<test-name>`. */
  source: string;
  /** Optional stable diagnostic code (e.g. `loom.criterion-not-selectable`)
   *  mirroring the `loom.*` codes the Langium-side validators attach.
   *  Lets tests and tooling match a diagnostic by identity rather than
   *  by message substring. Undefined on the older message-only diags. */
  code?: string;
}

export function validateLoomModel(loom: EnrichedLoomModel): LoomDiagnostic[] {
  const diags: LoomDiagnostic[] = [];
  // Workspace-scope uniqueness checks — only meaningful once a
  // project may span multiple `.ddd` files (Stage A multi-file).
  // Harmless for single-file projects: every collection is small
  // and the checks short-circuit when there are no duplicates.
  validateWorkspaceUniqueness(loom, diags);
  for (const sys of loom.systems) {
    validateSystem(sys, diags);
    validateDataSourceCoverage(sys, diags);
    validateSavingShapeSupport(sys, diags);
    validateContextFilterSupport(sys, diags);
    validateDapperSupport(sys, diags);
    validateMikroOrmSupport(sys, diags);
    validateNeedCapabilities(sys, diags);
    validateResourceConfig(sys, diags);
    validateDataSourceUnwiredKnobs(sys, diags);
    validateReactIdReferences(sys, diags);
    validateAuth(sys, diags);
    validatePermissions(sys, diags);
    // Scaffold expansion now runs at the AST level
    // (`src/language/ddd-scaffold-ast-expander.ts`).  Duplicate-page
    // detection happens through Langium's standard scope-walking
    // (every synthesised page is a real AST node, so two scaffolds
    // producing the same name surface as duplicate-symbol errors
    // from the linker).  The IR-level shim is gone.
    // Theme validation lives in the Langium-side validator
    // (`ddd-validator.ts:checkTheme`) where the raw AST is in
    // scope — unknown property names, duplicates, and the radius
    // enum are easier to catch there since lowering loses that
    // information by design.
  }
  // Which backend (needsDb) platforms host each context — drives the TPH
  // storage gate (sharedTable is implemented for Hono only, v1).
  const backendPlatformsByContext = backendPlatformsHostingEachContext(loom);
  // Per-context checks apply uniformly whether the context is
  // bundled in a system's modules or sits at the top level.
  for (const c of allContexts(loom)) {
    validateQueryableWheres(c, diags);
    validateRetrievals(c, diags);
    validateFindNameCollisions(c, diags);
    validateAggregateTestBodies(c, diags);
    validateExternOperations(c, diags);
    validateEventSourcedDiscipline(c, diags);
    validateWorkflows(c, diags);
    validateViews(c, diags);
    validateCurrentUserScope(c, diags);
    validatePermissionRefs(c, diags);
    validateGenericInstancesUnimplemented(
      c,
      diags,
      backendPlatformsByContext.get(c.name) ?? new Set(),
    );
    validateInheritanceStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
    validateEventSourcedStorage(c, diags, backendPlatformsByContext.get(c.name) ?? new Set());
  }
  validateExprIntegrity(loom, diags);
  return diags;
}

// ---------------------------------------------------------------------------
// Workspace uniqueness — multi-file (Stage A) makes it easy to declare
// two `valueobject Money` in different files, two `context Sales`, or
// shadow a context-local VO with a root-level one of the same name.
// Each of those would silently merge / collide in IR; surface them as
// errors here so the user sees a clear message instead of a confused
// downstream failure (duplicate import in the emitted TS, duplicate
// class in .NET, etc.).
// ---------------------------------------------------------------------------

function validateWorkspaceUniqueness(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
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

function validateFindNameCollisions(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
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

function validateGenericInstancesUnimplemented(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // Backends that can emit generic carriers (`paged` / `envelope`) today.
  // Grows one slice at a time; when a context is served only by these (or by
  // no backend at all — the legacy single-context path), the carrier is
  // emittable and the gate stays quiet.  React is a frontend, not a backend,
  // so it never appears here — its hooks consume whatever the backend serves.
  // `"node"` is the hono/TS backend's platform identity (realization axes).
  const SUPPORTED_PAGED_BACKENDS = new Set(["node"]);
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
// Aggregate-level `test "..." { ... }` body checks.
//
// Test blocks at the aggregate level have no `this` aggregate
// instance bound — they're meant for value-object invariant tests
// and pure-function exercises.  Three statement kinds are
// accepted: `let`, `expect`, `expect-throws`, plus bare
// expressions.  Anything that mutates aggregate state
// (`assign` / `add` / `remove` / `emit`) or that depends on the
// aggregate's runtime invariants (`precondition`) is structurally
// nonsensical here, and earlier versions of the generator
// silently rendered them as `// TODO: ...` comments — leaking the
// fallback into user-facing generated code.  Now caught at parse
// time with a structured diagnostic.
//
// `call` is allowed when the callee is a pure `function` (the
// usual helper-call case); rejected when it's a `private-operation`
// or unresolved `free` call (those need an aggregate instance).
// ---------------------------------------------------------------------------

function validateAggregateTestBodies(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const agg of ctx.aggregates) {
    for (const test of agg.tests) {
      for (const stmt of test.statements) {
        const reason = invalidTestStmt(stmt);
        if (!reason) continue;
        diags.push({
          severity: "error",
          code: "loom.aggregate-test-context",
          message:
            `aggregate '${agg.name}' test '${test.name}': ${reason} ` +
            `Aggregate-level tests are bound to a value-object / pure-function context — they don't have a 'this' aggregate to mutate.  ` +
            `Move the operation invocation inside an aggregate operation or rewrite the test to assert via 'expect' / 'expect-throws'.`,
          source: `${ctx.name}/${agg.name}.test:${test.name}`,
        });
      }
    }
  }
}

function invalidTestStmt(s: TestStmtIR): string | null {
  switch (s.kind) {
    case "assign":
      return `'${s.target.segments.join(".")} := ...' mutates state.`;
    case "add":
      return `'${s.target.segments.join(".")} += ...' mutates a contained collection.`;
    case "remove":
      return `'${s.target.segments.join(".")} -= ...' mutates a contained collection.`;
    case "emit":
      return `'emit ${s.eventName}' fires a domain event from an aggregate's mutator.`;
    case "precondition":
      return `'precondition' guards an operation; aggregate-level tests don't run in an op body.`;
    case "requires":
      return `'requires' is an authorization gate for per-request handlers; aggregate-level tests don't sit in a per-request scope.`;
    case "call":
      if (s.target === "private-operation") {
        return `call to private operation '${s.name}'.`;
      }
      return null; // pure function call is fine
    default:
      return null;
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

function validateExternOperations(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
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

function validateEventSourcedDiscipline(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
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
// `X id` validation for React deployables.
//
// The React form generator renders an `X id` form field as a `<Select>`
// populated by `useAll<X>()` with the target aggregate's `display`-marked
// field as the option label.  Two preconditions must hold for the form
// to be usable:
//
//   1. The target aggregate has a `display` field (otherwise no option
//      label can be derived; the generator falls back to a `<TextInput>`
//      with a placeholder explaining the gap, but the user only sees
//      that at render time).
//   2. The target aggregate is mounted by this deployable's targeted
//      backend (otherwise `useAll<X>()` is not importable and the API
//      can't fetch the list).
//
// We check both up-front per react deployable.  Backends-only
// deployables don't trigger these checks — `X id` on the wire is
// just a string/uuid and doesn't depend on a display label.
// ---------------------------------------------------------------------------

function validateReactIdReferences(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // Build an aggregate registry across the whole system so we can
  // look up display fields regardless of which module declares the
  // target aggregate.
  const allAggregates = new Map<string, AggregateIR>();
  for (const m of sys.subdomains) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) allAggregates.set(a.name, a);
    }
  }

  for (const d of sys.deployables) {
    // UI-mounting deployables emit per-aggregate forms whose `X id`
    // inputs need the target aggregate to be reachable from the
    // deployable's mounted set.  Backend-only deployables (hono)
    // skip — no UI.  `dotnet` is dual-mode now (`mountsUi: true` to
    // admit the fullstack `ui:` branch); when no `ui:` is declared
    // it stays backend-only and skips too — without this guard a
    // backend-only dotnet deployable would trigger spurious
    // Id-reachability errors against the (then irrelevant) UI.
    if (!platformFor(d.platform).mountsUi) continue;
    // Dual-mode platforms (dotnet) with no `ui:` are backend-only —
    // skip the UI-reachability walk.  `mountsUi && !isFrontend` is the
    // dual-mode shape today (frontend-only platforms always declare ui).
    if (!d.uiName && !platformFor(d.platform).isFrontend) continue;
    // Aggregates mounted by this deployable's `contextNames` set —
    // UI generators only emit per-aggregate hooks/queries for
    // these; anything outside is unreachable.
    const mounted = new Set<string>();
    const wantedContexts = new Set(d.contextNames);
    for (const sd of sys.subdomains) {
      for (const c of sd.contexts) {
        if (wantedContexts.has(c.name)) {
          for (const a of c.aggregates) mounted.add(a.name);
        }
      }
    }

    // Walk every operation param + every aggregate field that lowers to
    // an `X id` and check both invariants against the system-wide
    // registry + this deployable's mounted set.
    for (const aggName of mounted) {
      const agg = allAggregates.get(aggName);
      if (!agg) continue;
      // Aggregate root fields.
      for (const f of agg.fields) {
        checkIdReference(f.type, `${aggName}.${f.name}`, d.name, allAggregates, mounted, diags);
      }
      // Operation parameters.
      for (const op of agg.operations) {
        for (const p of op.params) {
          checkIdReference(
            p.type,
            `${aggName}.${op.name}(${p.name})`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
      // Part fields too — entity-parts on the wire surface as nested
      // shapes, but their `X id` properties show up as foreign
      // references in the part's row.  Forms for parts go through
      // the same Select picker pattern.
      for (const part of agg.parts) {
        for (const f of part.fields) {
          checkIdReference(
            f.type,
            `${aggName}.${part.name}.${f.name}`,
            d.name,
            allAggregates,
            mounted,
            diags,
          );
        }
      }
    }
  }
}

function checkIdReference(
  t: TypeIR,
  source: string,
  deployableName: string,
  allAggregates: Map<string, AggregateIR>,
  mounted: Set<string>,
  diags: LoomDiagnostic[],
): void {
  const inner = unwrap(t);
  if (inner.kind !== "id") {
    if (inner.kind === "array") {
      checkIdReference(inner.element, source, deployableName, allAggregates, mounted, diags);
    }
    return;
  }
  const target = inner.targetName;
  // 1. Target aggregate must exist somewhere in the system.
  const agg = allAggregates.get(target);
  if (!agg) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unknown-aggregate",
      message: `UI-mounting deployable '${deployableName}': '${source}' references ${target} id, but no aggregate '${target}' is declared in the system.`,
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 2. Target aggregate must be mounted by this deployable's modules
  //    so `useAll<Target>()` is importable + the backend can serve
  //    the list.
  if (!mounted.has(target)) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-unmounted",
      message:
        `UI-mounting deployable '${deployableName}': '${source}' references ${target} id, but '${target}' is not mounted on this deployable's modules.  ` +
        `Mount the module containing '${target}' on the deployable's targeted backend, or remove the reference.`,
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 3. Target aggregate must declare a `derived display: string` (so the
  //    Select picker has a sensible option label).
  if (!agg.displayDerived) {
    diags.push({
      severity: "error",
      code: "loom.ui-id-ref-no-display",
      message:
        `UI-mounting deployable '${deployableName}': '${source}' references ${target} id, but '${target}' has no 'derived display' clause.  ` +
        `Add 'derived display: string = <field>' to '${target}' so the form's <Select> picker can label options.`,
      source: `${deployableName}/${source}`,
    });
  }
}

function unwrap(t: TypeIR): TypeIR {
  return t.kind === "optional" ? t.inner : t;
}

// ---------------------------------------------------------------------------
// QueryExpr enforcement.  Every repository `find` declared with a
// `where ...` clause must restrict that clause to the queryable
// expression sublanguage — comparisons, `&&`, `||`, `!`, parenthesised
// groups, and references to the aggregate root's columns / find
// parameters.  Anything richer (collection ops, lambdas, member
// access into parts, value-object constructors, calls) cannot lower
// to SQL, so the Drizzle backend would have had to skip it.  We
// reject these at the IR layer instead, with a message pointing the
// user at the supported subset.
// ---------------------------------------------------------------------------

function validateQueryableWheres(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const repo of ctx.repositories) {
    const agg = ctx.aggregates.find((a) => a.name === repo.aggregateName);
    for (const find of repo.finds) {
      if (!find.filter) continue;
      const offending = firstNonQueryableNode(find.filter);
      if (offending) {
        diags.push({
          severity: "error",
          code: "loom.find-where-not-queryable",
          message:
            `repository '${repo.name}' find '${find.name}': ` +
            `where-clause is not queryable (${offending}). ` +
            `Allowed: comparisons, &&/||/!, parens, ` +
            `'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
        continue;
      }
      // Beyond grammar-level queryability: each `this.<X>` reference
      // must resolve to a real aggregate field.  Without this check
      // the generator emits SQL against a non-existent column and
      // the runtime fails (or silently returns nothing).
      if (agg) {
        const unknown = firstUnknownColumnRef(find.filter, agg, ctx);
        if (unknown) {
          diags.push({
            severity: "error",
            code: "loom.find-where-unknown-field",
            message:
              `repository '${repo.name}' find '${find.name}': ` +
              `where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
            source: `${ctx.name}/${repo.name}.${find.name}`,
          });
        }
      }
      // And: every binary comparison must compare ONE column against
      // ONE value (parameter, literal, enum-value).  Drizzle's
      // `eq(col, val)` doesn't model column-vs-column comparisons —
      // they'd need raw SQL.  Our generator errors out at lowering
      // when both sides are columns; rejecting at validation surfaces
      // the issue earlier and with a clearer message.
      const bothCols = firstColumnVsColumn(find.filter);
      if (bothCols) {
        diags.push({
          severity: "error",
          code: "loom.find-where-column-column",
          message:
            `repository '${repo.name}' find '${find.name}': ` +
            `comparison between two columns (${bothCols}) is not queryable. ` +
            `Drizzle's eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
    }
  }
  // `filter <expr>` capability predicates (lowered to
  // `agg.contextFilters`) are a SELECTION position too: every backend
  // installs them at the query layer (.NET `HasQueryFilter`, Drizzle
  // read-site conjunction, Ecto base-query helper), so they must lower
  // to the same queryable subset as a `find`/`view` `where`.  Until now
  // they bypassed this check — an unselectable capability filter would
  // silently emit nothing (Drizzle/Ecto) or fail at C# render (.NET).
  // `currentUser.<scalar>` is admitted here exactly as in find filters:
  // the backend threads the request principal in (row-level
  // soft-delete / tenancy filters are the motivating case).
  for (const agg of ctx.aggregates) {
    const filters = (agg as EnrichedAggregateIR).contextFilters ?? [];
    for (const predicate of filters) {
      const offending = firstNonQueryableNode(predicate);
      if (offending) {
        diags.push({
          severity: "error",
          message:
            `aggregate '${agg.name}': a 'filter' capability predicate is not selectable (${offending}). ` +
            `Capability filters install at the query layer, so they must lower to the queryable subset: ` +
            `comparisons, &&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, 'currentUser.<field>', literals.`,
          source: `${ctx.name}/${agg.name}`,
          code: "loom.criterion-not-selectable",
        });
        continue;
      }
      const unknown = firstUnknownColumnRef(predicate, agg, ctx);
      if (unknown) {
        diags.push({
          severity: "error",
          message: `aggregate '${agg.name}': a 'filter' capability predicate references unknown field ${unknown} on '${agg.name}'.`,
          source: `${ctx.name}/${agg.name}`,
          code: "loom.criterion-not-selectable",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Retrieval validation (retrieval.md).  A `retrieval`'s `where` is a
// selection position — same queryable-subset contract as a `find …
// where` (reuses the oracle above).  Its `sort` and `loads` slots carry
// structural paths that must resolve against the candidate aggregate.
// `page` cannot appear here (the grammar forbids a page slot), so there
// is nothing to check for it.
// ---------------------------------------------------------------------------

function validateRetrievals(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const r of ctx.retrievals) {
    const targetName = r.targetType.kind === "entity" ? r.targetType.name : undefined;
    const agg = targetName ? ctx.aggregates.find((a) => a.name === targetName) : undefined;
    const src = `${ctx.name}/retrieval ${r.name}`;

    // `where` — same queryable-subset enforcement as find filters.
    const offending = firstNonQueryableNode(r.where);
    if (offending) {
      diags.push({
        severity: "error",
        code: "loom.retrieval-where-not-queryable",
        message:
          `retrieval '${r.name}': where-clause is not queryable (${offending}). ` +
          `Allowed: comparisons, &&/||/!, parens, 'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
        source: src,
      });
    } else if (agg) {
      const unknown = firstUnknownColumnRef(r.where, agg, ctx);
      if (unknown) {
        diags.push({
          severity: "error",
          code: "loom.retrieval-where-unknown-field",
          message: `retrieval '${r.name}': where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
          source: src,
        });
      }
      const bothCols = firstColumnVsColumn(r.where);
      if (bothCols) {
        diags.push({
          severity: "error",
          code: "loom.retrieval-where-column-column",
          message:
            `retrieval '${r.name}': comparison between two columns (${bothCols}) is not queryable. ` +
            `eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
          source: src,
        });
      }
    }

    if (!agg) continue;

    // `sort` — each term's path must start at a real aggregate field.
    for (const term of r.sort) {
      const head = term.path[0];
      if (head && !aggregateHasMember(agg, head.name)) {
        diags.push({
          severity: "error",
          code: "loom.retrieval-sort-unknown-field",
          message: `retrieval '${r.name}': sort references unknown field '${head.name}' on aggregate '${agg.name}'.`,
          source: src,
        });
      }
    }

    // `loads` — explicit eager-load specs are not supported yet.  Every
    // retrieval loads the *whole* aggregate (all owned containments).  The
    // planned replacement is per-operation autoload: derive the load set
    // from the expressions an operation's body uses, so it's sufficient by
    // construction (no `loads`-sufficiency validator needed).  Until then a
    // narrowing `loads:` would silently under-fetch on Phoenix (a
    // `%NotLoaded{}` crash in a downstream for-loop op) while being inert
    // on Hono/.NET (owned parts always materialise) — so it is rejected
    // outright rather than honoured inconsistently across backends.  See
    // load-specifications.md.
    if (r.loadPlan.kind === "explicit") {
      diags.push({
        severity: "error",
        code: "loom.retrieval-loads-unsupported",
        message:
          `retrieval '${r.name}': explicit 'loads:' is not supported yet — ` +
          `retrievals load the whole aggregate. (Per-operation autoload is planned.)`,
        source: src,
      });
    }
  }
}

/** True when `name` is a stored field, containment, or derived property
 *  of the aggregate — the set of members a `sort` / `loads` path may
 *  root at. */
function aggregateHasMember(agg: AggregateIR, name: string): boolean {
  return (
    agg.fields.some((f) => f.name === name) ||
    agg.contains.some((c) => c.name === name) ||
    agg.derived.some((d) => d.name === name)
  );
}

/** Walk an already-queryable expression and return the first
 * `this.<X>` member access whose `<X>` doesn't correspond to a real
 * aggregate field.  Returns null if every column reference resolves
 * cleanly. */
function firstUnknownColumnRef(e: ExprIR, agg: AggregateIR, ctx: BoundedContextIR): string | null {
  switch (e.kind) {
    case "literal":
    case "this":
    case "id":
    case "ref":
      return null;
    case "paren":
      return firstUnknownColumnRef(e.inner, agg, ctx);
    case "unary":
      return firstUnknownColumnRef(e.operand, agg, ctx);
    case "binary":
      return firstUnknownColumnRef(e.left, agg, ctx) ?? firstUnknownColumnRef(e.right, agg, ctx);
    case "member": {
      // `this.X` — direct column.  Verify X is on the aggregate.
      if (e.receiver.kind === "this") {
        const fld = agg.fields.find((f) => f.name === e.member);
        if (fld) return null;
        const derived = agg.derived.find((d) => d.name === e.member);
        if (derived) {
          // Derived isn't a stored column — emitting SQL against it
          // would also fail.  Reject with a more specific message.
          return `'this.${e.member}' (derived properties are computed, not stored as columns)`;
        }
        const containment = agg.contains.find((c) => c.name === e.member);
        if (containment) {
          return `'this.${e.member}' (containments aren't queryable directly — see docs/language.md)`;
        }
        return `'this.${e.member}'`;
      }
      // `this.vo.sub` — value-object flattened column.  Verify vo
      // is a VO-typed field AND sub is a field on the VO.
      if (
        e.receiver.kind === "member" &&
        e.receiver.receiver.kind === "this" &&
        e.receiver.memberType.kind === "valueobject"
      ) {
        const voField = agg.fields.find(
          (f) => f.name === (e.receiver as { member: string }).member,
        );
        if (!voField) {
          return `'this.${(e.receiver as { member: string }).member}'`;
        }
        const voName =
          e.receiver.memberType.kind === "valueobject" ? e.receiver.memberType.name : "";
        const vo = ctx.valueObjects.find((v) => v.name === voName);
        if (vo?.fields.some((f) => f.name === e.member)) return null;
        return `'this.${(e.receiver as { member: string }).member}.${e.member}'`;
      }
      return null;
    }
    case "method-call":
      // Membership query (`this.<refColl>.contains(x)`) — verify the
      // collection field itself exists; the argument is a parameter,
      // not a column.
      return firstUnknownColumnRef(e.receiver, agg, ctx);
    default:
      return null;
  }
}

/** Returns a description of the first binary comparison whose two
 * sides are BOTH column references, or null if none exists. */
function firstColumnVsColumn(e: ExprIR): string | null {
  if (e.kind === "binary") {
    if (
      ["==", "!=", "<", "<=", ">", ">="].includes(e.op) &&
      isColumnRef(e.left) &&
      isColumnRef(e.right)
    ) {
      return `${describeColumnRef(e.left)} vs ${describeColumnRef(e.right)}`;
    }
    return firstColumnVsColumn(e.left) ?? firstColumnVsColumn(e.right);
  }
  if (e.kind === "paren") return firstColumnVsColumn(e.inner);
  if (e.kind === "unary") return firstColumnVsColumn(e.operand);
  return null;
}

function isColumnRef(e: ExprIR): boolean {
  if (e.kind === "paren") return isColumnRef(e.inner);
  if (e.kind === "ref" && e.refKind === "this-prop") return true;
  if (e.kind === "member" && e.receiver.kind === "this") return true;
  if (e.kind === "member" && e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
    return true;
  return false;
}

function describeColumnRef(e: ExprIR): string {
  if (e.kind === "paren") return describeColumnRef(e.inner);
  if (e.kind === "ref" && e.refKind === "this-prop") return `'this.${e.name}'`;
  if (e.kind === "member" && e.receiver.kind === "this") return `'this.${e.member}'`;
  if (e.kind === "member" && e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
    return `'this.${e.receiver.member}.${e.member}'`;
  return "<column>";
}

/** Returns null if the expression is fully queryable; otherwise a
 * short label describing the first non-queryable node encountered.
 * The label is human-readable (`"collection op .where"`,
 * `"lambda"`, `"call to function 'X'"`) so the diagnostic message
 * can be specific. */
// Exported for the queryable-subset parity test
// (`test/ir/queryable-subset-parity.test.ts`), which pins the invariant
// that everything this gate admits, `lowerToDrizzle` can lower.
export function firstNonQueryableNode(e: ExprIR): string | null {
  switch (e.kind) {
    case "literal":
    case "this":
    case "id":
      return null;
    case "ref":
      // Refs the lowering produces that translate cleanly to SQL —
      // `param`/`let`/`lambda` are bare identifiers, `this-prop`
      // becomes `tableName.col`, `enum-value` becomes a literal
      // string.  `current-user` is a closure-captured value; the
      // renderer threads a `currentUser` parameter through the repo
      // method and the ref / its member accesses become plain JS / C#
      // value references.
      //
      // NOTE: `this-vo-prop` is deliberately NOT admitted here.  A
      // value-object sub-property is queryable only in its
      // `this.<vo>.<sub>` MEMBER form (handled by the `member` case
      // below, which Drizzle flattens to a `<vo>_<sub>` column).  A
      // *bare* `this-vo-prop` ref carries only the sub-property name,
      // not its parent VO field, so it cannot form the flattened
      // column — `lowerToDrizzle` returns null for it.  (It is only
      // produced inside a value-object's own body, never in an
      // aggregate find/view/retrieval `where`, so this rejects an
      // unreachable shape rather than a real one — but admitting it
      // would let an internal-error throw replace a clean diagnostic
      // if it ever became reachable.)
      if (
        e.refKind === "param" ||
        e.refKind === "let" ||
        e.refKind === "lambda" ||
        e.refKind === "this-prop" ||
        e.refKind === "enum-value" ||
        e.refKind === "current-user"
      )
        return null;
      return `ref to '${e.name}' (${e.refKind})`;
    case "paren":
      return firstNonQueryableNode(e.inner);
    case "unary":
      if (e.op === "!") return firstNonQueryableNode(e.operand);
      return `unary '${e.op}'`;
    case "binary":
      switch (e.op) {
        case "==":
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "&&":
        case "||":
          return firstNonQueryableNode(e.left) ?? firstNonQueryableNode(e.right);
        default:
          return `arithmetic '${e.op}'`;
      }
    case "member":
      // Reject any member access whose receiver evaluates to a
      // collection — `.count`, `.first`, `.length`, etc. are
      // projections that need a SQL subquery to express, which
      // the queryable sublanguage doesn't support.
      if (e.receiverType.kind === "array") {
        return `collection projection '.${e.member}' on a list`;
      }
      // Allowed member-access shapes:
      //   - `this.col`               — direct column
      //   - `this.vo.sub`            — value-object's flattened column
      //   - `currentUser.<field>`    — row-level filter; the
      //                                renderer threads a `currentUser`
      //                                parameter so the access becomes
      //                                a plain JS / C# value reference.
      if (e.receiver.kind === "this") return null;
      if (
        e.receiver.kind === "member" &&
        e.receiver.receiver.kind === "this" &&
        e.receiver.memberType.kind === "valueobject"
      )
        return null;
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user") return null;
      return "member access not rooted at 'this' or beyond a flattened value object";
    case "method-call":
      // Membership over a reference collection — `this.<refColl>.contains(x)`
      // — is the one collection op we admit: it lowers to an EXISTS-style
      // subquery against the field's join table.  Everything else
      // (`.count`, `.any`, `.where`, …) still needs richer SQL we don't
      // emit, so stays rejected.
      if (
        e.member === "contains" &&
        e.receiverType.kind === "array" &&
        e.receiverType.element.kind === "id" &&
        isColumnRef(e.receiver) &&
        e.args.length === 1
      ) {
        return firstNonQueryableNode(e.args[0]!);
      }
      return `collection op '.${e.member}'`;
    case "lambda":
      return "lambda";
    case "call":
      return `call to '${e.name}' (${e.callKind})`;
    case "new":
      return `'new ${e.partName}' construction`;
    case "object":
      return "object literal";
    case "ternary":
      return "ternary";
    case "convert":
      // Primitive conversions don't lower to SQL — they're per-
      // host coercions (`String(x)`, `Decimal.to_string`, etc.).
      // Reject in queryable contexts; the user should restructure
      // the query to avoid the conversion (e.g. cast on the DB
      // side via a `derived` projection if needed).
      return `conversion to '${e.target}'`;
    case "match":
      // `match { ... }` is a value-producing expression but contains
      // arbitrary arm conditions / values; it doesn't translate to a
      // single SQL fragment.  Same posture as ternary in v22 — reject
      // from the queryable sublanguage; full match semantics live in
      // the application layer / generator.
      return "match expression";
    case "list":
      // Bracketed list literals are walker-config sugar (e.g. responsive
      // Grid cols) — never queryable.
      return "list literal";
  }
}

function validateSystem(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const modulesByName = new Map<string, SubdomainIR>();
  for (const m of sys.subdomains) modulesByName.set(m.name, m);
  for (const t of sys.e2eTests) {
    validateE2ETest(t, sys, modulesByName, diags);
  }
}

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
function validateDataSourceCoverage(sys: SystemIR, diags: LoomDiagnostic[]): void {
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
          message:
            `Deployable '${dep.name}' hosts aggregate '${ctxName}.${agg.name}' ` +
            `(persistedAs: ${agg.persistedAs ?? "state"}, ` +
            `needs dataSource kind: ${kind}) but lists no matching dataSource. ` +
            `Declare ` +
            `\`dataSource ${lowerFirst(ctxName)}${kind === "state" ? "State" : "EventLog"} ` +
            `{ for: ${ctxName}, kind: ${kind}, use: <storage> }\` ` +
            `and add it to '${dep.name}'\`s 'dataSources:' list.`,
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
        message:
          `Deployable '${dep.name}' lists resource '${ds.name}' (kind: ${ds.kind}) for ` +
          `context '${ds.contextName}', but ${reason}.  This binding routes no data — ` +
          `remove it, or add an aggregate whose persistedAs needs kind: ${ds.kind}.`,
        source: `${sys.name}/${dep.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Saving-shape capability (D-DOCUMENT-AXIS).  An aggregate's effective
// `shape(…)` must be one the hosting backend can actually emit.  Today
// the matrix is partial — .NET / Hono emit all three (relational /
// embedded / document); Phoenix emits only relational — so a
// `shape(document)` aggregate on a Phoenix deployable would otherwise
// emit *relationally*, silently mismatching the per-shape migration.
// This turns that footgun into a clear error (the capability tier).
//
// Per-projection: the effective shape is resolved binding-aware (a
// `resource { shape: … }` override wins over the aggregate header), the
// same way the migration + backend emitters resolve it, so the check
// matches what would actually be produced.  Frontend platforms own no
// persistence (platformSavingShapes → undefined) and are skipped.
// ---------------------------------------------------------------------------
function validateSavingShapeSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  for (const dep of sys.deployables) {
    if (!platformOwnsBackend(dep.platform)) continue;
    const supported = platformSavingShapes(dep.platform);
    if (!supported) continue;
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
          message:
            `Deployable '${dep.name}' (platform ${dep.platform}) hosts aggregate ` +
            `'${ctxName}.${agg.name}' with shape(${shape}), but that backend can only ` +
            `emit: ${supported.join(", ")}.  Use a supported shape, or host this ` +
            `aggregate on a deployable whose platform emits shape(${shape}).`,
          source: `${sys.name}/${dep.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Capability-filter support on the Hono and Phoenix backends (partial
// today).  A `filter <expr>` capability installs at the query layer on
// every read.  On .NET it rides EF Core's `HasQueryFilter` (global,
// DI-resolved) — no restriction.  Hono AND-s the predicate into each
// Drizzle read site; Phoenix emits an Ash `base_filter`.  Two cases are
// not yet wired on either and would otherwise emit silently-wrong query
// behaviour (a soft-delete / tenancy-isolation footgun), so reject them
// with a clear error instead:
//
//   1. Principal-referencing filters (`this.tenantId ==
//      currentUser.tenantId`).  Binding the request principal into the
//      always-on read path is deferred (Hono: thread through findById +
//      callers; Phoenix: an actor-bound base_filter) — see
//      docs/proposals/criterion-everywhere.md.
//   2. Non-relational shapes (`shape(document)` / `shape(embedded)`).
//      Fields live inside a jsonb column, so `this.isDeleted` is not a
//      top-level column the predicate can reference without JSON-path
//      lowering — deferred.  (Phoenix only emits relational anyway, so
//      the saving-shape validator usually blocks this upstream.)
//
// Non-principal capability filters on a relational aggregate
// (`filter !this.isDeleted`) ARE emitted on both backends.
// ---------------------------------------------------------------------------
function validateContextFilterSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);

  // Backends that consume contextFilters with the principal / shape
  // limitation.  .NET (HasQueryFilter) is deliberately absent — it
  // supports both deferred cases.  Canonical families (D-NODE-PLATFORM /
  // D-PHOENIX-SURFACE): `node` (was `hono`), `phoenix` (was `phoenixLiveView`).
  const LIMITED_FAMILIES = new Set(["node", "phoenix"]);

  for (const dep of sys.deployables) {
    const fam = platformFamily(dep.platform);
    if (!fam || !LIMITED_FAMILIES.has(fam)) continue;
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      for (const agg of ctx.aggregates) {
        const enriched = agg as EnrichedAggregateIR;
        const filters = enriched.contextFilters ?? [];
        if (filters.length === 0) continue;
        const usesPrincipal = filters.some((p) => exprUsesCurrentUser(p));
        const shape = effectiveSavingShape(enriched, resolveDataSourceConfig(enriched, ctx, sys));
        const nonRelational = shape !== "relational";
        if (!usesPrincipal && !nonRelational) continue;
        const reason = usesPrincipal
          ? `references currentUser (e.g. a tenancy filter); principal-referencing capability ` +
            `filters are not yet wired on the ${fam} backend`
          : `is persisted as shape(${shape}); capability filters are only wired for ` +
            `relational aggregates on the ${fam} backend today`;
        diags.push({
          severity: "error",
          message:
            `Deployable '${dep.name}' (platform ${dep.platform}) hosts aggregate ` +
            `'${ctxName}.${agg.name}' with a 'filter' capability predicate that ${reason}. ` +
            `Host this aggregate on a .NET deployable, or remove the unsupported capability filter. ` +
            `Non-principal filters on relational aggregates (e.g. 'filter !this.isDeleted') are emitted.`,
          source: `${sys.name}/${dep.name}`,
          code: "loom.context-filter-unsupported",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: dapper` capability gate (D-REALIZATION-AXES Phase 5c).
//
// The .NET Dapper adapter is a MINIMAL-v1 alternate persistence: relational,
// state-based, flat aggregates whose fields are scalar / enum / value-object /
// single id-ref.  This rejects — with a clear, actionable error — any model
// feature dapper v1 doesn't emit, so a selection either works end-to-end or
// fails fast at validate time (rather than producing a non-compiling project).
// efcore (the default) supports the full surface, so this only fires for an
// explicit `persistence: dapper`.
// ---------------------------------------------------------------------------
function validateDapperSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const MANAGED_ACCESS = new Set(["managed", "token", "internal", "secret"]);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "dapper") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message:
          `Deployable '${dep.name}' selects 'persistence: dapper', but ${subject} ${reason}. ` +
          `The Dapper adapter is minimal in v1 (relational, state-based, flat aggregates with ` +
          `scalar / enum / value-object / id-ref fields). Use 'persistence: efcore' for this model, ` +
          `or remove the unsupported feature.`,
        source: `${sys.name}/${dep.name}`,
        code: "loom.dapper-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      // Named-query bundles emit `Run<Name>Async` on the repository interface,
      // which the v1 Dapper repository doesn't implement.
      if ((ctx.retrievals ?? []).length > 0)
        reject(`context '${ctxName}'`, "declares 'retrieval' query bundles (not yet on Dapper)");
      if ((ctx.seeds ?? []).length > 0)
        reject(`context '${ctxName}'`, "declares 'seed' data (the Dapper seed path is not wired)");
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        if (a.persistedAs === "eventLog") reject(where, "is event-sourced");
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        if (shape !== "relational") reject(where, `is persisted as shape(${shape})`);
        if (a.isAbstract || a.extendsAggregate)
          reject(where, "participates in aggregate inheritance");
        if ((a.associations ?? []).length > 0)
          reject(where, "has reference-collection associations (Id[] join tables)");
        if ((a.parts ?? []).length > 0 || (a.contains ?? []).length > 0)
          reject(where, "contains nested entity parts");
        if ((a.contextStamps ?? []).length > 0) reject(where, "uses audit stamping");
        if ((a.contextFilters ?? []).length > 0)
          reject(where, "uses a 'filter' capability predicate");
        for (const f of a.fields) {
          if (f.provenanced) reject(`field '${agg.name}.${f.name}'`, "is provenanced");
          else if (f.access && MANAGED_ACCESS.has(f.access))
            reject(`field '${agg.name}.${f.name}'`, `has server-managed access '${f.access}'`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// `persistence: mikroorm` capability gate (D-REALIZATION-AXES Phase 5d).
//
// The node/hono MikroORM adapter is the SECOND node persistence backend
// (alongside the default `drizzle`), minimal in v1: relational, state-based,
// flat aggregates with scalar / enum / value-object / id-ref fields.  Mirrors
// the dapper gate — reject any feature mikroorm v1 doesn't emit so a selection
// either works end-to-end or fails fast at validate time.  drizzle supports the
// full surface, so this only fires for an explicit `persistence: mikroorm`.
// ---------------------------------------------------------------------------
function validateMikroOrmSupport(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const m of sys.subdomains) for (const c of m.contexts) ctxByName.set(c.name, c);
  const MANAGED_ACCESS = new Set(["managed", "token", "internal", "secret"]);

  for (const dep of sys.deployables) {
    if (dep.persistence !== "mikroorm") continue;
    const reject = (subject: string, reason: string): void => {
      diags.push({
        severity: "error",
        message:
          `Deployable '${dep.name}' selects 'persistence: mikroorm', but ${subject} ${reason}. ` +
          `The MikroORM adapter is minimal in v1 (relational, state-based, flat aggregates with ` +
          `scalar / enum / value-object / id-ref fields). Use 'persistence: drizzle' for this model, ` +
          `or remove the unsupported feature.`,
        source: `${sys.name}/${dep.name}`,
        code: "loom.mikroorm-unsupported",
      });
    };
    for (const ctxName of dep.contextNames) {
      const ctx = ctxByName.get(ctxName);
      if (!ctx) continue;
      if ((ctx.retrievals ?? []).length > 0)
        reject(`context '${ctxName}'`, "declares 'retrieval' query bundles (not yet on MikroORM)");
      if ((ctx.seeds ?? []).length > 0)
        reject(
          `context '${ctxName}'`,
          "declares 'seed' data (the MikroORM seed path is not wired)",
        );
      for (const agg of ctx.aggregates) {
        const a = agg as EnrichedAggregateIR;
        const where = `aggregate '${ctxName}.${agg.name}'`;
        if (a.persistedAs === "eventLog") reject(where, "is event-sourced");
        const shape = effectiveSavingShape(a, resolveDataSourceConfig(a, ctx, sys));
        if (shape !== "relational") reject(where, `is persisted as shape(${shape})`);
        if (a.isAbstract || a.extendsAggregate)
          reject(where, "participates in aggregate inheritance");
        if ((a.associations ?? []).length > 0)
          reject(where, "has reference-collection associations (Id[] join tables)");
        if ((a.parts ?? []).length > 0 || (a.contains ?? []).length > 0)
          reject(where, "contains nested entity parts");
        if ((a.contextStamps ?? []).length > 0) reject(where, "uses audit stamping");
        if ((a.contextFilters ?? []).length > 0)
          reject(where, "uses a 'filter' capability predicate");
        for (const f of a.fields) {
          if (f.provenanced) reject(`field '${agg.name}.${f.name}'`, "is provenanced");
          else if (f.access && MANAGED_ACCESS.has(f.access))
            reject(`field '${agg.name}.${f.name}'`, `has server-managed access '${f.access}'`);
        }
      }
    }
  }
}

/** Returns a human-readable reason a dataSource of `kind` covers
 *  nothing in `ctx`, or undefined when the binding is exercised by
 *  at least one aggregate.  Encodes the dataSource-kind → aggregate-
 *  predicate matrix:
 *    - state    → needs at least one stateBased aggregate
 *    - eventLog → needs at least one eventSourced aggregate
 *    - snapshot → needs at least one eventSourced aggregate
 *      (snapshot policy applies to ES streams)
 *    - cache    → needs at least one aggregate of any strategy
 *    - replica  → needs at least one aggregate of any strategy
 */
// ---------------------------------------------------------------------------
// Need ⊆ sourceType capability check (RFC §5.3).  For each derived need
// bound to a resource, the resource's sourceType must offer every
// capability the need requires.  This is the IR-level invariant the
// implicit need layer enables; the AST validator already owns the
// coarser "kind supported by sourceType" check (with editor squiggles),
// so this only reports a *capability* gap on a kind the sourceType DOES
// support — avoiding a duplicate diagnostic for a plain kind/type
// mismatch.  In Phase 1 every supported kind offers all its
// capabilities, so this is silent for valid models; it becomes load-
// bearing once kinds carry capabilities a sourceType may partially
// support.
// ---------------------------------------------------------------------------

function validateNeedCapabilities(sys: EnrichedSystemIR, diags: LoomDiagnostic[]): void {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const need of sys.needs) {
    const resource = sys.dataSources.find(
      (d) => d.contextName === need.contextName && d.kind === need.kind,
    );
    if (!resource) continue; // coverage gaps are reported elsewhere
    const sourceType = storageType.get(resource.storageName);
    if (!sourceType) continue; // unresolved `use:` reported elsewhere
    // Defer to the AST validator for the kind/type mismatch itself.
    if (!supportsSurfaceKind(sourceType, need.kind)) continue;
    const offered = capabilitiesFor(sourceType, need.kind);
    const missing = need.capabilities.filter((c) => !offered.has(c));
    if (missing.length > 0) {
      diags.push({
        severity: "error",
        code: "loom.resource-missing-capability",
        message:
          `resource '${resource.name}' (sourceType '${sourceType}') does not offer ` +
          `${missing.map((c) => `'${c}'`).join(", ")} required by context ` +
          `'${need.contextName}' for kind '${need.kind}'.`,
        source: `${sys.name}/${resource.name}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Generic `config` map validation (RFC §8).  Keys are checked against
// the sourceType's registry config schema: unknown keys warn (forward-
// compatible), wrong-typed values error, and required keys missing from
// a physical `storage` error.  Resource-level config is supplemental, so
// the required-key check applies only to the storage declaration.
// ---------------------------------------------------------------------------

function validateResourceConfig(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const storageType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  for (const s of sys.storages) {
    checkConfigBlock(s.config, s.type, `storage '${s.name}'`, true, sys.name, diags);
  }
  for (const r of sys.dataSources) {
    const sourceType = storageType.get(r.storageName);
    if (!sourceType) continue;
    checkConfigBlock(r.config, sourceType, `resource '${r.name}'`, false, sys.name, diags);
  }
}

function checkConfigBlock(
  config: readonly ConfigEntryIR[] | undefined,
  sourceType: string,
  label: string,
  checkRequired: boolean,
  sysName: string,
  diags: LoomDiagnostic[],
): void {
  const schema = configSchemaFor(sourceType);
  const byName = new Map(schema.map((k) => [k.name, k] as const));
  const present = new Set<string>();
  for (const entry of config ?? []) {
    present.add(entry.key);
    const spec = byName.get(entry.key);
    if (!spec) {
      diags.push({
        severity: "warning",
        code: "loom.config-key-unknown",
        message: `${label}: config key '${entry.key}' is not recognised by sourceType '${sourceType}' — it will be ignored.`,
        source: `${sysName}/${label}`,
      });
      continue;
    }
    if (!configValueMatchesType(entry.value, spec)) {
      const expected =
        spec.type === "enum" && spec.values ? `one of ${spec.values.join(", ")}` : spec.type;
      diags.push({
        severity: "error",
        code: "loom.config-key-type",
        message: `${label}: config key '${entry.key}' expects ${expected}.`,
        source: `${sysName}/${label}`,
      });
    }
  }
  if (checkRequired) {
    for (const spec of schema) {
      if (spec.required && !present.has(spec.name)) {
        diags.push({
          severity: "error",
          code: "loom.config-key-required",
          message: `${label}: required config key '${spec.name}' (sourceType '${sourceType}') is missing.`,
          source: `${sysName}/${label}`,
        });
      }
    }
  }
}

function configValueMatchesType(
  value: ConfigValueIR,
  spec: { type: string; values?: readonly string[] },
): boolean {
  switch (spec.type) {
    case "number":
      return value.kind === "int";
    case "boolean":
      return value.kind === "bool";
    case "enum":
      return value.kind === "string" && (spec.values?.includes(value.value) ?? false);
    default: // string | secret
      return value.kind === "string";
  }
}

function coverageGapReason(kind: string, ctx: BoundedContextIR): string | undefined {
  const aggs = ctx.aggregates;
  if (aggs.length === 0) return "the context declares no aggregates";
  const hasState = aggs.some((a) => (a.persistedAs ?? "state") === "state");
  const hasES = aggs.some((a) => a.persistedAs === "eventLog");
  if (kind === "state" && !hasState) {
    return "every aggregate is persistedAs(eventLog) (none need kind: state persistence)";
  }
  if ((kind === "eventLog" || kind === "snapshot") && !hasES) {
    return "no aggregate is persistedAs(eventLog) (kind: " + kind + " has no event stream to back)";
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
//   - `schema`       — EF Core ToTable, Drizzle pgSchema, AshPostgres
//                      `postgres.schema`
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
// `isolationLevel` used to be on this list; it now flows through
// `resolveWorkflowIsolation` into the .NET BeginTransactionAsync and
// Phoenix `Ash.transaction` opts when a workflow in the context is
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
  // per-backend `supportedShapes` capability check, not warned as inert.
];

// Aggregate-inheritance storage gate (aggregate-inheritance.md, I2/I3).
//
// `ownTable` (TPC) emission is wired on every backend: the abstract base is
// dropped from the generation view (system/index.ts `collectContextsFor`) and
// each concrete emits as a standalone table carrying the merged base + own
// fields (the `wireShape` merge in enrichContext).
//
// `sharedTable` (TPH) is implemented for the Hono backend only (v1): the
// hierarchy lives in one shared table named for the base, with a `kind`
// discriminator and per-concrete columns made nullable; each concrete's repo
// filters/stamps `kind`. So a TPH hierarchy is allowed iff its context is
// hosted by a Hono backend deployable. Otherwise it's an error (not a
// warning) — TPH on .NET/Phoenix isn't built, and a context with no Hono host
// has no implemented emission target. `sharedTable` is the omitted-modifier
// default, so an inheritance hierarchy with no `inheritanceUsing(…)` is TPH
// too. Polymorphic `Party id` refs and `find all Party` remain deferred (the
// language validator rejects the former); document / TPT shapes are later.
const DEFAULT_INHERITANCE_LAYOUT = "sharedTable" as const;

/** Map each context name to the set of backend (needsDb) platforms that host
 *  it — a context is TPH-capable iff that set includes `hono`. */
function backendPlatformsHostingEachContext(loom: EnrichedLoomModel): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sys of loom.systems) {
    for (const d of sys.deployables) {
      if (!platformFor(d.platform).needsDb) continue;
      for (const cn of d.contextNames) {
        const set = out.get(cn) ?? new Set<string>();
        set.add(d.platform);
        out.set(cn, set);
      }
    }
  }
  return out;
}

function validateInheritanceStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  const byName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const hostedByHono = backendPlatforms.has("node");
  for (const agg of ctx.aggregates) {
    if (!agg.isAbstract && !agg.extendsAggregate) continue;
    // A concrete's layout defaults to its base's (resolved within the
    // context); a per-concrete `inheritanceUsing(…)` override wins. The
    // abstract base uses its own declared layout. Either way an omitted
    // modifier means `sharedTable` (TPH), the documented default.
    const base = agg.extendsAggregate ? byName.get(agg.extendsAggregate) : undefined;
    const effective = agg.inheritanceUsing ?? base?.inheritanceUsing ?? DEFAULT_INHERITANCE_LAYOUT;
    if (effective !== "sharedTable") continue;
    // Implemented when a Hono backend hosts the context.
    if (hostedByHono) continue;
    const role = agg.isAbstract ? "abstract base" : `extends ${agg.extendsAggregate}`;
    const how = agg.inheritanceUsing
      ? "inheritanceUsing(sharedTable)"
      : "the omitted-modifier default (sharedTable)";
    const others = [...backendPlatforms].filter((p) => p !== "node");
    const hostNote =
      others.length > 0
        ? `it is hosted by ${others.join(", ")}, where TPH is not implemented`
        : "no Hono backend deployable hosts this context";
    diags.push({
      severity: "error",
      code: "loom.tph-backend-unsupported",
      message:
        `aggregate '${agg.name}' (${role}) resolves to sharedTable (TPH) inheritance via ` +
        `${how}, but TPH storage emission is implemented for the Hono backend only — ` +
        `${hostNote}. Host the context on a Hono deployable, or declare ` +
        `'inheritanceUsing(ownTable)' to use the per-concrete (TPC) layout (all backends). ` +
        `Tracked in aggregate-inheritance.md I2/I3.`,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

// Event-sourced storage emission (`persistedAs(eventLog)`, appliers A2) is
// implemented for the Hono backend only (v1): the `<agg>_events` stream
// table + fold-on-load repository. So an event-sourced aggregate is allowed
// iff its context is hosted by a Hono backend deployable. On .NET / Phoenix
// the aggregate would silently fall back to state persistence (those
// backends don't yet branch on `persistedAs`), losing the event log — an
// error, not a silent downgrade. Mirrors the TPH-only-on-Hono storage gate.
function validateEventSourcedStorage(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
  backendPlatforms: Set<string>,
): void {
  // The Hono backend's platform identifier is `node` (D-PHOENIX-SURFACE /
  // D-REALIZATION-AXES rename); `platform: hono` lowers to it.
  const hostedByHono = backendPlatforms.has("node");
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    if (hostedByHono) continue;
    const others = [...backendPlatforms].filter((p) => p !== "node");
    const hostNote =
      others.length > 0
        ? `it is hosted by ${others.join(", ")}, where event-sourced persistence is not implemented`
        : "no Hono backend deployable hosts this context";
    diags.push({
      severity: "error",
      code: "loom.event-sourcing-backend-unsupported",
      message:
        `aggregate '${agg.name}' is persistedAs(eventLog), but event-sourced storage emission ` +
        `is implemented for the Hono backend only — ${hostNote}. Host the context on a Hono ` +
        `deployable, or drop persistedAs(eventLog) to use state persistence (all backends). ` +
        `Tracked in workflow-and-applier.md (appliers A2).`,
      source: `${ctx.name}/${agg.name}`,
    });
  }
}

function validateDataSourceUnwiredKnobs(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const ds of sys.dataSources) {
    for (const knob of UNWIRED_KNOBS) {
      const value = ds[knob.property];
      if (value === undefined) continue;
      diags.push({
        severity: "warning",
        code: "loom.datasource-knob-unwired",
        message:
          `resource '${ds.name}' sets '${knob.property}', but ${knob.description}.  ` +
          `The value is accepted by validation and persisted in the IR but no current ` +
          `emitter consumes it — this is a no-op at runtime.`,
        source: `${sys.name}/${ds.name}`,
      });
    }
  }
}

function validateE2ETest(
  test: TestE2EIR,
  sys: SystemIR,
  modulesByName: Map<string, SubdomainIR>,
  diags: LoomDiagnostic[],
): void {
  const target = sys.deployables.find((d) => d.name === test.deployableName);
  if (!target) {
    // Validator (Layer ②) already catches this via the cross-ref;
    // skip downstream walks rather than crash.
    return;
  }
  const contexts = collectContexts(target, modulesByName);
  const source = `${sys.name}/${test.name}`;
  const magicId = test.kind === "ui" ? "ui" : "api";
  for (const stmt of test.statements) {
    const badKind = unsupportedE2EStmtKind(stmt);
    if (badKind) {
      // Mirror validateAggregateTestBodies: an e2e body only drives the
      // deployable through `api`/`ui` calls and asserts via expect.  A
      // domain-mutation / guard statement can't be lowered, and silently
      // emitting it would ship a green-but-empty test — so reject it here
      // with a source location instead of leaking a generator fallback.
      diags.push({
        severity: "error",
        code: "loom.e2e-unsupported-statement",
        message:
          `e2e test '${test.name}': '${badKind}' is not supported in an e2e test body. ` +
          `Only expect, expect-throws, let, expression, and ${magicId}.<...> calls are allowed.`,
        source,
      });
      continue;
    }
    walkStmt(stmt, (e) => checkMagicCall(e, magicId, contexts, source, diags));
  }
}

/** Statement kinds an e2e test body cannot lower (domain mutations and
 *  operation guards have no meaning when driving a deployable over HTTP /
 *  the browser).  Returns the offending kind, or null when supported. */
function unsupportedE2EStmtKind(s: TestStmtIR): string | null {
  switch (s.kind) {
    case "expect":
    case "expect-throws":
    case "let":
    case "expression":
    case "call":
      return null;
    default:
      return s.kind;
  }
}

function walkStmt(s: TestStmtIR, visit: (e: ExprIR) => void): void {
  if (
    s.kind === "expect" ||
    s.kind === "expect-throws" ||
    s.kind === "let" ||
    s.kind === "expression"
  ) {
    walkExpr(s.expr, visit);
  }
  if (s.kind === "call") {
    for (const a of s.args) walkExpr(a, visit);
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

function validateExprIntegrity(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
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
  s: import("../types/loom-ir.js").WorkflowStmtIR,
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
  s: import("../types/loom-ir.js").StmtIR,
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

function walkExpr(e: ExprIR | undefined, visit: (e: ExprIR) => void): void {
  if (!e) return;
  visit(e);
  switch (e.kind) {
    case "method-call":
      walkExpr(e.receiver, visit);
      for (const a of e.args) walkExpr(a, visit);
      break;
    case "member":
      walkExpr(e.receiver, visit);
      break;
    case "binary":
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      break;
    case "ternary":
      walkExpr(e.cond, visit);
      walkExpr(e.then, visit);
      walkExpr(e.otherwise, visit);
      break;
    case "unary":
      walkExpr(e.operand, visit);
      break;
    case "paren":
      walkExpr(e.inner, visit);
      break;
    case "call":
      for (const a of e.args) walkExpr(a, visit);
      break;
    case "new":
    case "object":
      for (const f of e.fields) walkExpr(f.value, visit);
      break;
    case "lambda":
      walkExpr(e.body, visit);
      break;
  }
}

function checkMagicCall(
  e: ExprIR,
  magicId: "api" | "ui",
  contexts: BoundedContextIR[],
  source: string,
  diags: LoomDiagnostic[],
): void {
  // Match `<magicId>.<aggregateSlug>.<method>(...)`.
  if (e.kind !== "method-call") return;
  if (e.receiver.kind !== "member") return;
  const r = e.receiver;
  if (r.receiver.kind !== "ref" || r.receiver.name !== magicId) return;
  const aggregateSlug = r.member;
  const method = e.member;
  // Reserved slugs route to system-level orchestration (workflows)
  // or saved queries (views).  `<magicId>.workflows.<name>(...)`
  // resolves to a workflow; `<magicId>.views.<name>(...)` to a view.
  // The React UI generator wires `ui` invocations; the same reserved
  // slugs validate against `api` for symmetry so backend-side
  // dispatchers see a consistent IR shape.
  if (aggregateSlug === "workflows") {
    const wf = contexts
      .flatMap((c) => c.workflows)
      .find((w) => lowerFirst(w.name) === method || snake(w.name) === method);
    if (!wf) {
      const known = contexts
        .flatMap((c) => c.workflows.map((w) => lowerFirst(w.name)))
        .sort()
        .join(", ");
      diags.push({
        severity: "error",
        code: "loom.e2e-unknown-workflow",
        message:
          `e2e: unknown workflow '${magicId}.workflows.${method}' on this deployable. ` +
          `Available workflows: ${known || "(none)"}.`,
        source,
      });
    }
    return;
  }
  if (aggregateSlug === "views") {
    const view = contexts
      .flatMap((c) => c.views)
      .find((v) => lowerFirst(v.name) === method || snake(v.name) === method);
    if (!view) {
      const known = contexts
        .flatMap((c) => c.views.map((v) => lowerFirst(v.name)))
        .sort()
        .join(", ");
      diags.push({
        severity: "error",
        code: "loom.e2e-unknown-view",
        message:
          `e2e: unknown view '${magicId}.views.${method}' on this deployable. ` +
          `Available views: ${known || "(none)"}.`,
        source,
      });
    }
    return;
  }
  const agg = findAggregateBySlug(aggregateSlug, contexts);
  if (!agg) {
    const known = contexts
      .flatMap((c) => c.aggregates.map((a) => snake(plural(a.name))))
      .sort()
      .join(", ");
    diags.push({
      severity: "error",
      code: "loom.e2e-unknown-aggregate",
      message:
        `e2e: unknown aggregate '${magicId}.${aggregateSlug}' on this deployable. ` +
        `Available aggregates: ${known || "(none)"}.`,
      source,
    });
    return;
  }
  if (method === "create" || method === "getById") return;
  const isPublicOp = agg.operations.some((o) => o.visibility === "public" && o.name === method);
  if (isPublicOp) return;
  // Find queries — search every context's repositories for one
  // serving this aggregate.
  const repo = contexts.flatMap((c) => c.repositories).find((r) => r.aggregateName === agg.name);
  const isFind = (repo?.finds ?? []).some((f) => f.name === method);
  if (isFind) return;

  const ops = agg.operations.filter((o) => o.visibility === "public").map((o) => o.name);
  const finds = (repo?.finds ?? []).map((f) => f.name);
  const knownVerbs = ["create", "getById", ...ops, ...finds];
  diags.push({
    severity: "error",
    code: "loom.e2e-unknown-method",
    message:
      `e2e: unknown method '${magicId}.${aggregateSlug}.${method}'. ` +
      `Available: ${knownVerbs.join(", ")}.`,
    source,
  });
}

function collectContexts(
  d: DeployableIR,
  modulesByName: Map<string, SubdomainIR>,
): BoundedContextIR[] {
  // D-STORAGE-SPLIT: d.contextNames lists bounded-context names
  // directly.  Walk every subdomain looking for matches by name.
  const want = new Set(d.contextNames);
  const out: BoundedContextIR[] = [];
  for (const m of modulesByName.values()) {
    for (const c of m.contexts) if (want.has(c.name)) out.push(c);
  }
  return out;
}

function findAggregateBySlug(slug: string, contexts: BoundedContextIR[]): AggregateIR | undefined {
  for (const c of contexts) {
    for (const a of c.aggregates) {
      if (lowerFirst(a.name) === slug) return a;
      if (snake(plural(a.name)) === slug) return a;
      if (lowerFirst(plural(a.name)) === slug) return a;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Workflow validation.
//
// A `workflow` is a context-level orchestration of aggregate operations.
// The grammar reuses operation-body Statement rules; this validator
// constrains the surface to what workflow lowering supports:
//
//   - factory-let (`let x = Agg.create({...})`)
//   - repo-let (`let x = Repo.method(args)`) returning a single
//     non-nullable aggregate
//   - op-call (`name.op(args)` on a let binding)
//   - precondition / emit
//
// Mutation forms (`:=`, `+=`, `-=`), bare-call statements, deep paths,
// nullable / array repo returns, and op-calls on non-aggregate
// bindings all surface as errors here.
// ---------------------------------------------------------------------------

function validateWorkflows(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  // Reserved-name guard: workflows share the context namespace with
  // aggregates, value objects, enums, events, repositories.
  const namesUsed = new Map<string, string>();
  for (const a of ctx.aggregates) namesUsed.set(a.name, "aggregate");
  for (const v of ctx.valueObjects) namesUsed.set(v.name, "value object");
  for (const e of ctx.enums) namesUsed.set(e.name, "enum");
  for (const ev of ctx.events) namesUsed.set(ev.name, "event");
  for (const r of ctx.repositories) namesUsed.set(r.name, "repository");
  const seenWorkflowNames = new Set<string>();
  for (const wf of ctx.workflows) {
    if (seenWorkflowNames.has(wf.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-workflow",
        message: `context '${ctx.name}': workflow '${wf.name}' is declared more than once.`,
        source: `${ctx.name}/${wf.name}`,
      });
    } else {
      seenWorkflowNames.add(wf.name);
    }
    const clash = namesUsed.get(wf.name);
    if (clash) {
      diags.push({
        severity: "error",
        code: "loom.workflow-name-collision",
        message: `context '${ctx.name}': workflow '${wf.name}' collides with the ${clash} of the same name.`,
        source: `${ctx.name}/${wf.name}`,
      });
    }
    validateWorkflowBody(ctx, wf, diags);
    validateWorkflowCorrelation(ctx, wf, diags);
  }
}

/** The resolved type a `by <expr>` correlation expression yields — a member
 *  access carries `memberType`, a bare ref carries `type`. */
function correlationExprType(e: ExprIR): TypeIR | undefined {
  if (e.kind === "member") return e.memberType;
  if (e.kind === "ref") return e.type;
  return undefined;
}

const idTarget = (t: TypeIR | undefined): string | undefined =>
  t && t.kind === "id" ? t.targetName : undefined;

// Correlation-field rules (workflow-and-applier.md A2-S2 + A2-S3).  A workflow
// with event reactors routes inbound events to exactly one id-shaped state
// field — the correlation field.
//
//   - rule 10 (`loom.workflow-correlation-required`) — no id-shaped field.
//   - rule 19 (`loom.correlation-field-ambiguous`)   — more than one.
//   - rule 12 (`loom.correlation-type-mismatch`)     — a `by <expr>` yields a
//     value of a different id type than the correlation field.
//   - (`loom.correlation-uninferrable`) — a reactor omits `by` but its event
//     has no field whose name matches the correlation field, so routing can't
//     be inferred by name-match.
function validateWorkflowCorrelation(
  ctx: BoundedContextIR,
  wf: WorkflowIR,
  diags: LoomDiagnostic[],
): void {
  const subs = wf.subscriptions ?? [];
  if (subs.length === 0) return;
  const src = `${ctx.name}/${wf.name}`;
  const idFields = (wf.stateFields ?? []).filter((f) => f.type.kind === "id");
  if (idFields.length === 0) {
    diags.push({
      severity: "error",
      message:
        `workflow '${wf.name}' has on(...) reactors but no correlation field. ` +
        `Declare one id-shaped state field (e.g. 'orderId: Order id') for the runtime to route inbound events to.`,
      source: src,
      code: "loom.workflow-correlation-required",
    });
    return;
  }
  if (idFields.length > 1) {
    diags.push({
      severity: "error",
      message:
        `workflow '${wf.name}' has ${idFields.length} id-shaped state fields ` +
        `(${idFields.map((f) => f.name).join(", ")}); the correlation field can't be inferred. ` +
        `A workflow with reactors must declare exactly one id-shaped field.`,
      source: src,
      code: "loom.correlation-field-ambiguous",
    });
    return;
  }
  // Exactly one correlation field — type-check each reactor's routing.
  const corr = idFields[0];
  const corrTarget = idTarget(corr.type);
  for (const sub of subs) {
    if (sub.correlation) {
      const byTarget = idTarget(correlationExprType(sub.correlation));
      if (byTarget !== corrTarget) {
        diags.push({
          severity: "error",
          message:
            `workflow '${wf.name}': the 'by' expression on on(${sub.event}) yields ` +
            `${byTarget ? `'${byTarget} id'` : "a non-id value"}, but the correlation field ` +
            `'${corr.name}' is '${corrTarget} id'. A 'by' clause must route by the correlation field's type.`,
          source: src,
          code: "loom.correlation-type-mismatch",
        });
      }
    } else {
      // Omitted `by` — route by name-match: the event must carry a field of
      // the correlation field's name.
      const ev = ctx.events.find((e) => e.name === sub.event);
      const hasMatch = ev?.fields.some((f) => f.name === corr.name) ?? false;
      if (!hasMatch) {
        diags.push({
          severity: "error",
          message:
            `workflow '${wf.name}': on(${sub.event}) omits 'by' but event '${sub.event}' has no ` +
            `field named '${corr.name}' to infer routing from. Add a 'by <expr>' clause.`,
          source: src,
          code: "loom.correlation-uninferrable",
        });
      }
    }
  }
}

function validateWorkflowBody(
  ctx: BoundedContextIR,
  wf: {
    name: string;
    statements: import("../types/loom-ir.js").WorkflowStmtIR[];
    transactional: boolean;
    isolation?: import("../types/loom-ir.js").IsolationLevel;
    params: import("../types/loom-ir.js").ParamIR[];
  },
  diags: LoomDiagnostic[],
): void {
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const reposByName = new Map(ctx.repositories.map((r) => [r.name, r] as const));
  const eventsByName = new Map(ctx.events.map((e) => [e.name, e] as const));
  const bindingAgg = new Map<string, string>(); // bindingName -> aggName
  const arrayBindingAgg = new Map<string, string>(); // repo-run binding -> element aggName
  let mutated = false;

  for (const st of wf.statements) {
    switch (st.kind) {
      case "precondition":
      case "requires":
        // Type-check happens at lowering via `inferExprType`; we'd
        // need the AST node to re-check here.  Trust the lowered IR
        // and emit a warning if the expression looks degenerate
        // (kind === "ref" with refKind "unknown").
        if (st.expr.kind === "ref" && st.expr.refKind === "unknown") {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-name",
            message: `workflow '${wf.name}': ${st.kind} references unknown name '${st.expr.name}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
        }
        break;
      case "emit": {
        const ev = eventsByName.get(st.eventName);
        if (!ev) {
          diags.push({
            severity: "error",
            code: "loom.workflow-emit-unknown-event",
            message: `workflow '${wf.name}': emit refers to unknown event '${st.eventName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const declared = new Set(ev.fields.map((f) => f.name));
        const provided = new Set(st.fields.map((f) => f.name));
        for (const f of declared) {
          if (!provided.has(f)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-emit-missing-field",
              message: `workflow '${wf.name}': emit '${ev.name}' is missing field '${f}'.`,
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        for (const f of provided) {
          if (!declared.has(f)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-emit-unknown-field",
              message: `workflow '${wf.name}': emit '${ev.name}' has unknown field '${f}'.`,
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        mutated = true;
        break;
      }
      case "factory-let": {
        const agg = aggsByName.get(st.aggName);
        if (!agg) {
          diags.push({
            severity: "error",
            code: "loom.workflow-create-unknown-aggregate",
            message: `workflow '${wf.name}': '${st.aggName}.create(...)' references unknown aggregate '${st.aggName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // A workflow `Agg.create({...})` invokes the canonical create,
        // which is parameterized by the aggregate's *create-input* fields
        // — `forCreateInput` drops the server-populated roles
        // (`managed`/`token`/`internal`) and the required subset further
        // drops fields the client may omit (optional, `= default`, bare
        // `bool`).  Validate against that contract, the same set the
        // backends' create-call emitters consume, rather than the raw
        // field list: a `managed` timestamp is neither required here nor a
        // legal argument (passing one would fail the backend create-call).
        const omittable = omittableCreateInputs(agg);
        const inputFields = createInputFields(agg).map((f) => f.name);
        const required = inputFields.filter((n) => !omittable.has(n));
        const provided = new Set(st.fields.map((f) => f.name));
        for (const r of required) {
          if (!provided.has(r)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-create-missing-field",
              message: `workflow '${wf.name}': '${st.aggName}.create(...)' is missing required field '${r}'.`,
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        const allowed = new Set(inputFields);
        for (const p of provided) {
          if (!allowed.has(p)) {
            diags.push({
              severity: "error",
              code: "loom.workflow-create-unknown-field",
              message: `workflow '${wf.name}': '${st.aggName}.create(...)' has unknown field '${p}'.`,
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        bindingAgg.set(st.name, st.aggName);
        mutated = true;
        break;
      }
      case "repo-let": {
        const repo = reposByName.get(st.repoName);
        if (!repo) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-repository",
            message: `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' references unknown repository '${st.repoName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (st.method !== "getById" && !repo.finds.some((f) => f.name === st.method)) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-repository-method",
            message: `workflow '${wf.name}': repository '${st.repoName}' has no method '${st.method}'.  Available: getById, ${repo.finds.map((f) => f.name).join(", ") || "(no declared finds)"}.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // A workflow can't call a find whose where clause references
        // currentUser — the workflow handler doesn't inject
        // ICurrentUserAccessor, and threading the user through saves +
        // ops would be a larger reshape.  Surface a friendly error
        // pointing at the alternative (load by id).
        const calledFind = repo.finds.find((f) => f.name === st.method);
        if (calledFind && findUsesCurrentUser(calledFind)) {
          diags.push({
            severity: "error",
            code: "loom.workflow-currentuser-find",
            message:
              `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' references a currentUser-bound find, ` +
              `which workflows don't yet pass the user into.  Use 'getById' with an explicit id parameter, ` +
              `or call the user-aware find from the route layer instead.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // Reject array / nullable returns — workflow body has no
        // iteration / null-handling vocab in v1.  getById is always
        // a single non-nullable aggregate (the impl throws on miss).
        if (st.method !== "getById") {
          if (st.returnType.kind === "array") {
            diags.push({
              severity: "error",
              code: "loom.workflow-load-array-unsupported",
              message: `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' returns an array; v1 supports only single non-nullable aggregates.  Split iteration into a follow-up workflow or use getById.`,
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          if (st.returnType.kind === "optional") {
            diags.push({
              severity: "error",
              code: "loom.workflow-load-nullable-unsupported",
              message: `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' returns a nullable; v1 supports only single non-nullable aggregates.  Use getById (throws → 404) instead.`,
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
        }
        bindingAgg.set(st.name, st.aggName);
        break;
      }
      case "repo-run": {
        // `let xs = Repo.run(<Retrieval>(args), page?)` — the bound
        // result is an aggregate array, consumable only by a `for-each`.
        const repo = reposByName.get(st.repoName);
        if (!repo) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-unknown-repository",
            message: `workflow '${wf.name}': '${st.repoName}.run(...)' references unknown repository '${st.repoName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const retrieval = ctx.retrievals.find((r) => r.name === st.retrievalName);
        if (!retrieval) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-unknown-retrieval",
            message: `workflow '${wf.name}': '${st.repoName}.run(${st.retrievalName}(...))' references unknown retrieval '${st.retrievalName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const target = retrieval.targetType.kind === "entity" ? retrieval.targetType.name : "";
        if (target !== st.aggName) {
          diags.push({
            severity: "error",
            code: "loom.workflow-run-retrieval-mismatch",
            message: `workflow '${wf.name}': retrieval '${st.retrievalName}' is over '${target}', but '${st.repoName}' is a repository for '${st.aggName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
        }
        // Record the array binding so a `for-each` over it resolves the
        // element aggregate.
        arrayBindingAgg.set(st.name, st.aggName);
        break;
      }
      case "for-each": {
        // The iterable must be an aggregate array (today: a `repo-run`
        // result).  Bind the loop var to the element aggregate so body
        // op-calls resolve, then validate the body op-calls.
        // The iterable should be a `repo-run` array binding (the only
        // aggregate-array producer in v1).  A bare `ref` to such a
        // binding is the supported shape.
        const iterableBinding = st.iterable.kind === "ref" ? st.iterable.name : undefined;
        const isArrayBinding = iterableBinding ? arrayBindingAgg.has(iterableBinding) : false;
        if (st.varAggName === "Unknown" || !isArrayBinding) {
          diags.push({
            severity: "error",
            code: "loom.workflow-foreach-source",
            message: `workflow '${wf.name}': 'for ${st.var} in ...' must iterate a 'let xs = Repo.run(...)' result (the only aggregate array in v1).`,
            source: `${ctx.name}/${wf.name}`,
          });
        }
        bindingAgg.set(st.var, st.varAggName);
        for (const inner of st.body) {
          if (inner.kind === "op-call") {
            mutated = true;
            if (!bindingAgg.get(inner.target)) {
              diags.push({
                severity: "error",
                code: "loom.workflow-foreach-unknown-binding",
                message: `workflow '${wf.name}': in 'for ${st.var}', '${inner.target}.${inner.op}(...)' references unknown binding '${inner.target}'.`,
                source: `${ctx.name}/${wf.name}`,
              });
            }
          }
        }
        break;
      }
      case "op-call": {
        const aggName = bindingAgg.get(st.target);
        if (!aggName) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-binding",
            message: `workflow '${wf.name}': '${st.target}.${st.op}(...)' references unknown let-binding '${st.target}', or '${st.target}' isn't bound to an aggregate.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const agg = aggsByName.get(aggName);
        if (!agg) break;
        const op = agg.operations.find((o) => o.name === st.op);
        if (!op) {
          diags.push({
            severity: "error",
            code: "loom.workflow-unknown-operation",
            message: `workflow '${wf.name}': aggregate '${aggName}' has no operation '${st.op}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (op.visibility === "private") {
          diags.push({
            severity: "error",
            code: "loom.workflow-private-operation",
            message: `workflow '${wf.name}': '${aggName}.${op.name}' is private.  Workflows can only call public operations.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        // (No restriction on extern ops — workflows can call
        // parameterless and parameterized externs alike.  The
        // emission paths construct the wire-typed request from the
        // workflow's domain args via `domainToRequestExpr` (.NET) /
        // a per-VO object-literal projection (TS).)
        mutated = true;
        break;
      }
      case "expr-let": {
        if (st.name === "__bad__") {
          diags.push({
            severity: "error",
            code: "loom.workflow-unrecognised-statement",
            message: `workflow '${wf.name}': statement isn't a recognised workflow form.  Allowed: precondition, let (factory / repo / scalar), name.op(args), emit.`,
            source: `${ctx.name}/${wf.name}`,
          });
        }
        // `let x = files.get(k)` — the bound form of a resource-op.
        checkResourceOpExpr(st.expr, ctx, wf, diags);
        break;
      }
      case "resource-call":
        checkResourceOpExpr(st.call, ctx, wf, diags);
        break;
    }
  }

  if (wf.transactional && !mutated) {
    diags.push({
      severity: "warning",
      code: "loom.transactional-no-effect",
      message: `workflow '${wf.name}': declared 'transactional' but does not mutate any aggregate or emit any event — the keyword has no effect.`,
      source: `${ctx.name}/${wf.name}`,
    });
  }

  // Defence-in-depth: the grammar already gates the isolation level
  // behind the `transactional` keyword, but if a future grammar
  // change drops the gating we'd silently accept a meaningless
  // setting.  Surface it as an error here too.
  if (wf.isolation && !wf.transactional) {
    diags.push({
      severity: "error",
      code: "loom.isolation-requires-transactional",
      message: `workflow '${wf.name}': isolation level '${wf.isolation}' requires the 'transactional' keyword.`,
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// Validate a resource-op call expression in a workflow body (Phase 4):
//   - the verb must belong to the resource's kind vocabulary
//     (lowering leaves `capability === ""` on an unknown verb);
//   - a resource-op may not run inside a transactional span — an S3
//     `put` can't roll back with the DB transaction (use the outbox).
// The capability-gap check (need ⊆ sourceType) is handled by
// `validateNeedCapabilities`, which consumes the usage-derived needs.
function checkResourceOpExpr(
  expr: import("../types/loom-ir.js").ExprIR,
  ctx: BoundedContextIR,
  wf: { name: string; transactional: boolean },
  diags: LoomDiagnostic[],
): void {
  if (expr.kind !== "call" || expr.callKind !== "resource-op" || !expr.resourceOp) return;
  const op = expr.resourceOp;
  if (op.capability === "") {
    diags.push({
      severity: "error",
      code: "loom.resource-verb-invalid",
      message: `workflow '${wf.name}': '${op.resourceName}.${op.verb}(...)' — '${op.verb}' is not a valid verb for a ${op.resourceKind} resource.  Available: ${verbsForKind(op.resourceKind).join(", ") || "(none)"}.`,
      source: `${ctx.name}/${wf.name}`,
    });
  }
  if (wf.transactional) {
    diags.push({
      severity: "error",
      code: "loom.resource-op-in-transaction",
      message: `workflow '${wf.name}': resource operation '${op.resourceName}.${op.verb}(...)' cannot run inside a transactional workflow — external effects don't roll back with the database transaction.  Move it out of the transactional span, or publish through an outbox.`,
      source: `${ctx.name}/${wf.name}`,
    });
  }
}

// ---------------------------------------------------------------------------
// View validation.
//
// A `view <Name> = <Source> where <Filter>` is a saved, strongly-typed
// query.  This validator enforces:
//
//   1. The view name is unique within the context (no clash with
//      aggregates / value objects / enums / events / repositories /
//      workflows or other views).
//   2. The source aggregate exists in the same context.  (The Langium
//      cross-ref already gates this; the IR check guards against
//      downstream IR construction bugs.)
//   3. The where-clause is queryable (same restrictions as repository
//      find filters): no collection ops, no lambdas, no chained
//      traversal beyond `field` / `field.subfield`.  Reuses
//      `firstNonQueryableNode`.
//   4. Every column reference in the filter resolves to a real field
//      on the source aggregate.  Reuses `firstUnknownColumnRef`.
//   5. No comparison sets one column against another (Drizzle's
//      operators model column-vs-value, not column-vs-column).
//      Reuses `firstColumnVsColumn`.
//
// All four reuses come from the v6/v8 work — views inherit the
// existing query semantics rather than introducing new ones.
// ---------------------------------------------------------------------------

function validateViews(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  // Same name-set the workflow validator builds.
  const namesUsed = new Map<string, string>();
  for (const a of ctx.aggregates) namesUsed.set(a.name, "aggregate");
  for (const v of ctx.valueObjects) namesUsed.set(v.name, "value object");
  for (const e of ctx.enums) namesUsed.set(e.name, "enum");
  for (const ev of ctx.events) namesUsed.set(ev.name, "event");
  for (const r of ctx.repositories) namesUsed.set(r.name, "repository");
  for (const wf of ctx.workflows) namesUsed.set(wf.name, "workflow");
  const seen = new Set<string>();
  for (const view of ctx.views) {
    if (seen.has(view.name)) {
      diags.push({
        severity: "error",
        code: "loom.duplicate-view",
        message: `context '${ctx.name}': view '${view.name}' is declared more than once.`,
        source: `${ctx.name}/${view.name}`,
      });
    } else {
      seen.add(view.name);
    }
    const clash = namesUsed.get(view.name);
    if (clash) {
      diags.push({
        severity: "error",
        code: "loom.view-name-collision",
        message: `context '${ctx.name}': view '${view.name}' collides with the ${clash} of the same name.`,
        source: `${ctx.name}/${view.name}`,
      });
    }
    const agg = ctx.aggregates.find((a) => a.name === view.aggregateName);
    if (!agg) {
      diags.push({
        severity: "error",
        code: "loom.view-unknown-source",
        message: `view '${view.name}': source '${view.aggregateName}' is not an aggregate in context '${ctx.name}'.`,
        source: `${ctx.name}/${view.name}`,
      });
      continue;
    }
    if (view.filter) {
      const offending = firstNonQueryableNode(view.filter);
      if (offending) {
        diags.push({
          severity: "error",
          code: "loom.view-where-not-queryable",
          message:
            `view '${view.name}': where-clause is not queryable (${offending}). ` +
            `Allowed: comparisons, &&/||/!, parens, ` +
            `'this.<column>' / 'this.<vo>.<sub>' refs, parameter refs, literals.`,
          source: `${ctx.name}/${view.name}`,
        });
        continue;
      }
      const unknown = firstUnknownColumnRef(view.filter, agg, ctx);
      if (unknown) {
        diags.push({
          severity: "error",
          code: "loom.view-where-unknown-field",
          message: `view '${view.name}': where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
          source: `${ctx.name}/${view.name}`,
        });
      }
      const bothCols = firstColumnVsColumn(view.filter);
      if (bothCols) {
        diags.push({
          severity: "error",
          code: "loom.view-where-column-column",
          message:
            `view '${view.name}': comparison between two columns (${bothCols}) is not queryable. ` +
            `Drizzle's eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
          source: `${ctx.name}/${view.name}`,
        });
      }
    }
    // Full-form view: bind exhaustiveness + per-bind name validity.
    if (view.output) {
      const fieldNames = new Set(view.output.fields.map((f) => f.name));
      const boundNames = new Set(view.output.binds.map((b) => b.name));
      for (const f of view.output.fields) {
        if (!boundNames.has(f.name)) {
          diags.push({
            severity: "error",
            code: "loom.view-field-unbound",
            message: `view '${view.name}': field '${f.name}' has no bind expression.  Add 'bind ${f.name} = ...' to the body.`,
            source: `${ctx.name}/${view.name}`,
          });
        }
      }
      const seenBinds = new Set<string>();
      for (const b of view.output.binds) {
        if (!fieldNames.has(b.name)) {
          diags.push({
            severity: "error",
            code: "loom.view-bind-no-field",
            message: `view '${view.name}': bind '${b.name}' has no matching declared field.  Either declare 'name: Type' at the top of the view or remove the bind.`,
            source: `${ctx.name}/${view.name}`,
          });
        }
        if (seenBinds.has(b.name)) {
          diags.push({
            severity: "error",
            code: "loom.view-bind-duplicate",
            message: `view '${view.name}': field '${b.name}' is bound more than once.`,
            source: `${ctx.name}/${view.name}`,
          });
        }
        seenBinds.add(b.name);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auth validation.
//
// Two responsibilities:
//
//   1. System-wide shape: a deployable opting in via `auth: required`
//      needs the system to declare a `user { ... }` block (otherwise
//      there's no shape for the verifier hook to decode tokens into).
//      Duplicate user-field names rejected here too, defensively —
//      the parser doesn't structurally enforce uniqueness.
//
//   2. `currentUser` scope: the magic identifier resolves to a typed
//      ref via `lower-expr.ts:resolveNameRef` whenever the system
//      declares a user block.  Bodies may USE `currentUser` in
//      operations / workflows / view binds / aggregate test bodies,
//      plus repository find / view where filters; everywhere else
//      (invariants, derived properties, function bodies) the reference
//      is rejected with a friendly message pointing at where it is
//      allowed.
// ---------------------------------------------------------------------------

function validateAuth(sys: SystemIR, diags: LoomDiagnostic[]): void {
  // (1) Duplicate user-field names — Property doesn't structurally
  // enforce uniqueness, so a hand-rolled `user { id: string, id: int }`
  // would silently lower to two fields with the same name.
  if (sys.user) {
    const seen = new Set<string>();
    for (const f of sys.user.fields) {
      if (seen.has(f.name)) {
        diags.push({
          severity: "error",
          code: "loom.user-duplicate-field",
          message: `system '${sys.name}': user block declares field '${f.name}' more than once.`,
          source: `${sys.name}/user`,
        });
      }
      seen.add(f.name);
    }
  }
  // (2) `auth: required` deployables MUST have a user block.  Without
  // one, the verifier hook has no shape to populate, and `currentUser`
  // references in any body would resolve to an unknown ref.
  for (const d of sys.deployables) {
    if (d.auth?.required && !sys.user) {
      diags.push({
        severity: "error",
        code: "loom.auth-no-user-block",
        message:
          `deployable '${d.name}' has 'auth: required' but system '${sys.name}' declares no 'user { ... }' block. ` +
          `Add a system-level user block describing the JWT claim shape (e.g. 'user { id: string, role: string }').`,
        source: `${sys.name}/${d.name}`,
      });
    }
  }
}

/** Walk every expression inside an entity's invariants, derived
 *  properties, function bodies, view filters, and repository find
 *  filters; flag any `current-user` ref found there.  Uses the
 *  existing `walkExpr` helper. */
function validateCurrentUserScope(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
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

// `validateScaffoldDoubles` deleted.  Cross-directive
// double-scaffold detection now happens at the AST level: two
// scaffold directives producing the same generated page name surface
// either as a duplicate-symbol error from Langium's linker (when both
// pages reach the AST) or as a no-op in the expander (the second
// synthesis is suppressed by the per-ui name set).  Keeping the IR-
// level fallback would either duplicate the error or produce a
// confusing second diagnostic; better to let the AST layer own it.

function validatePermissions(sys: SystemIR, diags: LoomDiagnostic[]): void {
  for (const mod of sys.subdomains) {
    if (mod.permissions.length === 0) continue;
    const seen = new Set<string>();
    for (const p of mod.permissions) {
      if (seen.has(p.name)) {
        diags.push({
          severity: "error",
          code: "loom.duplicate-permission",
          message: `subdomain '${mod.name}': permission '${p.name}' is declared more than once.`,
          source: `${sys.name}/${mod.name}/permissions.${p.name}`,
        });
      }
      seen.add(p.name);
    }
  }
}

function validatePermissionRefs(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
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
  s: import("../types/loom-ir.js").TestStmtIR,
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
