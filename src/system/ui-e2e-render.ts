import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  ExprIR,
  OperationIR,
  SubdomainIR,
  SystemIR,
  TestE2EIR,
  TestStmtIR,
  ViewIR,
  WorkflowIR,
} from "../ir/types/loom-ir.js";
import { intrinsicMatcherSig } from "../util/intrinsic-matchers.js";
import { lowerFirst, plural, snake, upperFirst } from "../util/naming.js";
import { DURATION_UNIT_MS } from "../util/temporal.js";
import { renderExpectStmt } from "./expect-stmt.js";

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
  /** Locals bound to a `ui.<agg>.getById(...)` result — i.e. a navigated
   *  detail page-object handle.  Member access on these lowers to
   *  locator-based reads (`.field("x")` / `.<coll>Rows()`) and equality
   *  assertions on them lower to web-first matchers. */
  detailHandles: Set<string>;
}

export function renderUIE2EFile(
  sys: SystemIR,
  modulesByName: Map<string, SubdomainIR>,
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
  // Page-object imports per aggregate / workflow / view referenced
  // anywhere in the bodies.
  const aggregates = collectReferencedAggregates(uiTests, contexts);
  const workflows = collectReferencedWorkflows(uiTests, contexts);
  const views = collectReferencedViews(uiTests, contexts);

  // Render every test body first, then derive imports from what actually
  // appears — keeps `<Agg>ListPage` / `<Agg>DetailPage` out of the import
  // line when the test never references that page-object (per the
  // generated-code Biome gate).
  const bodyLines: string[] = [];
  for (const t of uiTests) {
    const ctx: RenderCtx = {
      deployable: reactDeployable,
      contexts,
      locals: new Set(),
      detailHandles: new Set(),
    };
    bodyLines.push(...renderTest(t, ctx));
    bodyLines.push("");
  }
  const body = bodyLines.join("\n");
  const refs = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(body);

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  // `./fixtures` re-exports Playwright's `test`/`expect` with an auto
  // console-capture fixture that attaches the browser console + page
  // errors to the report on failure.
  lines.push(`import { test, expect } from "./fixtures";`);
  for (const a of aggregates) {
    const cap = upperFirst(a.name);
    const used = [`${cap}ListPage`, `${cap}DetailPage`].filter(refs);
    if (used.length > 0) {
      lines.push(`import { ${used.join(", ")} } from "./pages/${lowerFirst(a.name)}";`);
    }
  }
  for (const wf of workflows) {
    const cap = upperFirst(wf.name);
    if (refs(`${cap}WorkflowPage`)) {
      lines.push(`import { ${cap}WorkflowPage } from "./pages/workflows/${snake(wf.name)}";`);
    }
  }
  for (const v of views) {
    const cap = upperFirst(v.name);
    if (refs(`${cap}ViewPage`)) {
      lines.push(`import { ${cap}ViewPage } from "./pages/views/${snake(v.name)}";`);
    }
  }
  lines.push("");
  lines.push(...bodyLines);
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
    if (
      s.kind === "expect" ||
      s.kind === "expect-throws" ||
      s.kind === "let" ||
      s.kind === "expression"
    ) {
      walkExpr(s.expr);
    }
  }
  function walkExpr(e: ExprIR | undefined): void {
    if (!e) return;
    const call = matchUiCall(e);
    if (call && call.kind === "aggregate") {
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

function collectReferencedWorkflows(
  tests: TestE2EIR[],
  contexts: BoundedContextIR[],
): WorkflowIR[] {
  const seen = new Set<string>();
  const out: WorkflowIR[] = [];
  walkAllExprs(tests, (e) => {
    const call = matchUiCall(e);
    if (call && call.kind === "workflow") {
      const wf = findWorkflowByName(call.workflowName, contexts);
      if (wf && !seen.has(wf.name)) {
        seen.add(wf.name);
        out.push(wf);
      }
    }
  });
  return out;
}

function collectReferencedViews(tests: TestE2EIR[], contexts: BoundedContextIR[]): ViewIR[] {
  const seen = new Set<string>();
  const out: ViewIR[] = [];
  walkAllExprs(tests, (e) => {
    const call = matchUiCall(e);
    if (call && call.kind === "view") {
      const v = findViewByName(call.viewName, contexts);
      if (v && !seen.has(v.name)) {
        seen.add(v.name);
        out.push(v);
      }
    }
  });
  return out;
}

function walkAllExprs(tests: TestE2EIR[], visit: (e: ExprIR) => void): void {
  const walk = (e: ExprIR | undefined): void => {
    if (!e) return;
    visit(e);
    if (e.kind === "method-call") {
      walk(e.receiver);
      for (const a of e.args) walk(a);
    }
    if (e.kind === "member") walk(e.receiver);
    if (e.kind === "binary") {
      walk(e.left);
      walk(e.right);
    }
    if (e.kind === "ternary") {
      walk(e.cond);
      walk(e.then);
      walk(e.otherwise);
    }
    if (e.kind === "unary") walk(e.operand);
    if (e.kind === "paren") walk(e.inner);
    if (e.kind === "call") for (const a of e.args) walk(a);
    if (e.kind === "new" || e.kind === "object") {
      for (const f of e.fields) walk(f.value);
    }
  };
  for (const t of tests) {
    for (const s of t.statements) {
      if (
        s.kind === "expect" ||
        s.kind === "expect-throws" ||
        s.kind === "let" ||
        s.kind === "expression"
      ) {
        walk(s.expr);
      }
    }
  }
}

function findWorkflowByName(name: string, contexts: BoundedContextIR[]): WorkflowIR | undefined {
  for (const c of contexts) {
    for (const w of c.workflows) {
      if (lowerFirst(w.name) === name) return w;
      if (snake(w.name) === name) return w;
    }
  }
  return undefined;
}

function findViewByName(name: string, contexts: BoundedContextIR[]): ViewIR | undefined {
  for (const c of contexts) {
    for (const v of c.views) {
      if (lowerFirst(v.name) === name) return v;
      if (snake(v.name) === name) return v;
    }
  }
  return undefined;
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
    // Explicit, typed matchers — `expect(<x>).toHaveText("…")` — are
    // resolved in the IR (isIntrinsicMatcher) and rendered directly to the
    // native Playwright matcher. Anything else (bare bool expr) falls
    // through to the shared `expect(<x>).toBe(true)` form.
    const explicit = renderExplicitMatcher(s.expr, ctx);
    if (explicit) return explicit;
    return renderExpectStmt(s.expr, (e) => renderUIExpr(e, ctx));
  }
  if (s.kind === "expect-throws") {
    return `await expect(async () => { ${renderUIExpr(s.expr, ctx)}; }).rejects.toThrow();`;
  }
  if (s.kind === "let") {
    ctx.locals.add(s.name);
    // A `let read = ui.<agg>.getById(...)` binds a navigated detail
    // handle — track it so member reads / assertions lower to locators.
    const call = matchUiCall(s.expr);
    if (call && call.kind === "aggregate" && call.method === "getById") {
      ctx.detailHandles.add(s.name);
    }
    return `const ${s.name} = ${renderUIExpr(s.expr, ctx)};`;
  }
  if (s.kind === "expression") {
    return `${renderUIExpr(s.expr, ctx)};`;
  }
  if (s.kind === "call") {
    return `${renderUIExpr({ kind: "call", callKind: "free", name: s.name, args: s.args }, ctx)};`;
  }
  // Fail generation loudly rather than emitting a comment: a silently dropped
  // statement would ship a green-but-empty Playwright spec.  Only expect /
  // expect-throws / let / expression / call are valid in a ui e2e test body.
  throw new Error(
    `ui e2e: unsupported statement '${s.kind}' in a ui test body — ` +
      `only expect, expect-throws, let, expression, and call are supported.`,
  );
}

/** Render an explicit, typed matcher call — `expect(<x>).toHaveText("…")`
 *  — straight to its Playwright form. The matcher (resolved into the IR as
 *  `isIntrinsicMatcher`) drives the locator kind: `toHaveCount` reads a
 *  collection (`…Rows()`), the other web-first matchers read a field
 *  locator (`field("…")`), and `toBe` compares a one-shot value. Returns
 *  null when the receiver isn't a recognised detail-handle read, so the
 *  caller can fall back. */
function renderExplicitMatcher(expr: ExprIR, ctx: RenderCtx): string | null {
  if (expr.kind !== "method-call" || !expr.isIntrinsicMatcher) return null;
  const sig = intrinsicMatcherSig(expr.member);
  if (!sig) return null;
  const args = expr.args.map((a) => renderUIExpr(a, ctx));
  // In source `expect(<inner>).toHaveText(…)`, the matcher's receiver is the
  // parenthesised asserted expression.
  const inner = expr.receiver.kind === "paren" ? expr.receiver.inner : expr.receiver;

  if (sig.on === "value") {
    return `expect(${renderUIExpr(inner, ctx)}).${expr.member}(${args.join(", ")});`;
  }

  // Locator matcher: the inner must be `<detailHandle>.<member>`.
  const dm = matchDetailField(inner, ctx);
  if (!dm) return null;
  const locator =
    expr.member === "toHaveCount"
      ? `${dm.handle}.${dm.field}Rows()`
      : `${dm.handle}.field("${dm.field}")`;
  return `await expect(${locator}).${expr.member}(${args.join(", ")});`;
}

/** `<handle>.<field>` where `<handle>` is a detail-handle local — and the
 *  member is a real field, not the page object's own `id` property. */
function matchDetailField(e: ExprIR, ctx: RenderCtx): { handle: string; field: string } | null {
  if (e.kind !== "member" || e.member === "id") return null;
  if (e.receiver.kind !== "ref" || !ctx.detailHandles.has(e.receiver.name)) {
    return null;
  }
  return { handle: e.receiver.name, field: e.member };
}

/** `<handle>.<collection>.length` on a detail-handle local. */
function matchDetailCollectionLength(
  e: ExprIR,
  ctx: RenderCtx,
): { handle: string; collection: string } | null {
  if (e.kind !== "member" || e.member !== "length") return null;
  const inner = e.receiver;
  if (inner.kind !== "member" || inner.receiver.kind !== "ref") return null;
  if (!ctx.detailHandles.has(inner.receiver.name)) return null;
  return { handle: inner.receiver.name, collection: inner.member };
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
      // Lambda body is now optional (block-body lambdas were
      // added for page event handlers).  UI E2E tests don't currently
      // use block-body lambdas — fall back to a stub for the future
      // case.
      if (e.body) return `(${e.param}) => ${renderUIExpr(e.body, ctx)}`;
      return `(${e.param}) => { /* block-body lambdas not supported in UI e2e tests */ }`;
    case "member": {
      // Detail-handle reads used as plain values (the one-shot fallback,
      // for assertions web-first can't express — e.g. `<`/`>=`).  The
      // common `==` / `!=` cases are upgraded to web-first in
      // renderUIStmt; this keeps everything else total and honest.
      const coll = matchDetailCollectionLength(e, ctx);
      if (coll) return `(await ${coll.handle}.${coll.collection}Rows().count())`;
      const fld = matchDetailField(e, ctx);
      if (fld) return `(await ${fld.handle}.field("${fld.field}").innerText())`;
      return `${renderUIExpr(e.receiver, ctx)}.${e.member}`;
    }
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
    case "convert": {
      // Same TS coercion shape as `e2e-render.ts` and the domain
      // renderer — UI tests build payloads the same way the e2e
      // suite does, so the per-(from, target) emit stays uniform.
      const v = renderUIExpr(e.value, ctx);
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
      const amt = renderUIExpr(e.amount, ctx);
      return `((${amt}) * ${DURATION_UNIT_MS[e.unit]})`;
    }
    case "match": {
      // Lower match to chained ternary.  Same approach as
      // e2e-render.ts; UI tests are unlikely to evaluate match
      // expressions in v0 but staying total avoids a ts-exhaustive
      // gap.
      const arms = [...e.arms].reverse();
      const tail = e.otherwise ? renderUIExpr(e.otherwise, ctx) : "undefined";
      let out = tail;
      for (const arm of arms) {
        out = `(${renderUIExpr(arm.cond, ctx)} ? ${renderUIExpr(arm.value, ctx)} : ${out})`;
      }
      return out;
    }
    case "list":
      // List literals are walker-config sugar.  UI E2E tests don't
      // currently consume them, but keep the renderer total.
      return `[${e.elements.map((el) => renderUIExpr(el, ctx)).join(", ")}]`;
    case "action-ref":
      // Named-action references are a UI-handler-arg form — not reached by
      // the UI e2e (page-object) renderer; keep the switch total.
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
// UI call resolution
//
// Three call shapes share the `ui.<X>.<Y>(...)` syntax — disambiguated
// by the first segment:
//
//   ui.<aggregateSlug>.<method>(...)   — aggregate operation / verb
//   ui.workflows.<name>({...})         — workflow form invocation
//   ui.views.<name>()                  — view table read
//
// The first two reserve `workflows` and `views` as the slug names;
// the validator should already reject an aggregate declared with
// either of those names (the reservation list should be extended to
// cover them if it doesn't already).
// ---------------------------------------------------------------------------

type UiCallShape =
  | { kind: "aggregate"; aggregateSlug: string; method: string; args: ExprIR[] }
  | { kind: "workflow"; workflowName: string; args: ExprIR[] }
  | { kind: "view"; viewName: string; args: ExprIR[] };

/** Resolve `ui.<X>.<Y>(...)` into a tagged shape, or `null` when the
 *  expression isn't a UI call. */
function matchUiCall(e: ExprIR): UiCallShape | null {
  if (e.kind !== "method-call") return null;
  if (e.receiver.kind !== "member") return null;
  const r = e.receiver;
  if (r.receiver.kind !== "ref" || r.receiver.name !== "ui") return null;
  if (r.member === "workflows") {
    return { kind: "workflow", workflowName: e.member, args: e.args };
  }
  if (r.member === "views") {
    return { kind: "view", viewName: e.member, args: e.args };
  }
  return {
    kind: "aggregate",
    aggregateSlug: r.member,
    method: e.member,
    args: e.args,
  };
}

function renderUiCall(call: UiCallShape, ctx: RenderCtx): string {
  if (call.kind === "workflow") return renderWorkflowCall(call, ctx);
  if (call.kind === "view") return renderViewCall(call, ctx);
  return renderAggregateCall(call, ctx);
}

function renderWorkflowCall(
  call: { workflowName: string; args: ExprIR[] },
  ctx: RenderCtx,
): string {
  const wf = findWorkflowByName(call.workflowName, ctx.contexts);
  if (!wf) {
    const known = ctx.contexts
      .flatMap((c) => c.workflows.map((w) => lowerFirst(w.name)))
      .sort()
      .join(", ");
    throw new Error(
      `ui e2e: unknown workflow 'ui.workflows.${call.workflowName}' on this deployable. ` +
        `Available workflows: ${known || "(none)"}.`,
    );
  }
  const cap = upperFirst(wf.name);
  const body = call.args[0] ? renderUIExpr(call.args[0], ctx) : "{}";
  return `await new ${cap}WorkflowPage(page).run(${body})`;
}

function renderViewCall(call: { viewName: string; args: ExprIR[] }, ctx: RenderCtx): string {
  void call.args; // views take no args at the call site (parameterless reads)
  const view = findViewByName(call.viewName, ctx.contexts);
  if (!view) {
    const known = ctx.contexts
      .flatMap((c) => c.views.map((v) => lowerFirst(v.name)))
      .sort()
      .join(", ");
    throw new Error(
      `ui e2e: unknown view 'ui.views.${call.viewName}' on this deployable. ` +
        `Available views: ${known || "(none)"}.`,
    );
  }
  const cap = upperFirst(view.name);
  // Returns the row list — wrap so the binding (`let rows = ...`)
  // resolves to the array, not the Promise.
  return [
    "await (async () => {",
    `  const __view = await new ${cap}ViewPage(page).goto();`,
    `  return await __view.rows();`,
    "})()",
  ].join(" ");
}

function renderAggregateCall(
  call: { aggregateSlug: string; method: string; args: ExprIR[] },
  ctx: RenderCtx,
): string {
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
  const cap = upperFirst(agg.name);

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
    // Bind to the navigated detail page-object handle (NOT an eager
    // snapshot).  Member reads (`read.status`, `read.lines.length`) and
    // equality assertions lower against this handle's live locators —
    // web-first where possible — so the read retries against the DOM
    // exactly like real Playwright (see renderUIStmt / member handling).
    return `await new ${cap}DetailPage(page, ${idExpr}).goto()`;
  }
  const op = agg.operations.find((o) => o.visibility === "public" && o.name === call.method);
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
  const cap = upperFirst(agg.name);
  const idExpr = renderIdArg(args[0], ctx);
  const body = args.length >= 2 ? renderUIExpr(args[1], ctx) : "{}";
  if (op.params.length === 0) {
    return `await new ${cap}DetailPage(page, ${idExpr}).goto().then((__d) => __d.${lowerFirst(op.name)}())`;
  }
  return `await new ${cap}DetailPage(page, ${idExpr}).goto().then((__d) => __d.${lowerFirst(op.name)}(${body}))`;
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
