// -------------------------------------------------------------------------
// Test-body checks — `test`/`test e2e` statement legality and the
// `api.<x>.<verb>` / `ui.<x>.<verb>` magic-call resolution.
// -------------------------------------------------------------------------

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
          message:
            `context '${ctx.name}' integration test '${test.name}': a repository read inside ` +
            `'expect(...)' must be let-bound first — write \`let x = <Agg>.findById(...)\` then ` +
            `assert over \`x\` (the integration renderer awaits the read at statement level).`,
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
