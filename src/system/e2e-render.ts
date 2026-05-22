import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  FindIR,
  ModuleIR,
  OperationIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
} from "../ir/loom-ir.js";
import { camel, plural, snake } from "../util/naming.js";
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
  /**
   * URL path prefix for API calls.  Phoenix routes everything under
   * `scope "/api"`, so aggregate / workflow / view calls must be
   * prefixed with "/api".  Hono and dotnet serve at the root ("").
   */
  apiBasePath: string;
}

/**
 * Returns the URL prefix that the deployable's API is mounted under.
 * Phoenix LiveView serves its HTTP API inside `scope "/api", …`, so
 * every aggregate, workflow, and view route is reachable at
 * `/api/<route>`.  Hono and dotnet serve at the root, so no prefix.
 */
function apiBasePath(platform: string): string {
  return platform === "phoenixLiveView" ? "/api" : "";
}

export function renderE2EFile(
  sys: SystemIR,
  modulesByName: Map<string, ModuleIR>,
): string | null {
  // UI tests go to a separate Playwright spec via the
  // ui-e2e-render path; the vitest api file only carries api tests.
  const apiTests = sys.e2eTests.filter((t) => t.kind === "api");
  if (apiTests.length === 0) return null;
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { describe, it, expect } from "vitest";`);
  lines.push("");
  lines.push(
    `// Override per environment; defaults match the docker-compose ports.`,
  );
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
    const d = sys.deployables.find((x) => x.name === t.deployableName);
    if (!d) continue;
    const contexts = collectContextsFor(d, modulesByName);
    const ctx: RenderCtx = {
      deployable: d,
      contexts,
      locals: new Set(),
      apiBasePath: apiBasePath(d.platform),
    };
    lines.push(...renderTest(t, ctx).map((l) => `  ${l}`));
    lines.push("");
  }
  lines.push(`});`);
  return lines.join("\n") + "\n";
}

function collectContextsFor(
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

function renderTest(t: TestE2EIR, ctx: RenderCtx): string[] {
  const out: string[] = [];
  out.push(`it(${JSON.stringify(t.name)}, async () => {`);
  out.push(`  const base = ENDPOINTS["${serviceSlug(ctx.deployable.name)}"];`);
  for (const s of t.statements) {
    const rendered = renderE2EStmt(s, ctx);
    if (rendered) out.push(...rendered.split("\n").map((l) => `  ${l}`));
  }
  out.push(`});`);
  return out;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function renderE2EStmt(s: TestStmtIR, ctx: RenderCtx): string {
  if (s.kind === "expect") {
    return renderExpectStmt(s.expr, (e) => renderE2EExpr(e, ctx));
  }
  if (s.kind === "expect-throws") {
    return `await expect(async () => { ${renderE2EExpr(s.expr, ctx)}; }).rejects.toThrow();`;
  }
  if (s.kind === "let") {
    ctx.locals.add(s.name);
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
      // Slice 2: lambda body is now optional (block-body lambdas were
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
    case "match": {
      // Slice 2: lower a match expression to a chained ternary.  E2E
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
      throw new Error(
        `e2e: api.${call.aggregateSlug}.getById(id) requires an id argument`,
      );
    }
    const idExpr = renderIdArg(args[0], ctx);
    return `await __get(\`\${base}${prefix}/${slug}/\${${idExpr}}\`)`;
  }
  const op = agg.operations.find(
    (o) => o.visibility === "public" && o.name === call.method,
  );
  if (op) return renderOperationCall(op, slug, args, ctx);

  const find = findRepoQuery(call.method, agg, ctx);
  if (find) return renderFindCall(find, slug, args, ctx);

  const ops = agg.operations
    .filter((o) => o.visibility === "public")
    .map((o) => o.name);
  const finds = (
    ctx.contexts
      .flatMap((c) => c.repositories)
      .find((r) => r.aggregateName === agg.name)?.finds ?? []
  ).map((f) => f.name);
  const known = ["create", "getById", ...ops, ...finds].join(", ");
  throw new Error(
    `e2e: unknown method 'api.${call.aggregateSlug}.${call.method}'. ` +
      `Available: ${known}.`,
  );
}

function renderOperationCall(
  op: OperationIR,
  slug: string,
  args: ExprIR[],
  ctx: RenderCtx,
): string {
  if (args.length < 1) {
    throw new Error(
      `e2e: api.${slug}.${op.name}(id, body?) requires an id argument`,
    );
  }
  const idExpr = renderIdArg(args[0], ctx);
  const body = args.length >= 2 ? renderE2EExpr(args[1], ctx) : "{}";
  const opSnake = snake(op.name);
  const prefix = ctx.apiBasePath;
  return `await __post(\`\${base}${prefix}/${slug}/\${${idExpr}}/${opSnake}\`, ${body})`;
}

function renderFindCall(
  find: FindIR,
  slug: string,
  args: ExprIR[],
  ctx: RenderCtx,
): string {
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

function findRepoQuery(
  name: string,
  agg: AggregateIR,
  ctx: RenderCtx,
): FindIR | undefined {
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
async function __post(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

async function __get(url: string): Promise<any> {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(\`GET \${url} → \${r.status} \${r.statusText}\${text ? ": " + text : ""}\`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(\`GET \${url} → \${r.status}: expected JSON, got \${JSON.stringify(text.slice(0, 200))}\`);
  }
}

async function __getQuery(url: string, params: Record<string, unknown>): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) qs.set(k, String(v));
  }
  const full = qs.toString().length > 0 ? \`\${url}?\${qs}\` : url;
  return __get(full);
}
`;
