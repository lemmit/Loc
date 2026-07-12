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

import type {
  ActionIR,
  AggregateIR,
  EnrichedLoomModel,
  ExprIR,
  PageIR,
  StmtIR,
} from "../../types/loom-ir.js";
import { allAggregates, allContexts } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

// View-effect builtins (`navigate(…)`, `toast(…)`) lower to bare
// `private-operation`-shaped calls but resolve against the page's imports at
// emit time (`src/generator/_walker/primitives/controls.ts`,
// `elixir/heex-walker-core.ts`), so an action body calling one is legitimate —
// the unresolved-action-ref check must NOT flag them.
const VIEW_EFFECT_BUILTINS = new Set<string>(["navigate", "toast"]);

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
      // UI extern-function names (`function f(…) extern from "…"`) — a bare
      // call to one in an action body lowers to a `private-operation` (no UI
      // function is in `findFunctionInEnv`), so the unresolved-action-ref check
      // must NOT flag it (extern-function-hook-escape-hatch.md).
      const functionNames = new Set<string>((ui.functions ?? []).map((f) => f.name));
      // Component name → its `action`-typed param names — the extern-component
      // Tier 2 behaviour-callback slots, exempt from the lambda-purity check.
      const componentActionParams = new Map<string, ReadonlySet<string>>();
      for (const comp of ui.components) {
        const slots = new Set<string>(
          comp.params.filter((p) => p.type.kind === "action").map((p) => p.name),
        );
        if (slots.size > 0) componentActionParams.set(comp.name, slots);
      }
      for (const page of ui.pages) {
        const actionsByName = new Map(page.actions.map((a) => [a.name, a]));
        const ctx: BodyCheckCtx = {
          aggByName,
          handles,
          functionNames,
          componentActionParams,
          exemptLambdas: new Set(),
          scope: new Set(),
          where: pageWhere(page),
          actionsByName,
        };
        checkBody(page.body, ctx, diags);
        checkBody(page.title, ctx, diags);
        checkBody(page.requires, ctx, diags);
        checkActionBodies(page.actions, ctx, diags);
      }
      for (const comp of ui.components) {
        const actionsByName = new Map(comp.actions.map((a) => [a.name, a]));
        const ctx: BodyCheckCtx = {
          aggByName,
          handles,
          functionNames,
          componentActionParams,
          exemptLambdas: new Set(),
          scope: new Set(),
          where: `component '${comp.name}'`,
          actionsByName,
        };
        checkBody(comp.body, ctx, diags);
        checkActionBodies(comp.actions, ctx, diags);
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
  /** Named `action`s declared on the enclosing page/component, by name —
   *  used by the payload-conformance check to look up the referenced action's
   *  declared arity / param type (named-actions-and-stores.md, Proposal A). */
  actionsByName: ReadonlyMap<string, ActionIR>;
  /** UI extern-function names (`function f(…) extern from "…"`) in scope — a
   *  bare call to one is a legitimate `private-operation`-shaped call in an
   *  action body, not an unresolved action reference. */
  functionNames: ReadonlySet<string>;
  /** Component name → set of its `action`-typed param names.  A lambda passed
   *  to such a slot is the extern-component Tier 2 behaviour callback
   *  (extern-component-escape-hatch.md §3): it legitimately carries effects that
   *  walk in the CALLER's scope, so it is EXEMPT from `loom.effect-in-lambda`. */
  componentActionParams: ReadonlyMap<string, ReadonlySet<string>>;
  /** Lambdas the `call` arm has marked exempt from the purity check because they
   *  fill an `action`-typed component-param slot.  Shared by reference (object
   *  identity) across the whole body walk. */
  exemptLambdas: Set<ExprIR>;
  /** True while walking inside an action body (Fix 4/5).  Drives the
   *  action-body call checks: a bare call that lowered to `private-operation`
   *  is an unresolved action reference here (no such backend op exists on a
   *  frontend surface), and a BARE remote/mutating op call wants the `await`
   *  effect marker (`loom.missing-effect-marker` — async-actions-and-effects.md
   *  Stage 2; a `match await` subject is accepted). */
  inActionBody?: boolean;
}

function pageWhere(p: PageIR): string {
  return `page '${p.name}'`;
}

/** Fix 4 — run the same IR body checks over every named action's body, with
 *  the action's params in scope.  Action bodies previously escaped the page's
 *  IR checks entirely (only `page.body/title/requires` were walked); this gives
 *  them the F1/F2/payload checks and, via the `inActionBody` flag, the
 *  action-only purity checks (Fix 3 body-call + Fix 5 await-floor). */
function checkActionBodies(
  actions: readonly ActionIR[],
  baseCtx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  for (const action of actions) {
    const scope = new Set<string>([...baseCtx.scope, ...action.params.map((p) => p.name)]);
    const ctx: BodyCheckCtx = {
      ...baseCtx,
      scope,
      inActionBody: true,
      where: `${baseCtx.where} action '${action.name}'`,
    };
    for (const s of action.body) checkStmt(s, ctx, diags);
  }
}

/** Walk a body expression, applying F1 (Action) and F2 (method-call
 *  receiver) checks and threading lambda / form shell-local scope. */
function checkBody(e: ExprIR | undefined, ctx: BodyCheckCtx, diags: LoomDiagnostic[]): void {
  if (!e) return;
  switch (e.kind) {
    case "call": {
      // F1 — `Action(<inst>.<op>)` with a parameterized operation.
      if (e.callKind === "free" && e.name === "Action") checkActionParams(e, ctx, diags);
      // Named-action payload conformance — a bare `onSubmit:`/`onRowClick:`
      // action reference must match (arity) what the primitive supplies.
      checkActionPayload(e, ctx, diags);
      // Fix 3 — an unresolved bare ref in an action-handler slot
      // (`onRowClick: ghost`) names no sibling action and nothing else.
      checkHandlerSlotRefs(e, ctx, diags);
      // Descend, extending scope for any form primitive's lambda args.
      // Exempt lambdas filling an `action`-typed param of a user component
      // (extern-component Tier 2 behaviour callbacks) from the purity check.
      const actionParams = ctx.componentActionParams.get(e.name);
      if (actionParams) {
        const names = e.argNames ?? [];
        for (let i = 0; i < e.args.length; i++) {
          const a = e.args[i];
          const n = names[i];
          if (a?.kind === "lambda" && n && actionParams.has(n)) ctx.exemptLambdas.add(a);
        }
      }
      const shellLocals = FORM_SHELL_LOCALS[e.name];
      const childScope = shellLocals ? new Set<string>([...ctx.scope, ...shellLocals]) : ctx.scope;
      for (const a of e.args) checkBody(a, { ...ctx, scope: childScope }, diags);
      return;
    }
    case "method-call": {
      // F2 — the receiver must resolve to a binding.
      checkMethodCallReceiver(e, ctx, diags);
      // Fix 5 — a remote/mutating backend command in action-body position
      // needs an `await` marker (Proposal B) that doesn't exist yet.
      if (ctx.inActionBody) checkMissingEffectMarker(e, ctx, diags);
      checkBody(e.receiver, ctx, diags);
      for (const a of e.args) checkBody(a, ctx, diags);
      return;
    }
    case "lambda": {
      const childScope = new Set<string>([...ctx.scope, e.param]);
      // A render-tree lambda must be PURE — an inline effect handler
      // (`onClick: e => { count := count + 1 }`) is rejected in favour of a
      // named `action` (loom.effect-in-lambda).  Effects live only in an
      // `action` body (walked via `checkActionBodies`, never through this arm),
      // so any effectful statement reached here is an inline handler.
      checkLambdaPurity(e, ctx, diags);
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
  // Action-body call statement (Fix 3 / Fix 5).  Only reachable with
  // `inActionBody` set; `target: "action"` is a resolved sibling call, but a
  // `private-operation`/`function` fall-through inside a frontend action body
  // is a bare call that resolved to nothing local — there are no backend ops on
  // a UI surface, so it's an unresolved action reference.
  if (ctx.inActionBody && s.kind === "call") {
    const stmt = s as Extract<StmtIR, { kind: "call" }>;
    if (
      stmt.target !== "action" &&
      // A `<Store>.<action>()` call is a resolved cross-surface dispatch
      // (Stage 5) — not an unresolved sibling-action reference.
      stmt.target !== "store-action" &&
      !ctx.actionsByName.has(stmt.name) &&
      !ctx.functionNames.has(stmt.name) &&
      !VIEW_EFFECT_BUILTINS.has(stmt.name)
    ) {
      diags.push({
        severity: "error",
        code: "loom.unresolved-action-ref",
        message:
          `${ctx.where}: call \`${stmt.name}(…)\` references no sibling action and resolves to no ` +
          `function — declare an \`action ${stmt.name}(…)\` on this page/component, or fix the name.`,
        source: ctx.where,
      });
    }
  }
  // Effect-form variant-`match` (async-actions-and-effects.md Stage 2): walk the
  // awaited subject (its `awaited` flag makes the effect-marker check accept it)
  // and recurse each arm / else body so nested calls are still checked.
  if (s.kind === "variant-match") {
    const vm = s as unknown as Extract<StmtIR, { kind: "variant-match" }>;
    checkBody(vm.subject, ctx, diags);
    for (const arm of vm.arms) for (const b of arm.body) checkStmt(b, ctx, diags);
    for (const b of vm.elseBody ?? []) checkStmt(b, ctx, diags);
    return;
  }
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

/** Effectful `StmtIR` kinds — a statement that mutates state, dispatches a
 *  command, or drives navigation.  A render-tree lambda body containing any of
 *  these is an inline effect handler and must become a named `action`; the pure
 *  kinds (`let` binding, trailing `expression`, `return`, `precondition`/
 *  `requires`) are legitimate inside a value lambda block. */
const EFFECT_STMT_TOKEN: Record<string, string> = {
  assign: ":=",
  add: "+=",
  remove: "-=",
  emit: "emit",
  call: "call",
  "variant-match": "match await",
};

/** `loom.effect-in-lambda` — reject an inline effect handler in a page/component
 *  body (`onClick: e => { count := count + 1 }`).  Named actions
 *  (named-actions-and-stores.md) are the only home for an effect; this makes the
 *  language uniform (one effect-handler form) and, for the MVU/Elmish study
 *  (`docs/proposals/fable-elmish-frontend.md` §8), keeps the `Model → Html` view
 *  pure so `Msg`/`update` project straight off the `ActionIR` list.  Fires only
 *  through `checkBody`'s `lambda` arm — an `action` body is walked via
 *  `checkActionBodies` and never reaches here, so effects there are untouched.
 *
 *  Scope: the census vocabulary — effect StmtIR kinds + a single-expression
 *  view-effect (`navigate`/`toast`) call.  A direct api-hook mutation call
 *  (`onClick: e => { X.create.mutate(v) }`) is a SEPARATE mechanism (the
 *  `tryDetectApiHook` hoist, not a free effect statement) and is intentionally
 *  out of scope here. */
function checkLambdaPurity(
  lambda: Extract<ExprIR, { kind: "lambda" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  // Extern-component `action`-typed param callback — effects are legitimate and
  // walk in the caller's scope; the call arm marked it exempt.
  if (ctx.exemptLambdas.has(lambda)) return;
  // Block form (`e => { count := count + 1 }`): any effectful StmtIR kind.
  // Single-expression form (`e => navigate("/x")`): a bare view-effect call
  // (`navigate`/`toast`) — the only effect an expression body can carry (a
  // value lambda's expression is a render/projection like `Text { … }`, not an
  // effect).  A `let`/trailing-expression block stays pure and is not flagged.
  const blockEffect = (lambda.block ?? []).find((s) => s.kind in EFFECT_STMT_TOKEN);
  const body = lambda.body;
  const singleExprEffect =
    body?.kind === "call" && body.callKind === "free" && VIEW_EFFECT_BUILTINS.has(body.name);
  const token = blockEffect
    ? EFFECT_STMT_TOKEN[blockEffect.kind]
    : singleExprEffect
      ? body.name
      : undefined;
  if (!token) return;
  const arrow = lambda.param ? `${lambda.param} => …` : `() => …`;
  diags.push({
    severity: "error",
    code: "loom.effect-in-lambda",
    message:
      `${ctx.where}: inline handler \`${arrow}\` performs an effect (\`${token}\`) in the page body. ` +
      `Only a named \`action\` may carry effects — declare one and reference it by name ` +
      `(e.g. \`action doIt(…) { … }\` then \`onClick: doIt\`). Render-tree lambdas must be pure.`,
    source: ctx.where,
  });
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

/** Value of a named arg on a primitive call (parallel `argNames`). */
function namedArg(call: Extract<ExprIR, { kind: "call" }>, name: string): ExprIR | undefined {
  const names = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (names[i] === name) return call.args[i];
  }
  return undefined;
}

/** Named-action payload conformance (named-actions-and-stores.md, Proposal A
 *  Stage 1).  A bare action reference in a handler slot must match (arity)
 *  what the call-site primitive supplies:
 *    - a Form with a two-way `into:` binding supplies NO value → the
 *      `onSubmit:` action must be NULLARY (arity-1 ⇒ hard error);
 *    - a Form WITHOUT `into:` supplies its value → the action should take one
 *      payload param (arity-0 ⇒ the supplied value has nowhere to land);
 *    - a Table `onRowClick:` supplies the clicked row → arity-0 or arity-1 are
 *      both admissible (the handler may ignore the row), so only an over-arity
 *      action is flagged.
 *  One stable code: `loom.action-payload-mismatch`. */
function checkActionPayload(
  call: Extract<ExprIR, { kind: "call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  const flag = (handlerSlot: string, action: ActionIR, supplied: boolean): void => {
    const arity = action.params.length;
    if (supplied && arity === 0) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message:
          `${ctx.where}: \`${call.name} { ${handlerSlot}: ${action.name} }\` supplies a payload value, ` +
          `but action '${action.name}' is nullary — declare a single payload parameter to receive it.`,
        source: ctx.where,
      });
    } else if (!supplied && arity > 0) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message:
          `${ctx.where}: \`${call.name} { ${handlerSlot}: ${action.name} }\` supplies no payload ` +
          `(two-way \`into:\` binding), but action '${action.name}' declares ${arity} parameter(s) ` +
          `(${action.params.map((p) => p.name).join(", ")}) — make it nullary.`,
        source: ctx.where,
      });
    } else if (arity > 1) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message:
          `${ctx.where}: action '${action.name}' referenced by \`${call.name} { ${handlerSlot}: … }\` ` +
          `declares ${arity} parameters; a handler action takes at most one payload parameter.`,
        source: ctx.where,
      });
    }
  };

  // Form family — `onSubmit:` action.  A two-way `into:` binding means the
  // form supplies no value to the handler (it mutates the bound state
  // directly), so the action must be nullary.
  const FORM_PRIMITIVES = new Set(["CreateForm", "Form", "WorkflowForm", "OperationForm"]);
  if (FORM_PRIMITIVES.has(call.name)) {
    const onSubmit = namedArg(call, "onSubmit");
    if (onSubmit?.kind === "action-ref") {
      const action = ctx.actionsByName.get(onSubmit.actionName);
      if (action) flag("onSubmit", action, namedArg(call, "into") === undefined);
    }
  }
  // Table — `onRowClick:` supplies the clicked row.  Over-arity is the only
  // hard error (a nullary handler may legitimately ignore the row).
  if (call.name === "Table") {
    const onRowClick = namedArg(call, "onRowClick");
    if (onRowClick?.kind === "action-ref") {
      const action = ctx.actionsByName.get(onRowClick.actionName);
      if (action && action.params.length > 1) flag("onRowClick", action, true);
    }
  }
}

/** The named-arg slots that bind a page/component action handler — a bare
 *  reference here is an `action-ref` when it resolves, or an unresolved ref
 *  when it names nothing (`src/generator/_walker/shared/args.ts:actionRefArg`,
 *  enumerated from the primitives' `actionRefArg(call, …)` slots). */
const ACTION_HANDLER_SLOTS = ["onClick", "onRowClick", "onSubmit"] as const;

/** Fix 3 (handler position) — a bare reference in an action-handler slot that
 *  lowered to an unresolved `unknown` ref names no sibling action (it would
 *  have lowered to an `action-ref`) and isn't a declared handle.  Flag it as an
 *  unresolved action reference rather than letting it render a dangling
 *  identifier. */
function checkHandlerSlotRefs(
  call: Extract<ExprIR, { kind: "call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  for (const slot of ACTION_HANDLER_SLOTS) {
    const arg = namedArg(call, slot);
    if (!arg || arg.kind !== "ref" || arg.refKind !== "unknown") continue;
    if (
      ctx.actionsByName.has(arg.name) ||
      ctx.handles.has(arg.name) ||
      ctx.scope.has(arg.name) ||
      ctx.functionNames.has(arg.name)
    ) {
      continue;
    }
    diags.push({
      severity: "error",
      code: "loom.unresolved-action-ref",
      message:
        `${ctx.where}: \`${call.name} { ${slot}: ${arg.name} }\` references '${arg.name}', which is ` +
        `not a sibling action on this page/component — declare \`action ${arg.name}(…)\`, or fix the name.`,
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

/** `loom.missing-effect-marker` (async-actions-and-effects.md Stage 2, was
 *  `loom.action-requires-await`).  A BARE (unmarked) call in action-body
 *  position that lowers to a REMOTE, MUTATING backend command
 *  (`Sales.Order.placeOrder(o)` / `Order.placeOrder(o)`) has an invisible async
 *  boundary — it must be `await`-marked so its `Result` is handled by a
 *  `match`.  Stage 2b makes this an ERROR (was a warning during the Stage-2
 *  ramp; the corpus carried zero unmarked sites at flip time, so no codemod was
 *  needed); an `await`-marked call (the awaited subject of a variant-`match`) is
 *  ACCEPTED and skipped here.  CONSERVATIVE — only flags
 *  a `method-call` we can positively identify as an aggregate-rooted mutating
 *  command:
 *    Pattern E:  `Order.placeOrder(o)`         — `method-call(ref:<Aggregate>, op)`
 *    Pattern B:  `api.Order.placeOrder(o)`     — `method-call(member(ref:apiParam, agg), op)`
 *  whose `op` resolves to a public mutate-kind operation (or a create/destroy)
 *  on the aggregate.  Reads (`byId`, finders), sibling-action calls, pure
 *  helpers, and view-effects (`navigate`/`toast`) are deliberately NOT flagged
 *  (the await-floor boundary — see the report). */
function checkMissingEffectMarker(
  call: Extract<ExprIR, { kind: "method-call" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  // An `await`-marked call (the subject of a `match await <op>() { … }`) is the
  // explicit, handled form — accept it (async-actions-and-effects.md Stage 2).
  if (call.awaited) return;
  let aggName: string | undefined;
  // Pattern E: receiver is a bare aggregate ref.
  if (call.receiver.kind === "ref" && ctx.aggByName.has(call.receiver.name)) {
    aggName = call.receiver.name;
  }
  // Pattern B: receiver is `apiParam.Aggregate` (member rooted at an api handle).
  else if (
    call.receiver.kind === "member" &&
    call.receiver.receiver.kind === "ref" &&
    ctx.handles.has(call.receiver.receiver.name) &&
    ctx.aggByName.has(call.receiver.member)
  ) {
    aggName = call.receiver.member;
  }
  if (!aggName) return;
  const agg = ctx.aggByName.get(aggName);
  if (!agg) return;
  const op = call.member;
  const isMutating =
    agg.operations.some((o) => o.name === op && o.visibility === "public") ||
    (agg.creates ?? []).some((o) => o.name === op) ||
    (agg.destroys ?? []).some((o) => o.name === op);
  if (!isMutating) return;
  diags.push({
    severity: "error",
    code: "loom.missing-effect-marker",
    message:
      `${ctx.where}: action body calls \`${aggName}.${op}(…)\`, a remote mutating command on ` +
      `aggregate '${aggName}', with no effect marker — it has an invisible async boundary. Mark it ` +
      `\`match await ${aggName}.${op}(…) { … }\` so its Result is handled ` +
      `(async-actions-and-effects.md Stage 2b — every remote call is explicitly awaited and its ` +
      `Result matched).`,
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
