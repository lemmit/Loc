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
    for (const m of sys.modules) {
      for (const c of m.contexts) {
        validateQueryableWheres(c, diags);
        validateFindNameCollisions(c, diags);
      }
    }
    validateReactIdReferences(sys, diags);
  }
  for (const c of loom.contexts) {
    validateQueryableWheres(c, diags);
    validateFindNameCollisions(c, diags);
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

const RESERVED_FIND_NAMES = new Set(["save", "findById"]);

function validateFindNameCollisions(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
  for (const repo of ctx.repositories) {
    const seen = new Set<string>();
    for (const find of repo.finds) {
      if (RESERVED_FIND_NAMES.has(find.name)) {
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
      }
    }
  }
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
