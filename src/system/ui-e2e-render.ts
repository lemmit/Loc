import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  ModuleIR,
  OperationIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
} from "../ir/loom-ir.js";
import { camel, plural, snake } from "../util/naming.js";

// ---------------------------------------------------------------------------
// UI e2e renderer.
//
// Lowers a system's `test e2e ui "..." against <react-deployable> { … }`
// blocks to a Playwright spec at
// `<react-deployable>/e2e/<systemName>.ui.spec.ts`, driving the
// auto-generated page objects under `<react-deployable>/e2e/pages/`.
//
// The DSL surface is intentionally identical to the api e2e renderer
// (same `ui.<aggregate>.<verb>(...)` shape) — only the lowering
// differs.  Each call routes through a page object instead of a
// fetch:
//
//   ui.orders.create({...})
//     → ListPage.goto → click "create" → fill → submit
//   ui.orders.<op>(target, body?)
//     → DetailPage.goto(target.id) → call op (opens modal, fills,
//        submits)
//   ui.orders.getById(target)
//     → DetailPage.goto(target.id) → eagerly read every primitive /
//        VO field via `field("name")` / `field("vo.sub")`, plus a
//        `lines.length`-style accessor per contained collection.
// ---------------------------------------------------------------------------

interface RenderCtx {
  deployable: DeployableIR;
  contexts: BoundedContextIR[];
  /** Locals introduced by `let`. */
  locals: Set<string>;
}

export function renderUIE2EFile(
  sys: SystemIR,
  modulesByName: Map<string, ModuleIR>,
  reactDeployable: DeployableIR,
): string | null {
  // Only emit a spec for the UI tests that target THIS frontend.
  const uiTests = sys.e2eTests.filter(
    (t) => t.kind === "ui" && t.deployableName === reactDeployable.name,
  );
  if (uiTests.length === 0) return null;
  // The frontend's targeted backend determines which aggregates are
  // reachable — `targets:` already populated `moduleNames` during
  // lowering, so this is the same set the api hooks know about.
  const contexts = collectContextsFor(reactDeployable, modulesByName);
  // Page-object imports per aggregate referenced anywhere in the
  // bodies.
  const aggregates = collectReferencedAggregates(uiTests, contexts);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { test, expect } from "@playwright/test";`);
  for (const a of aggregates) {
    const cap = upper(a.name);
    lines.push(
      `import { ${cap}ListPage, ${cap}DetailPage } from "./pages/${camel(a.name)}.js";`,
    );
  }
  lines.push("");
  for (const t of uiTests) {
    const ctx: RenderCtx = {
      deployable: reactDeployable,
      contexts,
      locals: new Set(),
    };
    lines.push(...renderTest(t, ctx));
    lines.push("");
  }
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

function collectReferencedAggregates(
  tests: TestE2EIR[],
  contexts: BoundedContextIR[],
): AggregateIR[] {
  const seen = new Set<string>();
  const out: AggregateIR[] = [];
  for (const t of tests) {
    for (const s of t.statements) walkStmt(s);
  }
  return out;

  function walkStmt(s: TestStmtIR): void {
    if (s.kind === "expect" || s.kind === "expect-throws" || s.kind === "let" || s.kind === "expression") {
      walkExpr(s.expr);
    }
  }
  function walkExpr(e: ExprIR | undefined): void {
    if (!e) return;
    const call = matchUiCall(e);
    if (call) {
      const agg = findAggregateBySlug(call.aggregateSlug, contexts);
      if (agg && !seen.has(agg.name)) {
        seen.add(agg.name);
        out.push(agg);
      }
    }
    if (e.kind === "method-call") {
      walkExpr(e.receiver);
      for (const a of e.args) walkExpr(a);
    }
    if (e.kind === "member") walkExpr(e.receiver);
    if (e.kind === "binary") {
      walkExpr(e.left);
      walkExpr(e.right);
    }
    if (e.kind === "ternary") {
      walkExpr(e.cond);
      walkExpr(e.then);
      walkExpr(e.otherwise);
    }
    if (e.kind === "unary") walkExpr(e.operand);
    if (e.kind === "paren") walkExpr(e.inner);
    if (e.kind === "call") for (const a of e.args) walkExpr(a);
    if (e.kind === "new" || e.kind === "object") {
      for (const f of e.fields) walkExpr(f.value);
    }
  }
}

function renderTest(t: TestE2EIR, ctx: RenderCtx): string[] {
  const out: string[] = [];
  out.push(`test(${JSON.stringify(t.name)}, async ({ page }) => {`);
  for (const s of t.statements) {
    const rendered = renderUIStmt(s, ctx);
    if (rendered) out.push(...rendered.split("\n").map((l) => `  ${l}`));
  }
  out.push(`});`);
  return out;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

function renderUIStmt(s: TestStmtIR, ctx: RenderCtx): string {
  if (s.kind === "expect") {
    return `expect(${renderUIExpr(s.expr, ctx)}).toBe(true);`;
  }
  if (s.kind === "expect-throws") {
    return `await expect(async () => { ${renderUIExpr(s.expr, ctx)}; }).rejects.toThrow();`;
  }
  if (s.kind === "let") {
    ctx.locals.add(s.name);
    return `const ${s.name} = ${renderUIExpr(s.expr, ctx)};`;
  }
  if (s.kind === "expression") {
    return `${renderUIExpr(s.expr, ctx)};`;
  }
  if (s.kind === "call") {
    return `${renderUIExpr({ kind: "call", callKind: "free", name: s.name, args: s.args }, ctx)};`;
  }
  return `// unsupported in ui e2e: ${s.kind}`;
}

// ---------------------------------------------------------------------------
// Expressions — most are inert; method-calls rooted at `ui` route
// through the page-object library.
// ---------------------------------------------------------------------------

function renderUIExpr(e: ExprIR, ctx: RenderCtx): string {
  const uiCall = matchUiCall(e);
  if (uiCall) return renderUiCall(uiCall, ctx);

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
      return `(${renderUIExpr(e.inner, ctx)})`;
    case "unary":
      return `${e.op}${renderUIExpr(e.operand, ctx)}`;
    case "binary": {
      const op = e.op === "==" ? "===" : e.op === "!=" ? "!==" : e.op;
      return `${renderUIExpr(e.left, ctx)} ${op} ${renderUIExpr(e.right, ctx)}`;
    }
    case "ternary":
      return `${renderUIExpr(e.cond, ctx)} ? ${renderUIExpr(e.then, ctx)} : ${renderUIExpr(e.otherwise, ctx)}`;
    case "lambda":
      return `(${e.param}) => ${renderUIExpr(e.body, ctx)}`;
    case "member":
      return `${renderUIExpr(e.receiver, ctx)}.${e.member}`;
    case "method-call": {
      const recv = renderUIExpr(e.receiver, ctx);
      const args = e.args.map((a) => renderUIExpr(a, ctx));
      return `${recv}.${e.member}(${args.join(", ")})`;
    }
    case "call":
      return `${e.name}(${e.args.map((a) => renderUIExpr(a, ctx)).join(", ")})`;
    case "new":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderUIExpr(f.value, ctx)}`).join(", ")} })`;
    case "object":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderUIExpr(f.value, ctx)}`).join(", ")} })`;
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date().toISOString()";
  if (lit === "null") return "null";
  return value;
}

// ---------------------------------------------------------------------------
// UI call resolution
// ---------------------------------------------------------------------------

interface UiCallShape {
  aggregateSlug: string;
  method: string;
  args: ExprIR[];
}

/** `ui.<aggregateSlug>.<method>(...)` → resolved shape. */
function matchUiCall(e: ExprIR): UiCallShape | null {
  if (e.kind !== "method-call") return null;
  if (e.receiver.kind !== "member") return null;
  const r = e.receiver;
  if (r.receiver.kind !== "ref" || r.receiver.name !== "ui") return null;
  return { aggregateSlug: r.member, method: e.member, args: e.args };
}

function renderUiCall(call: UiCallShape, ctx: RenderCtx): string {
  const agg = findAggregateBySlug(call.aggregateSlug, ctx.contexts);
  if (!agg) {
    const known = ctx.contexts
      .flatMap((c) => c.aggregates.map((a) => snake(plural(a.name))))
      .sort()
      .join(", ");
    throw new Error(
      `ui e2e: unknown aggregate 'ui.${call.aggregateSlug}' on this deployable. ` +
        `Available aggregates: ${known || "(none)"}.`,
    );
  }
  const cap = upper(agg.name);

  if (call.method === "create") {
    // ListPage.goto → create → fill → submit.  Returns
    // `{ id: <DetailPage>.id }` so callers can chain like the api
    // version (`prod.id` works).  Wrap in `await (async () => {})()`
    // so a `let prod = ui.x.create({...})` binds to the resolved
    // value, not a Promise.
    const body = call.args[0] ? renderUIExpr(call.args[0], ctx) : "{}";
    return [
      "await (async () => {",
      `  const __list = await new ${cap}ListPage(page).goto();`,
      `  const __new = await __list.create();`,
      `  await __new.fill(${body});`,
      `  const __detail = await __new.submit();`,
      `  return { id: __detail.id };`,
      "})()",
    ].join(" ");
  }
  if (call.method === "getById") {
    if (call.args.length < 1) {
      throw new Error(
        `ui e2e: ui.${call.aggregateSlug}.getById(target) requires a target argument`,
      );
    }
    const idExpr = renderIdArg(call.args[0], ctx);
    // Eagerly fetch every primitive / enum / VO field so callers can
    // do `read.status == "Confirmed"` directly, plus a `length`-typed
    // accessor per contained collection so `read.lines.length` works.
    const fieldReads = agg.fields
      .filter((f) => isReadable(f.type.kind))
      .map((f) => `    ${f.name}: await __detail.field("${f.name}"),`)
      .join("\n");
    const containmentReads = agg.contains
      .filter((c) => c.collection)
      .map((c) => `    ${c.name}: { length: await __detail.${c.name}Count() },`)
      .join("\n");
    return [
      "await (async () => {",
      `  const __detail = await new ${cap}DetailPage(page, ${idExpr}).goto();`,
      "  return {",
      "    id: __detail.id,",
      fieldReads,
      containmentReads,
      "  };",
      "})()",
    ]
      .filter((l) => l.trim().length > 0)
      .join("\n");
  }
  const op = agg.operations.find(
    (o) => o.visibility === "public" && o.name === call.method,
  );
  if (op) return renderOperationCall(op, agg, call.args, ctx);

  const ops = agg.operations.filter((o) => o.visibility === "public").map((o) => o.name);
  throw new Error(
    `ui e2e: unknown method 'ui.${call.aggregateSlug}.${call.method}'. ` +
      `Available: create, getById, ${ops.join(", ")}.`,
  );
}

function renderOperationCall(
  op: OperationIR,
  agg: AggregateIR,
  args: ExprIR[],
  ctx: RenderCtx,
): string {
  if (args.length < 1) {
    throw new Error(
      `ui e2e: ui.${snake(plural(agg.name))}.${op.name}(target, body?) requires a target argument`,
    );
  }
  const cap = upper(agg.name);
  const idExpr = renderIdArg(args[0], ctx);
  const body = args.length >= 2 ? renderUIExpr(args[1], ctx) : "{}";
  if (op.params.length === 0) {
    return `await new ${cap}DetailPage(page, ${idExpr}).goto().then((__d) => __d.${camel(op.name)}())`;
  }
  return `await new ${cap}DetailPage(page, ${idExpr}).goto().then((__d) => __d.${camel(op.name)}(${body}))`;
}

function renderIdArg(arg: ExprIR, ctx: RenderCtx): string {
  // Same convention as the api renderer: a let-bound name carries
  // the create-result shape `{ id }`, so append `.id`.
  const rendered = renderUIExpr(arg, ctx);
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

function isReadable(kind: string): boolean {
  // Page-object `field()` reader is sized for primitive-shaped data
  // (string, enum, datetime as ISO).  Skip nested entities / arrays
  // — those need different accessors.
  return (
    kind === "primitive" || kind === "id" || kind === "enum" || kind === "valueobject"
  );
}

function upper(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}
