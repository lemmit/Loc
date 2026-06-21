// -------------------------------------------------------------------------
// UI body checks (Bucket V / F1, F2) — page / component body shapes the
// walker renders as a silent-wrong placeholder.  Both fire on the
// fully-resolved page/component body `ExprIR`, so the matching walker
// sentinels become unreachable from valid input.
//
//   F1 — `Action(<inst>.<op>)` renders `mutateAsync({})`, dropping any
//        operation parameters (`src/generator/_walker/primitives/controls.ts`).
//        Reject an `Action` whose resolved operation takes parameters; the
//        author should use `OperationForm(of:, op:)`, which renders the
//        parameter inputs.
//
//   F2 — a method-call whose receiver doesn't resolve to a param / state /
//        let / lambda binding / ui api-handle / form shell-local renders as
//        `/* TODO: method-call … needs hooks {} binding */ undefined`
//        (`src/generator/_walker/walker-core.ts`).  Reject the unresolved
//        receiver so the sentinel can't be reached.
// -------------------------------------------------------------------------

import type { AggregateIR, EnrichedLoomModel, ExprIR, PageIR } from "../../types/loom-ir.js";
import { allAggregates, allContexts } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** Form primitives that introduce a mutation shell-local into their
 *  `onSubmit:` lambda.  The walker binds these names so the body may
 *  reference them as method-call receivers (`onSubmit: v =>
 *  create.mutateAsync(v)`); we must admit the same names. */
const FORM_SHELL_LOCALS: Record<string, readonly string[]> = {
  CreateForm: ["create", "register", "handleSubmit", "control", "errors"],
  Form: ["create", "register", "handleSubmit", "control", "errors"],
  WorkflowForm: ["run", "register", "handleSubmit", "control", "errors"],
  OperationForm: ["create", "run", "register", "handleSubmit", "control", "errors"],
};

export function validateUiBodies(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  const aggByName = new Map<string, AggregateIR>();
  for (const a of allAggregates(loom)) aggByName.set(a.name, a);
  // The api-hook detector (`tryDetectApiHook`, patterns A–G) resolves a
  // method-call receiver rooted at a declared aggregate / workflow name, or
  // the magic `Views` handle — even with no `api X: Y` binding.  Mirror that
  // acceptance so F2 only flags receivers the walker truly can't resolve.
  const aggNames = new Set<string>();
  const workflowNames = new Set<string>();
  for (const c of allContexts(loom)) {
    for (const a of c.aggregates) aggNames.add(a.name);
    for (const w of c.workflows) workflowNames.add(w.name);
  }

  for (const sys of loom.systems) {
    for (const ui of sys.uis) {
      const handles = new Set<string>([
        ...ui.apiParams.map((p) => p.name),
        ...(ui.channelParams ?? []).map((p) => p.name),
        ...aggNames,
        ...workflowNames,
        "Views",
      ]);
      for (const page of ui.pages) {
        const ctx: BodyCheckCtx = { aggByName, handles, scope: new Set(), where: pageWhere(page) };
        checkBody(page.body, ctx, diags);
        checkBody(page.title, ctx, diags);
        checkBody(page.requires, ctx, diags);
      }
      for (const comp of ui.components) {
        const ctx: BodyCheckCtx = {
          aggByName,
          handles,
          scope: new Set(),
          where: `component '${comp.name}'`,
        };
        checkBody(comp.body, ctx, diags);
      }
    }
  }
}

interface BodyCheckCtx {
  aggByName: Map<string, AggregateIR>;
  /** Receiver-root names the walker resolves to an api / view / workflow-
   *  instance hook (`tryDetectApiHook`) or a declared handle — a valid
   *  method-call receiver root even though it lowers to an `unknown` ref. */
  handles: ReadonlySet<string>;
  /** Names bound in the current lexical scope (lambda params + form
   *  shell-locals) that resolve cleanly even though they lower to an
   *  `unknown` ref. */
  scope: ReadonlySet<string>;
  where: string;
}

function pageWhere(p: PageIR): string {
  return `page '${p.name}'`;
}

/** Walk a body expression, applying F1 (Action) and F2 (method-call
 *  receiver) checks and threading lambda / form shell-local scope. */
function checkBody(e: ExprIR | undefined, ctx: BodyCheckCtx, diags: LoomDiagnostic[]): void {
  if (!e) return;
  switch (e.kind) {
    case "call": {
      // F1 — `Action(<inst>.<op>)` with a parameterized operation.
      if (e.callKind === "free" && e.name === "Action") checkActionParams(e, ctx, diags);
      // Descend, extending scope for any form primitive's lambda args.
      const shellLocals = FORM_SHELL_LOCALS[e.name];
      const childScope = shellLocals ? new Set<string>([...ctx.scope, ...shellLocals]) : ctx.scope;
      for (const a of e.args) checkBody(a, { ...ctx, scope: childScope }, diags);
      return;
    }
    case "method-call": {
      // F2 — the receiver must resolve to a binding.
      checkMethodCallReceiver(e, ctx, diags);
      checkBody(e.receiver, ctx, diags);
      for (const a of e.args) checkBody(a, ctx, diags);
      return;
    }
    case "lambda": {
      const childScope = new Set<string>([...ctx.scope, e.param]);
      checkBody(e.body, { ...ctx, scope: childScope }, diags);
      for (const s of e.block ?? []) checkStmt(s, { ...ctx, scope: childScope }, diags);
      return;
    }
    case "member":
      checkBody(e.receiver, ctx, diags);
      return;
    case "binary":
      checkBody(e.left, ctx, diags);
      checkBody(e.right, ctx, diags);
      return;
    case "unary":
      checkBody(e.operand, ctx, diags);
      return;
    case "paren":
      checkBody(e.inner, ctx, diags);
      return;
    case "ternary":
      checkBody(e.cond, ctx, diags);
      checkBody(e.then, ctx, diags);
      checkBody(e.otherwise, ctx, diags);
      return;
    case "convert":
      checkBody(e.value, ctx, diags);
      return;
    case "list":
      for (const el of e.elements) checkBody(el, ctx, diags);
      return;
    case "match":
      for (const arm of e.arms) {
        checkBody(arm.cond, ctx, diags);
        checkBody(arm.value, ctx, diags);
      }
      checkBody(e.otherwise, ctx, diags);
      return;
    case "new":
    case "object":
      for (const f of e.fields) checkBody(f.value, ctx, diags);
      return;
    default:
      return;
  }
}

/** Statement bodies inside block lambdas (StmtIR) — descend into every
 *  child expression so an Action / method-call nested in a block lambda
 *  (`onClick: e => { Orders.create(draft) }`) is still checked.  Covers the
 *  single-expr slots (`expr` / `value`) and the `args` array of a call
 *  statement; `emit` field values are recursed too. */
function checkStmt(
  s: { kind: string } & Record<string, unknown>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  for (const key of ["expr", "value"] as const) {
    const v = s[key];
    if (v && typeof v === "object" && "kind" in (v as object)) {
      checkBody(v as ExprIR, ctx, diags);
    }
  }
  if (Array.isArray(s.args)) {
    for (const a of s.args as ExprIR[]) checkBody(a, ctx, diags);
  }
  if (Array.isArray(s.fields)) {
    for (const f of s.fields as { value: ExprIR }[]) checkBody(f.value, ctx, diags);
  }
}

/** F1 — flag an `Action(<inst>.<op>)` whose resolved public operation
 *  takes parameters (the walker drops them, emitting `mutateAsync({})`). */
function checkActionParams(
  call: Extract<ExprIR, { kind: "call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  const arg0 = call.args[0];
  if (!arg0 || arg0.kind !== "member") return;
  const recv = arg0.receiver;
  // The instance ref carries its declared aggregate type.
  if (recv.kind !== "ref" || recv.type?.kind !== "entity") return;
  const agg = ctx.aggByName.get(recv.type.name);
  if (!agg) return;
  const opName = arg0.member;
  const op = agg.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) return;
  if (op.params.length > 0) {
    diags.push({
      severity: "error",
      code: "loom.action-op-has-params",
      message:
        `${ctx.where}: \`Action(${recv.name}.${opName})\` targets operation '${agg.name}.${opName}', ` +
        `which takes ${op.params.length} parameter(s) (${op.params.map((p) => p.name).join(", ")}). ` +
        `\`Action\` renders a one-shot button that submits no parameters, so they would be silently dropped. ` +
        `Use \`OperationForm(of: ${agg.name}, op: ${opName})\` — it renders the parameter inputs.`,
      source: ctx.where,
    });
  }
}

/** F2 — flag a method-call whose receiver root doesn't resolve to a known
 *  binding.  A clean receiver is anything except an `unknown`-rooted chain
 *  whose root is neither a ui api-handle nor an in-scope lambda / form
 *  shell-local. */
function checkMethodCallReceiver(
  call: Extract<ExprIR, { kind: "method-call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  const root = rootRef(call.receiver);
  // The receiver root is well-resolved unless it's an `unknown` ref.
  if (!root || root.refKind !== "unknown") return;
  // `unknown` is fine when the root is a resolvable handle (api / view /
  // aggregate / workflow — `Sales.Customer.create(…)`, `Customer.byId(…)`,
  // `Views.x`) or an in-scope lambda param / form shell-local.
  if (ctx.handles.has(root.name) || ctx.scope.has(root.name)) return;
  diags.push({
    severity: "error",
    code: "loom.method-call-unresolved-receiver",
    message:
      `${ctx.where}: method call \`${describeReceiver(call.receiver)}.${call.member}(…)\` has an ` +
      `unresolved receiver '${root.name}'. A method-call receiver must resolve to a page/component ` +
      `parameter, state / derived value, lambda binding, or a declared api handle ` +
      `(\`api <Handle>: <Api>\`). Declare the handle, or fix the reference.`,
    source: ctx.where,
  });
}

/** The deepest root ref of a member / method-call receiver chain. */
function rootRef(e: ExprIR): Extract<ExprIR, { kind: "ref" }> | undefined {
  let cur: ExprIR = e;
  for (;;) {
    if (cur.kind === "ref") return cur;
    if (cur.kind === "member") cur = cur.receiver;
    else if (cur.kind === "method-call") cur = cur.receiver;
    else if (cur.kind === "paren") cur = cur.inner;
    else return undefined;
  }
}

/** Best-effort dotted description of a receiver chain for the diagnostic. */
function describeReceiver(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "member") return `${describeReceiver(e.receiver)}.${e.member}`;
  if (e.kind === "method-call") return `${describeReceiver(e.receiver)}.${e.member}(…)`;
  if (e.kind === "paren") return describeReceiver(e.inner);
  return "<expr>";
}
