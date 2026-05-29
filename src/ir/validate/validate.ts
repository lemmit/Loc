import { platformOwnsBackend } from "../../language/validators/data/platform-rules.js";
import { allPlatforms, platformFor } from "../../platform/registry.js";
import { lowerFirst, plural, snake } from "../../util/naming.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DataSourceIR,
  DeployableIR,
  EnrichedAggregateIR,
  EnrichedLoomModel,
  ExprIR,
  SubdomainIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
  TypeIR,
} from "../types/loom-ir.js";
import { allContexts, findUsesCurrentUser } from "../types/loom-ir.js";
import { dataSourceKindForAggregate } from "../util/resolve-datasource.js";

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
  // Per-context checks apply uniformly whether the context is
  // bundled in a system's modules or sits at the top level.
  for (const c of allContexts(loom)) {
    validateQueryableWheres(c, diags);
    validateFindNameCollisions(c, diags);
    validateAggregateTestBodies(c, diags);
    validateExternOperations(c, diags);
    validateWorkflows(c, diags);
    validateViews(c, diags);
    validateCurrentUserScope(c, diags);
    validatePermissionRefs(c, diags);
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
          message:
            `repository '${repo.name}' find '${find.name}': name collides with the auto-emitted repository method '${find.name}(...)'. ` +
            `Choose a different find name (e.g. 'persist', 'fetchById').`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
      if (seen.has(find.name)) {
        diags.push({
          severity: "error",
          message: `repository '${repo.name}' declares find '${find.name}' more than once.`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
      seen.add(find.name);
    }
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
          message:
            `repository '${repo.name}' find '${find.name}': ` +
            `comparison between two columns (${bothCols}) is not queryable. ` +
            `Drizzle's eq()/ne()/lt()/etc. require one column and one value (parameter, literal, or enum value).`,
          source: `${ctx.name}/${repo.name}.${find.name}`,
        });
      }
    }
  }
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
function firstNonQueryableNode(e: ExprIR): string | null {
  switch (e.kind) {
    case "literal":
    case "this":
    case "id":
      return null;
    case "ref":
      // Refs the lowering produces that translate cleanly to SQL —
      // `param`/`let`/`lambda` are bare identifiers, `this-prop`
      // becomes `tableName.col`, `enum-value` becomes a literal
      // string, `this-vo-prop` is a column flattened by Drizzle
      // (handled via member access).  `current-user` is a
      // closure-captured value; the renderer threads a
      // `currentUser` parameter through the repo method and the
      // ref / its member accesses become plain JS / C# value
      // references.
      if (
        e.refKind === "param" ||
        e.refKind === "let" ||
        e.refKind === "lambda" ||
        e.refKind === "this-prop" ||
        e.refKind === "enum-value" ||
        e.refKind === "this-vo-prop" ||
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
// Only fires for backend deployables (dotnet, hono, phoenixLiveView).
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
          message:
            `Deployable '${dep.name}' hosts aggregate '${ctxName}.${agg.name}' ` +
            `(persistenceStrategy: ${agg.persistenceStrategy ?? "stateBased"}, ` +
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
        message:
          `Deployable '${dep.name}' lists dataSource '${ds.name}' (kind: ${ds.kind}) for ` +
          `context '${ds.contextName}', but ${reason}.  This binding routes no data — ` +
          `remove it, or add an aggregate whose persistenceStrategy needs kind: ${ds.kind}.`,
        source: `${sys.name}/${dep.name}`,
      });
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
function coverageGapReason(kind: string, ctx: BoundedContextIR): string | undefined {
  const aggs = ctx.aggregates;
  if (aggs.length === 0) return "the context declares no aggregates";
  const hasState = aggs.some((a) => (a.persistenceStrategy ?? "stateBased") === "stateBased");
  const hasES = aggs.some((a) => a.persistenceStrategy === "eventSourced");
  if (kind === "state" && !hasState) {
    return "every aggregate is eventSourced (none need kind: state persistence)";
  }
  if ((kind === "eventLog" || kind === "snapshot") && !hasES) {
    return "no aggregate is eventSourced (kind: " + kind + " has no event stream to back)";
  }
  // cache / replica only require at least one aggregate, already
  // checked above.
  return undefined;
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
        message: `context '${ctx.name}': workflow '${wf.name}' collides with the ${clash} of the same name.`,
        source: `${ctx.name}/${wf.name}`,
      });
    }
    validateWorkflowBody(ctx, wf, diags);
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
              message: `workflow '${wf.name}': emit '${ev.name}' is missing field '${f}'.`,
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        for (const f of provided) {
          if (!declared.has(f)) {
            diags.push({
              severity: "error",
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
            message: `workflow '${wf.name}': '${st.aggName}.create(...)' references unknown aggregate '${st.aggName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        const required = agg.fields.filter((f) => !f.optional).map((f) => f.name);
        const provided = new Set(st.fields.map((f) => f.name));
        for (const r of required) {
          if (!provided.has(r)) {
            diags.push({
              severity: "error",
              message: `workflow '${wf.name}': '${st.aggName}.create(...)' is missing required field '${r}'.`,
              source: `${ctx.name}/${wf.name}`,
            });
          }
        }
        const allowed = new Set(agg.fields.map((f) => f.name));
        for (const p of provided) {
          if (!allowed.has(p)) {
            diags.push({
              severity: "error",
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
            message: `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' references unknown repository '${st.repoName}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (st.method !== "getById" && !repo.finds.some((f) => f.name === st.method)) {
          diags.push({
            severity: "error",
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
              message: `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' returns an array; v1 supports only single non-nullable aggregates.  Split iteration into a follow-up workflow or use getById.`,
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
          if (st.returnType.kind === "optional") {
            diags.push({
              severity: "error",
              message: `workflow '${wf.name}': '${st.repoName}.${st.method}(...)' returns a nullable; v1 supports only single non-nullable aggregates.  Use getById (throws → 404) instead.`,
              source: `${ctx.name}/${wf.name}`,
            });
            break;
          }
        }
        bindingAgg.set(st.name, st.aggName);
        break;
      }
      case "op-call": {
        const aggName = bindingAgg.get(st.target);
        if (!aggName) {
          diags.push({
            severity: "error",
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
            message: `workflow '${wf.name}': aggregate '${aggName}' has no operation '${st.op}'.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
        if (op.visibility === "private") {
          diags.push({
            severity: "error",
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
            message: `workflow '${wf.name}': statement isn't a recognised workflow form.  Allowed: precondition, let (factory / repo / scalar), name.op(args), emit.`,
            source: `${ctx.name}/${wf.name}`,
          });
        }
        break;
      }
    }
  }

  if (wf.transactional && !mutated) {
    diags.push({
      severity: "warning",
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
      message: `workflow '${wf.name}': isolation level '${wf.isolation}' requires the 'transactional' keyword.`,
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
        message: `context '${ctx.name}': view '${view.name}' collides with the ${clash} of the same name.`,
        source: `${ctx.name}/${view.name}`,
      });
    }
    const agg = ctx.aggregates.find((a) => a.name === view.aggregateName);
    if (!agg) {
      diags.push({
        severity: "error",
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
          message: `view '${view.name}': where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
          source: `${ctx.name}/${view.name}`,
        });
      }
      const bothCols = firstColumnVsColumn(view.filter);
      if (bothCols) {
        diags.push({
          severity: "error",
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
            message: `view '${view.name}': bind '${b.name}' has no matching declared field.  Either declare 'name: Type' at the top of the view or remove the bind.`,
            source: `${ctx.name}/${view.name}`,
          });
        }
        if (seenBinds.has(b.name)) {
          diags.push({
            severity: "error",
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
          message: `module '${mod.name}': permission '${p.name}' is declared more than once.`,
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
          message:
            `permissions.${name}: no permission named '${name}' is declared in this module's 'permissions { ... }' block. ` +
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
