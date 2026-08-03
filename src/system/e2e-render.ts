import { isDescendingSort } from "../generator/typescript/render-expr.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  FindIR,
  OperationIR,
  Platform,
  ProjectionIR,
  SubdomainIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
} from "../ir/types/loom-ir.js";
import { platformFor } from "../platform/registry.js";
import { API_BASE_PATH } from "../util/api-base.js";
import { lowerFirst, plural, snake } from "../util/naming.js";
import { DURATION_UNIT_MS } from "../util/temporal.js";
import { renderExpectStmt } from "./expect-stmt.js";

// ---------------------------------------------------------------------------
// E2E test renderer.
//
// Lowers a system's `test e2e "..." against <deployable> { … }` blocks to a
// single vitest file at `<system>/e2e/<systemName>.e2e.test.ts`.
//
// Inside an e2e body, the magic identifier `api` resolves to the target
// deployable's HTTP surface.  Member-access chains describe the call
// shape:
//
//   api.orders.create({...})         → POST /orders          + JSON body
//   api.orders.getById(id)           → GET  /orders/{id}
//   api.orders.<operationName>(id, body?)
//                                    → POST /orders/{id}/<op_snake>
//   api.orders.<findName>(args)      → GET  /orders/<find_snake>?...
//
// A folded `projection`'s read surface (projection.md) is reachable too, so an
// e2e body can assert the read model an operation's events fold into:
//
//   api.orderBoard.byKey(key)        → GET  /projections/<proj_snake>/{key}
//   api.orderBoard.list()            → GET  /projections/<proj_snake>
//
// Each call awaits, parses JSON, and returns the response.  An `expect`
// statement maps directly to vitest `expect(<expr>).toBe(true)`.
// ---------------------------------------------------------------------------

interface RenderCtx {
  deployable: DeployableIR;
  contexts: BoundedContextIR[];
  /** Locals introduced by `let`. */
  locals: Set<string>;
  /** `let` names that are actually referenced later in the test body.
   *  A `let` whose binding is unused emits as a bare expression so the
   *  generated test doesn't carry a dead `const` (Biome's noUnusedVariables). */
  usedLetNames: Set<string>;
  /**
   * URL path prefix for API calls.  Phoenix routes everything under
   * `scope "/api"`, so aggregate / workflow calls must be
   * prefixed with "/api".  Hono and dotnet serve at the root ("").
   */
  apiBasePath: string;
}

/**
 * Returns the URL prefix that the deployable's API is mounted under.
 * Every backend now mounts its domain routes under the shared
 * `API_BASE_PATH` (`/api`); infra endpoints stay at the root.
 */
function apiBasePath(_platform: string): string {
  return API_BASE_PATH;
}

export function renderE2EFile(
  sys: SystemIR,
  modulesByName: Map<string, SubdomainIR>,
): string | null {
  // UI tests go to a separate Playwright spec via the
  // ui-e2e-render path; the vitest api file only carries api tests.
  const apiTests = sys.e2eTests.filter((t) => t.kind === "api");
  if (apiTests.length === 0) return null;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { describe, it, expect } from "vitest";`);
  lines.push("");
  lines.push(`// Override per environment; defaults match the docker-compose ports.`);
  lines.push(`const ENDPOINTS: Record<string, string> = {`);
  for (const d of sys.deployables) {
    const slug = serviceSlug(d.name);
    lines.push(
      `  ${slug}: process.env.E2E_${slug.toUpperCase()}_BASE ?? "http://localhost:${d.port}",`,
    );
  }
  lines.push(`};`);
  lines.push("");
  // The tests render FIRST so the wire helpers can be emitted on demand: a
  // suite that uses no ordering / arithmetic / property-style collection op
  // should not carry a dead `__cmpKey`, which `test:biome-gen` would flag as an
  // unused symbol in emitted code.  Same "the feature off pays nothing" rule
  // the audit / provenance emission gates follow.
  const testLines: string[] = [];
  testLines.push(`describe(${JSON.stringify(`${sys.name} e2e`)}, () => {`);
  for (const t of apiTests) {
    const declared = sys.deployables.find((x) => x.name === t.deployableName);
    if (!declared) continue;
    // Multi-backend replay: each `test e2e "..." against <deployable>`
    // block runs against every BACKEND deployable in the system whose
    // `moduleNames` covers every aggregate the test body references
    // — not just the named one.  Catches behavioral divergences
    // (response shape, validation order, error format) the OpenAPI
    // parity check can't see (Hono returning `{ id }` while .NET
    // returned a full DTO was the original retro case).
    //
    // The declared deployable is always included; if it isn't
    // compatible with its own test body (referenced aggregates not
    // in its modules), `findAggregateBySlug` would already throw at
    // render time.  Frontend deployables are always excluded —
    // there's no API to call.
    const referenced = collectReferencedAggregateSlugs(t.statements);
    const compatible = compatibleBackends(referenced, sys.deployables, modulesByName, declared);
    for (const d of compatible) {
      const contexts = collectContextsFor(d, modulesByName);
      const ctx: RenderCtx = {
        deployable: d,
        contexts,
        locals: new Set(),
        usedLetNames: collectUsedLetNames(t.statements),
        apiBasePath: apiBasePath(d.platform),
      };
      // Suffix the test name with the backend it ran against so
      // failures in a multi-backend run point to the diverging
      // backend by name (`my test against dotnetApi`).  Single-
      // backend systems still gain the suffix — small fixture
      // churn but consistent semantics.
      testLines.push(...renderTest(t, ctx, ` against ${serviceSlug(d.name)}`).map((l) => `  ${l}`));
      testLines.push("");
    }
  }
  testLines.push(`});`);

  const body = testLines.join("\n");
  for (const h of E2E_WIRE_HELPERS) {
    if (!body.includes(`${h.name}(`)) continue;
    lines.push(h.src);
    lines.push("");
  }
  lines.push(E2E_HELPERS.trim());
  lines.push("");
  lines.push(body);
  return lines.join("\n") + "\n";
}

function collectContextsFor(
  d: DeployableIR,
  modulesByName: Map<string, SubdomainIR>,
): BoundedContextIR[] {
  const want = new Set(d.contextNames);
  const out: BoundedContextIR[] = [];
  for (const m of modulesByName.values()) {
    for (const c of m.contexts) if (want.has(c.name)) out.push(c);
  }
  return out;
}

function renderTest(t: TestE2EIR, ctx: RenderCtx, nameSuffix = ""): string[] {
  const out: string[] = [];
  out.push(`it(${JSON.stringify(t.name + nameSuffix)}, async () => {`);
  out.push(`  const base = ENDPOINTS.${serviceSlug(ctx.deployable.name)};`);
  for (const s of t.statements) {
    const rendered = renderE2EStmt(s, ctx);
    if (rendered) out.push(...rendered.split("\n").map((l) => `  ${l}`));
  }
  out.push(`});`);
  return out;
}

/** Walk every ExprIR reachable from a test statement, collecting
 *  the aggregate slugs invoked through the magic `api.<slug>.<method>(...)`
 *  shape.  Drives the multi-backend replay in `renderE2EFile` — a
 *  deployable is compatible with this test only if every collected
 *  slug's owning module is in `deployable.contextNames`. */
function collectReferencedAggregateSlugs(statements: readonly TestStmtIR[]): Set<string> {
  const slugs = new Set<string>();
  const visit = (e: ExprIR): void => {
    const call = matchApiCall(e);
    if (call) slugs.add(call.aggregateSlug);
    // Recurse regardless — the api call's args may carry further
    // api.* receivers (`api.x.op(api.y.create(...).id)` etc.).
    if (e.kind === "member") visit(e.receiver);
    else if (e.kind === "method-call") {
      visit(e.receiver);
      for (const a of e.args) visit(a);
    } else if (e.kind === "call") {
      for (const a of e.args) visit(a);
    } else if (e.kind === "lambda") {
      if (e.body) visit(e.body);
    } else if (e.kind === "new" || e.kind === "object") {
      for (const f of e.fields) visit(f.value);
    } else if (e.kind === "paren") visit(e.inner);
    else if (e.kind === "unary") visit(e.operand);
    else if (e.kind === "binary") {
      visit(e.left);
      visit(e.right);
    } else if (e.kind === "ternary") {
      visit(e.cond);
      visit(e.then);
      visit(e.otherwise);
    }
  };
  for (const s of statements) {
    if (s.kind === "expect" || s.kind === "expect-throws") visit(s.expr);
    else if (s.kind === "let") visit(s.expr);
    else if (s.kind === "expression") visit(s.expr);
    else if (s.kind === "call") for (const a of s.args) visit(a);
  }
  return slugs;
}

/** A backend platform serves a queryable HTTP API.  Consults the
 *  platform registry's `isFrontend` flag (mirrors the enrichment
 *  check in `src/ir/enrich/enrichments.ts`) so new frontend
 *  platforms (`svelte`) are excluded without an edit here.  Unknown
 *  platforms count as backends — the validator already errored. */
function isBackendPlatform(platform: string): boolean {
  try {
    return !platformFor(platform as Platform).isFrontend;
  } catch {
    return true;
  }
}

/** Resolve `<slug>` (snake_plural of an aggregate name) to the
 *  bounded-context name that owns the aggregate.  Returns undefined
 *  if no context declares an aggregate whose plural-snake name
 *  matches the slug. */
function findContextForSlug(
  slug: string,
  modulesByName: Map<string, SubdomainIR>,
): string | undefined {
  for (const m of modulesByName.values()) {
    for (const c of m.contexts) {
      for (const a of c.aggregates) {
        if (snake(plural(a.name)) === slug) return c.name;
      }
      // A folded projection's read verbs (`byKey`/`list`) reference it by its
      // own slug (`lowerFirst`/`snake` of the name), so a projection-only e2e
      // body still resolves to its owning context for backend compatibility.
      for (const p of c.projections) {
        if (lowerFirst(p.name) === slug || snake(p.name) === slug) return c.name;
      }
    }
  }
  return undefined;
}

/** Select every backend deployable whose `contextNames` covers each
 *  referenced aggregate's owning context.  The `declared` deployable
 *  (the one named in `against <name>`) is always included even when
 *  `referenced` is empty — that case is a test that does no api
 *  calls, only `expect`s, and should still run somewhere.  Output is
 *  deduplicated and stably ordered by `sys.deployables` declaration
 *  order so the emitted file is reproducible. */
function compatibleBackends(
  referenced: Set<string>,
  deployables: readonly DeployableIR[],
  modulesByName: Map<string, SubdomainIR>,
  declared: DeployableIR,
): DeployableIR[] {
  const requiredContexts = new Set<string>();
  for (const slug of referenced) {
    const ctx = findContextForSlug(slug, modulesByName);
    if (ctx) requiredContexts.add(ctx);
    // No context owns the slug → the existing `findAggregateBySlug`
    // check at render time produces a precise error.  Skip here so
    // the declared deployable still runs and surfaces it.
  }
  const out: DeployableIR[] = [];
  for (const d of deployables) {
    if (!isBackendPlatform(d.platform)) continue;
    const covers = [...requiredContexts].every((c) => d.contextNames.includes(c));
    if (covers) out.push(d);
  }
  // Always include the declared deployable, even if it didn't pass
  // the cover-check (consistent with the existing single-backend
  // behaviour where render errors there are surfaced precisely).
  if (!out.some((d) => d.name === declared.name)) out.push(declared);
  return out;
}

/** Walk every ExprIR reachable from a test statement, collecting `ref`
 *  names. The set is later consulted to decide whether a `let` binding
 *  is dead. (A let's own RHS contributes its refs; the binding name is
 *  not a ref, so unused lets fall out naturally.) */
function collectUsedLetNames(statements: readonly TestStmtIR[]): Set<string> {
  const used = new Set<string>();
  const visit = (e: ExprIR): void => {
    if (e.kind === "ref") used.add(e.name);
    else if (e.kind === "member") visit(e.receiver);
    else if (e.kind === "method-call") {
      visit(e.receiver);
      for (const a of e.args) visit(a);
    } else if (e.kind === "call") {
      for (const a of e.args) visit(a);
    } else if (e.kind === "lambda") {
      if (e.body) visit(e.body);
    } else if (e.kind === "new" || e.kind === "object") {
      for (const f of e.fields) visit(f.value);
    } else if (e.kind === "paren") visit(e.inner);
    else if (e.kind === "unary") visit(e.operand);
    else if (e.kind === "binary") {
      visit(e.left);
      visit(e.right);
    } else if (e.kind === "ternary") {
      visit(e.cond);
      visit(e.then);
      visit(e.otherwise);
    }
  };
  for (const s of statements) {
    if (s.kind === "expect" || s.kind === "expect-throws") visit(s.expr);
    else if (s.kind === "let") visit(s.expr);
    else if (s.kind === "expression") visit(s.expr);
    else if (s.kind === "call") for (const a of s.args) visit(a);
  }
  return used;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function renderE2EStmt(s: TestStmtIR, ctx: RenderCtx): string {
  if (s.kind === "expect") {
    return renderExpectStmt(s.expr, (e) => renderE2EExpr(e, ctx));
  }
  if (s.kind === "expect-throws") {
    // `expect(call).toThrow(N)` — the optional integer status (carried on the
    // IR from the lowering) pins the HTTP status the rejection must carry.
    // The `__post`/`__get` helpers throw `Error("… → <status> <text>: …")`, so
    // a `/→ N\b/` regex matcher pins the status without coupling to the
    // backend-specific status text or body.  This is the behavioral
    // complement to the static OpenAPI `errorResponseDiffs` parity gate:
    // because the block replays against every backend serving the module, it
    // asserts they all reject with the *same* status.
    const matcher = s.status != null ? `/→ ${s.status}\\b/` : "";
    return `await expect(async () => { ${renderE2EExpr(s.expr, ctx)}; }).rejects.toThrow(${matcher});`;
  }
  if (s.kind === "let") {
    ctx.locals.add(s.name);
    // Drop the `const <name> =` binding when nothing in the test body
    // references it — `Sales.Order.create({...})` as a bare seed line
    // shouldn't leave a dead local in the emitted test.
    if (!ctx.usedLetNames.has(s.name)) {
      return `${renderE2EExpr(s.expr, ctx)};`;
    }
    return `const ${s.name} = ${renderE2EExpr(s.expr, ctx)};`;
  }
  if (s.kind === "expression") {
    return `${renderE2EExpr(s.expr, ctx)};`;
  }
  if (s.kind === "call") {
    return `${renderE2EExpr({ kind: "call", callKind: "free", name: s.name, args: s.args }, ctx)};`;
  }
  // A test statement we can't lower must fail generation loudly: silently
  // emitting a comment would drop the assertion and ship a green-but-empty
  // test.  Only expect / expect-throws / let / expression / call are valid in
  // an e2e api test body.
  throw new Error(
    `e2e: unsupported statement '${s.kind}' in an api test body — ` +
      `only expect, expect-throws, let, expression, and call are supported.`,
  );
}

// ---------------------------------------------------------------------------
// Expressions — most are inert, but any method-call rooted at `api`
// becomes a typed fetch + await + JSON parse expression.
// ---------------------------------------------------------------------------

function renderE2EExpr(e: ExprIR, ctx: RenderCtx): string {
  const apiCall = matchApiCall(e);
  if (apiCall) return renderApiCall(apiCall, ctx);

  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "ref":
      return e.name;
    case "this":
      return "this";
    case "id":
      return "this._id";
    case "paren":
      return `(${renderE2EExpr(e.inner, ctx)})`;
    case "unary":
      return `${e.op}${renderE2EExpr(e.operand, ctx)}`;
    case "binary": {
      const op = e.op === "==" ? "===" : e.op === "!=" ? "!==" : e.op;
      return `${renderE2EExpr(e.left, ctx)} ${op} ${renderE2EExpr(e.right, ctx)}`;
    }
    case "ternary":
      return `${renderE2EExpr(e.cond, ctx)} ? ${renderE2EExpr(e.then, ctx)} : ${renderE2EExpr(e.otherwise, ctx)}`;
    case "lambda":
      // Lambda body is now optional (block-body lambdas were
      // added for page event handlers).  E2E tests don't currently
      // emit block-body lambdas — only the existing single-expression
      // form — so assert and render.  If a future change introduces a
      // block lambda in test bodies, this branch needs the `block`
      // alternative.
      if (e.body) return `(${e.param}) => ${renderE2EExpr(e.body, ctx)}`;
      return `(${e.param}) => { /* block-body lambdas not supported in e2e tests */ }`;
    case "member": {
      const recv = renderE2EExpr(e.receiver, ctx);
      // Property-style collection ops (`lines.count`, `lines.distinct`) lower to
      // a MEMBER node, which carries no `isCollectionOp` marker — and inside a
      // test body every expression is placeholder-typed, so `receiverType` is
      // no help either.  `x.count` is therefore ambiguous between the op and a
      // field named `count`, and only the runtime value can tell them apart:
      // hence the `__count` / `__distinct` helpers rather than a guess here.
      if (e.member === "count") return `__count(${recv})`;
      if (e.member === "distinct") return `__distinct(${recv})`;
      return `${recv}.${e.member}`;
    }
    case "method-call": {
      const recv = renderE2EExpr(e.receiver, ctx);
      const args = e.args.map((a) => renderE2EExpr(a, ctx));
      if (e.isCollectionOp) {
        const op = E2E_COLLECTION_RENDERERS[e.member];
        // Guarded rather than asserted: `isCollectionOp` is set by lowering
        // against the same catalogue this table is pinned to, so a miss is a
        // catalogue/table drift the completeness test catches at build time.
        if (op) return op(`(${recv})`, args, e);
      }
      return `${recv}.${e.member}(${args.join(", ")})`;
    }
    case "call":
      return `${e.name}(${e.args.map((a) => renderE2EExpr(a, ctx)).join(", ")})`;
    case "new":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderE2EExpr(f.value, ctx)}`).join(", ")} })`;
    case "object":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderE2EExpr(f.value, ctx)}`).join(", ")} })`;
    case "convert": {
      // Same TS coercion idioms as the domain renderer
      // (`generator/typescript/render-expr.ts`'s renderTsConvert).
      // E2E test bodies that build payloads — `applyDiscount({ amount:
      // money("50.00") })` etc. — get the same per-(from, target)
      // emission so the request shape matches what the route's Zod
      // schema parses.
      const v = renderE2EExpr(e.value, ctx);
      if (e.target === "string") {
        if (e.from === "money") return `${v}.toString()`;
        return `String(${v})`;
      }
      if (e.target === "long" || e.target === "decimal") {
        if (e.from === "money") return `${v}.toNumber()`;
        return v;
      }
      if (e.target === "money") {
        // NOT `new Decimal(...)`: the emitted suite imports only vitest, so a
        // decimal.js reference is a ReferenceError at run time rather than a
        // wrong value.  Money crosses the wire as a JSON scalar, so a widening
        // conversion into it is the identity here — the comparison ops numify
        // through `__num`/`__cmpKey` where ordering or arithmetic needs it.
        return v;
      }
      return v;
    }
    case "duration": {
      // A5 temporal — same absolute-ms representation as the TS domain
      // renderer (every unit has a fixed millisecond width).
      const amt = renderE2EExpr(e.amount, ctx);
      return `((${amt}) * ${DURATION_UNIT_MS[e.unit]})`;
    }
    case "i18nFormat":
      // Transparent i18n wrapper (M-T1.11) — render the wrapped operand.
      return renderE2EExpr(e.inner, ctx);
    case "match": {
      // Lower a match expression to a chained ternary.  E2E
      // test bodies are unlikely to use match in v0, but the IR can
      // carry it (e.g. a `derived` body referenced from a test
      // assertion via `read.label`).  Falling back to a chain keeps
      // the rendering total.
      const arms = [...e.arms].reverse();
      const tail = e.otherwise ? renderE2EExpr(e.otherwise, ctx) : "undefined";
      let out = tail;
      for (const arm of arms) {
        out = `(${renderE2EExpr(arm.cond, ctx)} ? ${renderE2EExpr(arm.value, ctx)} : ${out})`;
      }
      return out;
    }
    case "list":
      // List literals are walker-config sugar (Grid cols, etc.).  E2E
      // tests don't currently surface them, but keep the renderer total
      // with a TS array literal so unexpected uses still compile.
      return `[${e.elements.map((el) => renderE2EExpr(el, ctx)).join(", ")}]`;
    case "action-ref":
      // Named-action references are a UI-handler-arg form — never reached by
      // the e2e (api) renderer; keep the switch total with a placeholder.
      return `/* action:${e.actionName} */`;
    case "authz-filter":
      // Authorization/tenancy query-filter sentinel (M-T9.9) — a repository
      // filter node, never reached by the e2e (api) renderer; keep the switch
      // total with a placeholder.
      return `/* authz-filter:${e.filter.kind} */`;
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date().toISOString()";
  if (lit === "null") return "null";
  return value;
}

// ---------------------------------------------------------------------------
// Collection ops over WIRE values
//
// A `test e2e` body operates on parsed JSON — the response the backend actually
// returned — not on domain objects.  That is the whole difference between this
// table and the domain one (`TS_COLLECTION_RENDERERS`), and it is why the two
// cannot simply be shared:
//
//   - The domain represents `money` as a decimal.js `Decimal`, so its `sum`
//     folds with `.plus` from a `new Decimal(0)` seed and its `sortBy` compares
//     with `.lt`/`.gt`.  On the wire `money` is a fixed-scale STRING, and the
//     emitted suite imports nothing but vitest — a `Decimal` reference here is
//     a `ReferenceError`, not a wrong answer.
//   - Wire numbers may arrive as strings, so the ordering and arithmetic ops go
//     through `__cmpKey` / `__num` (see their definitions above).
//
// Everything else is a plain JS array operation and matches the domain table
// arm-for-arm.  `test/system/e2e-collection-ops.test.ts` pins that every
// catalogue op has an entry here, so adding an op to the catalogue forces a
// wire-vs-domain decision rather than silently falling through to a verbatim
// `.op()` call — which is what happened before: `trail.first()` emitted
// `trail.first()`, and arrays have no `.first`, so the assertion died with a
// TypeError at runtime instead of failing to compile.
// ---------------------------------------------------------------------------

type E2ECollectionRenderer = (
  recv: string,
  args: string[],
  e?: Extract<ExprIR, { kind: "method-call" }>,
) => string;

export const E2E_COLLECTION_RENDERERS: Record<string, E2ECollectionRenderer> = {
  count: (recv) => `${recv}.length`,
  // Wire numbers can be strings (money/decimal); fold through `__num`.
  sum: (recv, args) =>
    args.length === 1
      ? `${recv}.reduce((__acc, __x) => __acc + __num((${args[0]})(__x)), 0)`
      : `${recv}.reduce((__acc, __x) => __acc + __num(__x), 0)`,
  avg: (recv, args) =>
    args.length === 1
      ? `(${recv}.length ? ${recv}.reduce((__acc, __x) => __acc + __num((${args[0]})(__x)), 0) / ${recv}.length : null)`
      : `(${recv}.length ? ${recv}.reduce((__acc, __x) => __acc + __num(__x), 0) / ${recv}.length : null)`,
  all: (recv, args) => `${recv}.every(${args[0] ?? "() => true"})`,
  any: (recv, args) => `${recv}.some(${args[0] ?? "() => true"})`,
  // Value equality on the wire is plain `===`: a wire value is a JSON scalar,
  // so there is no decimal.js reference-identity trap for money to dodge here.
  contains: (recv, args) => `${recv}.includes(${args[0] ?? "undefined"})`,
  where: (recv, args) => `${recv}.filter(${args[0] ?? "() => true"})`,
  first: (recv) => `${recv}[0]`,
  firstOrNull: (recv) => `(${recv}[0] ?? null)`,
  map: (recv, args) => `${recv}.map(${args[0]})`,
  sortBy: (recv, args, e) => {
    const desc = e ? isDescendingSort(e) : false;
    const cmp = desc ? "kb < ka ? -1 : kb > ka ? 1 : 0" : "ka < kb ? -1 : ka > kb ? 1 : 0";
    return `[...${recv}].sort((__a, __b) => { const ka = __cmpKey((${args[0]})(__a)), kb = __cmpKey((${args[0]})(__b)); return ${cmp}; })`;
  },
  distinct: (recv) => `[...new Set(${recv})]`,
  take: (recv, args) => `${recv}.slice(0, ${args[0]})`,
  skip: (recv, args) => `${recv}.slice(${args[0]})`,
  join: (recv, args) => `${recv}.join(${args[0]})`,
  // min/max return the PROJECTED value, empty → null.  The reduce keeps the
  // ORIGINAL projected value and compares through `__cmpKey`, so a money string
  // orders numerically but the answer is still the wire value the caller asserts
  // against.
  min: (recv, args) =>
    `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__cmpKey(__b) < __cmpKey(__a) ? __b : __a)) : null)`,
  max: (recv, args) =>
    `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__cmpKey(__b) > __cmpKey(__a) ? __b : __a)) : null)`,
};

// ---------------------------------------------------------------------------
// API call resolution
// ---------------------------------------------------------------------------

interface ApiCallShape {
  aggregateSlug: string; // e.g. "orders"
  method: string; // e.g. "create" / "getById" / "addLine" / "byCustomer"
  args: ExprIR[];
}

/**
 * If `e` is a method-call rooted at the `api` identifier
 * (`api.<segment>.<method>(...)`), returns the resolved shape.
 * Otherwise returns null.
 */
function matchApiCall(e: ExprIR): ApiCallShape | null {
  if (e.kind !== "method-call") return null;
  if (e.receiver.kind !== "member") return null;
  const r = e.receiver;
  if (r.receiver.kind !== "ref" || r.receiver.name !== "api") return null;
  return {
    aggregateSlug: r.member,
    method: e.member,
    args: e.args,
  };
}

function renderApiCall(call: ApiCallShape, ctx: RenderCtx): string {
  // A folded projection's read surface (projection.md): `api.<proj>.byKey(k)` /
  // `.list()` read `GET /projections/<snake>[/{key}]`.  Resolved before the
  // aggregate lookup — the read verbs (`byKey`/`list`) are projection-only, so a
  // projection whose slug shadowed an aggregate would still route reads here.
  const proj = findProjectionBySlug(call.aggregateSlug, ctx.contexts);
  if (proj && (call.method === "byKey" || call.method === "list")) {
    return renderProjectionRead(proj, call, ctx);
  }

  const agg = findAggregateBySlug(call.aggregateSlug, ctx.contexts);
  if (!agg) {
    const known = ctx.contexts
      .flatMap((c) => c.aggregates.map((a) => snake(plural(a.name))))
      .sort()
      .join(", ");
    throw new Error(
      `e2e: unknown aggregate 'api.${call.aggregateSlug}' on this deployable. ` +
        `Available aggregates: ${known || "(none)"}.`,
    );
  }
  const slug = snake(plural(agg.name));
  const args = call.args;

  const prefix = ctx.apiBasePath;
  if (call.method === "create") {
    const body = args[0] ? renderE2EExpr(args[0], ctx) : "{}";
    return `await __post(\`\${base}${prefix}/${slug}\`, ${body})`;
  }
  if (call.method === "getById") {
    if (args.length < 1) {
      throw new Error(`e2e: api.${call.aggregateSlug}.getById(id) requires an id argument`);
    }
    const idExpr = renderIdArg(args[0], ctx);
    return `await __get(\`\${base}${prefix}/${slug}/\${${idExpr}}\`)`;
  }
  // Entity history (docs/audit.md) — the derived read over `audit_records`.
  // Recognised like `getById` rather than through `findRepoQuery`, because the
  // history find deliberately sits beside `finds` (see `RepositoryIR.historyFind`)
  // and its path carries the id as a segment, not a query param.
  if (call.method === "history") {
    if (args.length < 1) {
      throw new Error(`e2e: api.${call.aggregateSlug}.history(id) requires an id argument`);
    }
    const idExpr = renderIdArg(args[0], ctx);
    return `await __get(\`\${base}${prefix}/${slug}/\${${idExpr}}/history\`)`;
  }

  const op = agg.operations.find((o) => o.visibility === "public" && o.name === call.method);
  if (op) return renderOperationCall(op, slug, args, ctx);

  const find = findRepoQuery(call.method, agg, ctx);
  if (find) return renderFindCall(find, slug, args, ctx);

  const ops = agg.operations.filter((o) => o.visibility === "public").map((o) => o.name);
  const finds = (
    ctx.contexts.flatMap((c) => c.repositories).find((r) => r.aggregateName === agg.name)?.finds ??
    []
  ).map((f) => f.name);
  const historyMethod = ctx.contexts
    .flatMap((c) => c.repositories)
    .find((r) => r.aggregateName === agg.name)?.historyFind
    ? ["history"]
    : [];
  const known = ["create", "getById", ...historyMethod, ...ops, ...finds].join(", ");
  throw new Error(
    `e2e: unknown method 'api.${call.aggregateSlug}.${call.method}'. ` + `Available: ${known}.`,
  );
}

function renderOperationCall(
  op: OperationIR,
  slug: string,
  args: ExprIR[],
  ctx: RenderCtx,
): string {
  if (args.length < 1) {
    throw new Error(`e2e: api.${slug}.${op.name}(id, body?) requires an id argument`);
  }
  const idExpr = renderIdArg(args[0], ctx);
  const body = args.length >= 2 ? renderE2EExpr(args[1], ctx) : "{}";
  const opSnake = snake(op.name);
  const prefix = ctx.apiBasePath;
  return `await __post(\`\${base}${prefix}/${slug}/\${${idExpr}}/${opSnake}\`, ${body})`;
}

function renderFindCall(find: FindIR, slug: string, args: ExprIR[], ctx: RenderCtx): string {
  const findSnake = snake(find.name);
  const queryArg = args[0] ? renderE2EExpr(args[0], ctx) : "{}";
  const prefix = ctx.apiBasePath;
  return `await __getQuery(\`\${base}${prefix}/${slug}/${findSnake}\`, ${queryArg})`;
}

function renderIdArg(arg: ExprIR, ctx: RenderCtx): string {
  // If the argument is a let-bound name, the user probably bound the
  // result of `api.x.create(...)` which returns `{ id }` — append `.id`.
  const rendered = renderE2EExpr(arg, ctx);
  if (arg.kind === "ref" && ctx.locals.has(arg.name)) {
    return `${rendered}.id`;
  }
  return rendered;
}

/** Render a folded-projection read (`api.<proj>.byKey(k)` / `.list()`).  The
 *  route is `GET /projections/<snake(name)>[/{key}]` on every backend (the
 *  read-model row surface projection.md emits), so one assertion runs against
 *  the whole behavioural matrix. */
function renderProjectionRead(proj: ProjectionIR, call: ApiCallShape, ctx: RenderCtx): string {
  const slug = snake(proj.name);
  const prefix = ctx.apiBasePath;
  if (call.method === "list") {
    return `await __get(\`\${base}${prefix}/projections/${slug}\`)`;
  }
  // byKey(key) — the correlation column the fold routed to.
  if (call.args.length < 1) {
    throw new Error(`e2e: api.${call.aggregateSlug}.byKey(key) requires a key argument`);
  }
  const keyExpr = renderIdArg(call.args[0], ctx);
  return `await __get(\`\${base}${prefix}/projections/${slug}/\${${keyExpr}}\`)`;
}

function findProjectionBySlug(
  slug: string,
  contexts: BoundedContextIR[],
): ProjectionIR | undefined {
  for (const c of contexts) {
    for (const p of c.projections) {
      if (lowerFirst(p.name) === slug || snake(p.name) === slug) return p;
    }
  }
  return undefined;
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

function findRepoQuery(name: string, agg: AggregateIR, ctx: RenderCtx): FindIR | undefined {
  for (const c of ctx.contexts) {
    for (const r of c.repositories) {
      if (r.aggregateName !== agg.name) continue;
      for (const f of r.finds) if (f.name === name) return f;
    }
  }
  return undefined;
}

function serviceSlug(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Comparison key for a WIRE value.  Emitted into every e2e suite; consumed by
 *  the ordering collection ops (`sortBy` / `min` / `max`).
 *
 *  The wire is JSON, so a value that is numeric in the domain may arrive as a
 *  STRING: `money` serializes at a fixed scale (`"12.5000"`), and a `decimal`
 *  can too.  Comparing those with `<` is lexicographic, which orders
 *  `"10.0000"` before `"9.0000"` — silently wrong, and wrong in a way a passing
 *  test hides.  Numifying them first fixes the ordering.
 *
 *  Non-numeric strings pass through unchanged, which is what ISO-8601 timestamps
 *  need: they are lexicographically ordered by construction, so `<` is already
 *  correct for them and coercing would produce NaN. */
const E2E_WIRE_HELPERS: ReadonlyArray<{ name: string; src: string }> = [
  {
    name: "__cmpKey",
    src: `// Ordering key for a wire value — see \`sortBy\`/\`min\`/\`max\` below.  Money and
// decimal cross the wire as fixed-scale STRINGS, where \`<\` compares
// lexicographically ("10.0000" < "9.0000"); numify those.  ISO timestamps and
// plain strings are already correctly ordered by \`<\`, and Number() would make
// them NaN, so they pass through.
function __cmpKey(v: unknown): unknown {
  if (typeof v !== "string" || v === "") return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}`,
  },
  {
    name: "__num",
    src: `// Numeric value of a wire number — same string-crossing concern as \`__cmpKey\`,
// for the arithmetic folds (\`sum\`/\`avg\`).
function __num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}`,
  },
  {
    name: "__count",
    src: `// Property-style collection ops (\`items.count\`, \`items.distinct\`) are written
// without parens, so they lower to a MEMBER node — which carries no
// collection-op marker, and inside a test body the receiver is an untyped wire
// value.  \`x.count\` is therefore genuinely ambiguous: the collection op, or a
// field literally named \`count\`.  The type that disambiguates exists at RUN
// time, so decide there rather than guessing at emit time.
function __count(v: unknown): unknown {
  return Array.isArray(v) ? v.length : (v as { count?: unknown })?.count;
}`,
  },
  {
    name: "__distinct",
    src: `// Property-style \`distinct\` — same runtime dispatch as \`__count\`.
function __distinct(v: unknown): unknown {
  return Array.isArray(v) ? [...new Set(v)] : (v as { distinct?: unknown })?.distinct;
}`,
  },
];

const E2E_HELPERS = `
// When the target system requires auth, every request must carry a principal
// or the backend rejects it 401 before the assertion's real path
// (create/validation/not-found) is ever reached.  The harness stays
// provider-agnostic and supports both auth modes:
//   • OIDC systems — forward a JWT from \`E2E_BEARER_TOKEN\` (the runner mints it).
//   • dev-stub systems (no \`auth {}\` block) — inject \`x-loom-dev-claims\`, a
//     base64-encoded JSON of principal claims (keyed by declared \`user\` field,
//     e.g. \`{"tenantId":"acme","role":"agent"}\`), which every backend's dev-stub
//     verifier merges over its built-in identity.  This is the exact mechanism
//     the tenancy-e2e isolation harness uses.  \`E2E_DEV_CLAIMS\` is the raw JSON;
//     an unset/empty value sends no header (auth-less systems ignore it anyway).
function __authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.E2E_BEARER_TOKEN;
  if (token) headers.authorization = \`Bearer \${token}\`;
  const claims = process.env.E2E_DEV_CLAIMS;
  if (claims) headers["x-loom-dev-claims"] = Buffer.from(claims).toString("base64");
  return headers;
}

async function __post(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...__authHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  // Check the status BEFORE parsing: a 404 (or any error) often carries a
  // non-JSON body (e.g. Hono's "404 Not Found"), and parsing it first would
  // mask the real status behind an opaque "JSON Parse error".
  if (!r.ok) throw new Error(\`POST \${url} → \${r.status} \${r.statusText}\${text ? ": " + text : ""}\`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(\`POST \${url} → \${r.status}: expected JSON, got \${JSON.stringify(text.slice(0, 200))}\`);
  }
}

async function __get(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: __authHeaders() });
  const text = await r.text();
  if (!r.ok) throw new Error(\`GET \${url} → \${r.status} \${r.statusText}\${text ? ": " + text : ""}\`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(\`GET \${url} → \${r.status}: expected JSON, got \${JSON.stringify(text.slice(0, 200))}\`);
  }
}

async function __getQuery(url: string, params: Record<string, unknown>): Promise<unknown> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) qs.set(k, String(v));
  }
  const full = qs.toString().length > 0 ? \`\${url}?\${qs}\` : url;
  return __get(full);
}
`;
