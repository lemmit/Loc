import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  FindIR,
  OperationIR,
  Platform,
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
   * `scope "/api"`, so aggregate / workflow / view calls must be
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
  lines.push(E2E_HELPERS.trim());
  lines.push("");
  lines.push(`describe(${JSON.stringify(`${sys.name} e2e`)}, () => {`);
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
      lines.push(...renderTest(t, ctx, ` against ${serviceSlug(d.name)}`).map((l) => `  ${l}`));
      lines.push("");
    }
  }
  lines.push(`});`);
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
    case "member":
      return `${renderE2EExpr(e.receiver, ctx)}.${e.member}`;
    case "method-call": {
      const recv = renderE2EExpr(e.receiver, ctx);
      const args = e.args.map((a) => renderE2EExpr(a, ctx));
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
        if (e.from === "money") return v;
        return `new Decimal(${v})`;
      }
      return v;
    }
    case "duration": {
      // A5 temporal — same absolute-ms representation as the TS domain
      // renderer (every unit has a fixed millisecond width).
      const amt = renderE2EExpr(e.amount, ctx);
      return `((${amt}) * ${DURATION_UNIT_MS[e.unit]})`;
    }
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
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date().toISOString()";
  if (lit === "null") return "null";
  return value;
}

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
  // Context-level views are served under `${apiBasePath}/views/<view_snake>` as
  // parameterless GET routes (see the `viewsRoutes` emitter).  `api.views.<name>()`
  // reads one — matched by `lowerFirst` (the synthesised find name) or `snake`
  // (the route path), mirroring the validator's `views` branch in test-checks.ts.
  if (call.aggregateSlug === "views") {
    const view = ctx.contexts
      .flatMap((c) => c.views)
      .find((v) => lowerFirst(v.name) === call.method || snake(v.name) === call.method);
    if (!view) {
      const known = ctx.contexts
        .flatMap((c) => c.views.map((v) => lowerFirst(v.name)))
        .sort()
        .join(", ");
      throw new Error(
        `e2e: unknown view 'api.views.${call.method}' on this deployable. ` +
          `Available views: ${known || "(none)"}.`,
      );
    }
    return `await __get(\`\${base}${ctx.apiBasePath}/views/${snake(view.name)}\`)`;
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
  const op = agg.operations.find((o) => o.visibility === "public" && o.name === call.method);
  if (op) return renderOperationCall(op, slug, args, ctx);

  const find = findRepoQuery(call.method, agg, ctx);
  if (find) return renderFindCall(find, slug, args, ctx);

  const ops = agg.operations.filter((o) => o.visibility === "public").map((o) => o.name);
  const finds = (
    ctx.contexts.flatMap((c) => c.repositories).find((r) => r.aggregateName === agg.name)?.finds ??
    []
  ).map((f) => f.name);
  const known = ["create", "getById", ...ops, ...finds].join(", ");
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
