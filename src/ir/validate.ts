import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  LoomModel,
  ModuleIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
  TypeIR,
} from "./loom-ir.js";
import { allContexts } from "./loom-ir.js";
import { allPlatforms } from "../platform/registry.js";
import { camel, plural, snake } from "../util/naming.js";

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

export function validateLoomModel(loom: LoomModel): LoomDiagnostic[] {
  const diags: LoomDiagnostic[] = [];
  for (const sys of loom.systems) {
    validateSystem(sys, diags);
    validateReactIdReferences(sys, diags);
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
  }
  return diags;
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

function validateFindNameCollisions(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
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
          message:
            `repository '${repo.name}' declares find '${find.name}' more than once.`,
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

function validateAggregateTestBodies(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
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

function validateExternOperations(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
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
// `Id<X>` validation for React deployables.
//
// The React form generator renders an `Id<X>` form field as a `<Select>`
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
// deployables don't trigger these checks — `Id<X>` on the wire is
// just a string/uuid and doesn't depend on a display label.
// ---------------------------------------------------------------------------

function validateReactIdReferences(
  sys: SystemIR,
  diags: LoomDiagnostic[],
): void {
  // Build an aggregate registry across the whole system so we can
  // look up display fields regardless of which module declares the
  // target aggregate.
  const allAggregates = new Map<string, AggregateIR>();
  for (const m of sys.modules) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) allAggregates.set(a.name, a);
    }
  }

  for (const d of sys.deployables) {
    if (d.platform !== "react") continue;
    // Aggregates mounted by this deployable's `moduleNames` set —
    // the React generator only emits `useAll<X>()` imports for
    // these; anything outside is unreachable.
    const mounted = new Set<string>();
    for (const moduleName of d.moduleNames) {
      const mod = sys.modules.find((m) => m.name === moduleName);
      if (!mod) continue;
      for (const c of mod.contexts) for (const a of c.aggregates) mounted.add(a.name);
    }

    // Walk every operation param + every aggregate field that lowers to
    // an `Id<X>` and check both invariants against the system-wide
    // registry + this deployable's mounted set.
    for (const aggName of mounted) {
      const agg = allAggregates.get(aggName);
      if (!agg) continue;
      // Aggregate root fields.
      for (const f of agg.fields) {
        checkIdReference(
          f.type,
          `${aggName}.${f.name}`,
          d.name,
          allAggregates,
          mounted,
          diags,
        );
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
      // shapes, but their `Id<X>` properties show up as foreign
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
      message:
        `react deployable '${deployableName}': '${source}' references Id<${target}>, but no aggregate '${target}' is declared in the system.`,
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
        `react deployable '${deployableName}': '${source}' references Id<${target}>, but '${target}' is not mounted on this deployable's modules.  ` +
        `Mount the module containing '${target}' on the deployable's targeted backend, or remove the reference.`,
      source: `${deployableName}/${source}`,
    });
    return;
  }
  // 3. Target aggregate must declare a `display` field (so the
  //    Select picker has a sensible option label).
  if (!agg.fields.some((f) => f.display)) {
    diags.push({
      severity: "error",
      message:
        `react deployable '${deployableName}': '${source}' references Id<${target}>, but '${target}' has no 'display' field.  ` +
        `Add 'string display' to one of '${target}''s string fields (e.g. 'name: string display') so the form's <Select> picker can label options.`,
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

function validateQueryableWheres(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
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
function firstUnknownColumnRef(
  e: ExprIR,
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string | null {
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
      return (
        firstUnknownColumnRef(e.left, agg, ctx) ??
        firstUnknownColumnRef(e.right, agg, ctx)
      );
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
          (f) =>
            f.name === (e.receiver as { member: string }).member,
        );
        if (!voField) {
          return `'this.${(e.receiver as { member: string }).member}'`;
        }
        const voName =
          e.receiver.memberType.kind === "valueobject"
            ? e.receiver.memberType.name
            : "";
        const vo = ctx.valueObjects.find((v) => v.name === voName);
        if (vo && vo.fields.some((f) => f.name === e.member)) return null;
        return `'this.${(e.receiver as { member: string }).member}.${e.member}'`;
      }
      return null;
    }
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
  if (
    e.kind === "member" &&
    e.receiver.kind === "member" &&
    e.receiver.receiver.kind === "this"
  )
    return true;
  return false;
}

function describeColumnRef(e: ExprIR): string {
  if (e.kind === "paren") return describeColumnRef(e.inner);
  if (e.kind === "ref" && e.refKind === "this-prop") return `'this.${e.name}'`;
  if (e.kind === "member" && e.receiver.kind === "this")
    return `'this.${e.member}'`;
  if (
    e.kind === "member" &&
    e.receiver.kind === "member" &&
    e.receiver.receiver.kind === "this"
  )
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
      // (handled via member access).
      if (
        e.refKind === "param" ||
        e.refKind === "let" ||
        e.refKind === "lambda" ||
        e.refKind === "this-prop" ||
        e.refKind === "enum-value" ||
        e.refKind === "this-vo-prop"
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
          return (
            firstNonQueryableNode(e.left) ?? firstNonQueryableNode(e.right)
          );
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
      // Allowed column-access shapes:
      //   - `this.col`         — direct column
      //   - `this.vo.sub`      — value-object's flattened column
      if (e.receiver.kind === "this") return null;
      if (
        e.receiver.kind === "member" &&
        e.receiver.receiver.kind === "this" &&
        e.receiver.memberType.kind === "valueobject"
      )
        return null;
      return "member access not rooted at 'this' or beyond a flattened value object";
    case "method-call":
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
  }
}

function validateSystem(sys: SystemIR, diags: LoomDiagnostic[]): void {
  const modulesByName = new Map<string, ModuleIR>();
  for (const m of sys.modules) modulesByName.set(m.name, m);
  for (const t of sys.e2eTests) {
    validateE2ETest(t, sys, modulesByName, diags);
  }
}

function validateE2ETest(
  test: TestE2EIR,
  sys: SystemIR,
  modulesByName: Map<string, ModuleIR>,
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
    walkStmt(stmt, (e) => checkMagicCall(e, magicId, contexts, source, diags));
  }
}

function walkStmt(
  s: TestStmtIR,
  visit: (e: ExprIR) => void,
): void {
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
  const isPublicOp = agg.operations.some(
    (o) => o.visibility === "public" && o.name === method,
  );
  if (isPublicOp) return;
  // Find queries — search every context's repositories for one
  // serving this aggregate.
  const repo = contexts
    .flatMap((c) => c.repositories)
    .find((r) => r.aggregateName === agg.name);
  const isFind = (repo?.finds ?? []).some((f) => f.name === method);
  if (isFind) return;

  const ops = agg.operations
    .filter((o) => o.visibility === "public")
    .map((o) => o.name);
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
  modulesByName: Map<string, ModuleIR>,
): BoundedContextIR[] {
  const out: BoundedContextIR[] = [];
  for (const name of d.moduleNames) {
    const m = modulesByName.get(name);
    if (m) out.push(...m.contexts);
  }
  return out;
}

function findAggregateBySlug(
  slug: string,
  contexts: BoundedContextIR[],
): AggregateIR | undefined {
  for (const c of contexts) {
    for (const a of c.aggregates) {
      if (camel(a.name) === slug) return a;
      if (snake(plural(a.name)) === slug) return a;
      if (camel(plural(a.name)) === slug) return a;
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

function validateWorkflows(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
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
    statements: import("./loom-ir.js").WorkflowStmtIR[];
    transactional: boolean;
    isolation?: import("./loom-ir.js").IsolationLevel;
    params: import("./loom-ir.js").ParamIR[];
  },
  diags: LoomDiagnostic[],
): void {
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const reposByName = new Map(
    ctx.repositories.map((r) => [r.name, r] as const),
  );
  const eventsByName = new Map(ctx.events.map((e) => [e.name, e] as const));
  const bindingAgg = new Map<string, string>(); // bindingName -> aggName
  let mutated = false;

  for (const st of wf.statements) {
    switch (st.kind) {
      case "precondition":
        // Type-check happens at lowering via `inferExprType`; we'd
        // need the AST node to re-check here.  Trust the lowered IR
        // and emit a warning if the expression looks degenerate
        // (kind === "ref" with refKind "unknown").
        if (
          st.expr.kind === "ref" &&
          st.expr.refKind === "unknown"
        ) {
          diags.push({
            severity: "error",
            message: `workflow '${wf.name}': precondition references unknown name '${st.expr.name}'.`,
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
        if (
          st.method !== "getById" &&
          !repo.finds.some((f) => f.name === st.method)
        ) {
          diags.push({
            severity: "error",
            message: `workflow '${wf.name}': repository '${st.repoName}' has no method '${st.method}'.  Available: getById, ${repo.finds.map((f) => f.name).join(", ") || "(no declared finds)"}.`,
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
        if (op.extern) {
          diags.push({
            severity: "error",
            message: `workflow '${wf.name}': '${aggName}.${op.name}' is an extern operation.  Extern ops are reachable only via their HTTP route + user handler, not from another orchestration layer.`,
            source: `${ctx.name}/${wf.name}`,
          });
          break;
        }
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

function validateViews(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
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
        message:
          `view '${view.name}': where-clause references unknown field ${unknown} on aggregate '${agg.name}'.`,
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
}
