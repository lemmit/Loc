// -------------------------------------------------------------------------
// Test-body checks — `test`/`test e2e` statement legality and the
// `api.<x>.<verb>` / `ui.<x>.<verb>` magic-call resolution.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  SubdomainIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
} from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { walkExpr } from "./shared.js";

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

export function validateAggregateTestBodies(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const agg of ctx.aggregates) {
    for (const test of agg.tests) {
      for (const stmt of test.statements) {
        const reason = invalidTestStmt(stmt);
        if (!reason) continue;
        diags.push({
          severity: "error",
          code: "loom.aggregate-test-context",
          message: diagMessage("loom.aggregate-test-context", {
            name: agg.name,
            testName: test.name,
            reason,
          }),
          source: `${ctx.name}/${agg.name}.test:${test.name}`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Context-scoped INTEGRATION test bodies (test-placement.md, Phase 3a).
//
// The node integration renderer awaits a repository read at STATEMENT level
// (`const x = await repos.<agg>.<find>(...)`), so a find must be let-bound before
// its result is asserted.  A find written INLINE inside `expect(...)` has no
// statement to await it — reject it with a fix hint (the async-in-expression
// edition is a deferred follow-up).
// ---------------------------------------------------------------------------

export function validateContextIntegrationTests(
  ctx: BoundedContextIR,
  diags: LoomDiagnostic[],
): void {
  const BUILTIN_READS = new Set(["findById", "getById", "findAll"]);
  const isRepoFind = (e: ExprIR): boolean => {
    if (e.kind !== "method-call" || e.receiver.kind !== "ref") return false;
    const aggName = (e.receiver as { name: string }).name;
    const repos = ctx.repositories.filter((r) => r.aggregateName === aggName);
    if (repos.length === 0) return false;
    return (
      BUILTIN_READS.has(e.member) || repos.some((r) => r.finds.some((f) => f.name === e.member))
    );
  };
  for (const test of ctx.tests) {
    for (const stmt of test.statements) {
      if (stmt.kind !== "expect" && stmt.kind !== "expect-throws") continue;
      let inlineFind = false;
      walkExpr(stmt.expr, (e) => {
        if (isRepoFind(e)) inlineFind = true;
      });
      if (inlineFind) {
        diags.push({
          severity: "error",
          code: "loom.integration-find-must-bind",
          message: diagMessage("loom.integration-find-must-bind", {
            name: ctx.name,
            testName: test.name,
          }),
          source: `${ctx.name}.test:${test.name}`,
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

export function validateE2ETest(
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

  // Every name an e2e body may legitimately spell: the magic receivers and its
  // own `let` bindings.  Collected up front (not as the walk progresses) so a
  // forward reference reports as its own problem rather than as an unknown
  // name.
  //
  // BOTH magic ids are bound, not just this test's `magicId`.  A test's kind is
  // derived from the TARGET DEPLOYABLE's platform, not from what the body
  // spells — so an api-shaped body (`api.orders.create(…)`) aimed at a
  // UI-mounting deployable classifies as `ui` while still, correctly, spelling
  // `api`.  Binding only `magicId` rejected every such test: the whole
  // behavioral Phoenix leg failed to generate.
  const bound = new Set<string>(["api", "ui"]);
  for (const stmt of test.statements) if (stmt.kind === "let") bound.add(stmt.name);

  for (const stmt of test.statements) {
    walkStmt(stmt, (e) => checkUnresolvedRef(e, bound, test.name, source, diags));
  }

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
        message: diagMessage("loom.e2e-unsupported-statement", {
          name: test.name,
          badKind,
          magicId,
        }),
        source,
      });
      continue;
    }
    walkStmt(stmt, (e) => checkMagicCall(e, magicId, contexts, source, diags));
  }
}

/**
 * A bare name in an e2e body that binds to nothing.
 *
 * `lower-expr.ts` deliberately does NOT resolve enum values (or any
 * context-scoped name) inside an e2e test — there is no single enclosing
 * context to resolve against, since one body may drive several — so bare names
 * lower to `refKind: "unknown"` and the e2e renderer emits them VERBATIM.
 * That is exactly right for a `let` local, and silently wrong for everything
 * else: `api.orders.update(o, { status: Placed })` lowered to an unknown ref
 * and emitted `status: Placed`, an undefined identifier.  Valid `.ddd` in,
 * uncompilable TypeScript out, with no diagnostic anywhere in between — the
 * silent-codegen class this repo keeps finding by compiling its own output.
 *
 * An e2e test speaks WIRE, not domain: it POSTs JSON and reads JSON back.  So
 * the fix for the enum case is to write the serialized string (`"Placed"`),
 * which is what the backend actually sends and receives, and the message says
 * so.
 */
function checkUnresolvedRef(
  e: ExprIR,
  bound: ReadonlySet<string>,
  testName: string,
  source: string,
  diags: LoomDiagnostic[],
): void {
  // The CALL twin of the same hole.  A name applied to arguments lowers to a
  // `callKind: "free"` Call (never a `ref`), which the renderer also emits
  // VERBATIM — so `expect(number(t.revenue)).toBe(40)` shipped `number(...)`,
  // a ReferenceError in the generated suite, past a bare-name gate that only
  // looked at `ref`.  Everything an e2e body may legitimately call lowers to
  // something else first (`money("…")`/`decimal(x)` → convert, `now()` →
  // literal), so a residual free call is always an undefined identifier.
  if (e.kind === "call" && e.callKind === "free") {
    diags.push({
      severity: "error",
      code: "loom.e2e-unresolved-call",
      message:
        `e2e test '${testName}': '${e.name}(…)' resolves to no function. ` +
        `An e2e body drives the deployable over HTTP and resolves no domain names; ` +
        `the conversions it may call (money(…), decimal(…), string(…), int(…)) are ` +
        `built in. Emitting it verbatim would ship an undefined identifier in the ` +
        `generated test.`,
      source,
    });
    return;
  }
  if (e.kind !== "ref" || e.refKind !== "unknown" || bound.has(e.name)) return;
  diags.push({
    severity: "error",
    code: "loom.e2e-unresolved-ref",
    message: diagMessage("loom.e2e-unresolved-ref", { testName, name: e.name }),
    source,
  });
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
  // The reserved `workflows` slug routes to system-level orchestration:
  // `<magicId>.workflows.<name>(...)` resolves to a workflow.
  // The React UI generator wires `ui` invocations; the reserved slug
  // validates against `api` for symmetry so backend-side dispatchers see a
  // consistent IR shape.
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
        message: diagMessage("loom.e2e-unknown-workflow", {
          magicId,
          method,
          known: known || "(none)",
        }),
        source,
      });
    }
    return;
  }
  // A folded projection's read surface (projection.md): `api.<proj>.byKey(k)` /
  // `.list()` read `GET /projections/<snake>`.  Resolved before the aggregate
  // lookup — the read verbs (`byKey`/`list`) are projection-only.  Only `api`
  // tests reach a projection (the UI has no projection-read page object).
  if (magicId === "api") {
    const proj = contexts
      .flatMap((c) => c.projections)
      .find((p) => lowerFirst(p.name) === aggregateSlug || snake(p.name) === aggregateSlug);
    if (proj) {
      if (method === "byKey" || method === "list") return;
      diags.push({
        severity: "error",
        code: "loom.e2e-unknown-method",
        message: diagMessage("loom.e2e-unknown-method#projection", {
          magicId,
          aggregateSlug,
          method,
        }),
        source,
      });
      return;
    }
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
      message: diagMessage("loom.e2e-unknown-aggregate", {
        magicId,
        aggregateSlug,
        known: known || "(none)",
      }),
      source,
    });
    return;
  }
  if (method === "create" || method === "getById") return;
  // The CANONICAL destroy (`DELETE /api/<aggs>/{id}`).  It lives on
  // `agg.canonicalDestroy`, NOT in `agg.operations` (lowering keeps the
  // lifecycle actions in their own arrays), so without this arm the verb the
  // route derivation exposes was rejected as an unknown method — the route
  // existed on all five backends and no `test e2e` body could reach it.
  // Gated on `canonicalDestroy` exactly as `deriveAggregateOperations` gates
  // the DELETE route: a NAMED destroy (`destroy archive { }`) has no route, so
  // it must keep falling through to the unknown-method error below.
  if (method === "destroy" && agg.canonicalDestroy) return;
  const isPublicOp = agg.operations.some((o) => o.visibility === "public" && o.name === method);
  if (isPublicOp) return;
  // Find queries — search every context's repositories for one
  // serving this aggregate.
  const repo = contexts.flatMap((c) => c.repositories).find((r) => r.aggregateName === agg.name);
  const isFind = (repo?.finds ?? []).some((f) => f.name === method);
  if (isFind) return;
  // Entity history (docs/audit.md): `api.<agg>.history(id)` → `GET
  // /<agg>/{id}/history`.  Checked against `historyFind` rather than `finds` —
  // the derived history read sits beside them (see `RepositoryIR.historyFind`),
  // so an aggregate that is not `audited` has no history to call and the
  // unknown-method error below is the right answer.
  if (method === "history" && repo?.historyFind) return;

  const ops = agg.operations.filter((o) => o.visibility === "public").map((o) => o.name);
  const finds = (repo?.finds ?? []).map((f) => f.name);
  const knownVerbs = [
    "create",
    "getById",
    ...(agg.canonicalDestroy ? ["destroy"] : []),
    ...(repo?.historyFind ? ["history"] : []),
    ...ops,
    ...finds,
  ];
  diags.push({
    severity: "error",
    code: "loom.e2e-unknown-method",
    message: diagMessage("loom.e2e-unknown-method#aggregate-verb", {
      magicId,
      aggregateSlug,
      method,
      knownVerbs: knownVerbs.join(", "),
    }),
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
