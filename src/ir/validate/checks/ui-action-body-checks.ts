// -------------------------------------------------------------------------
// Page action-body / statement checks: action params + payload, handler-
// slot refs, method-call receiver, projection reads, missing-effect-marker
// / lambda-purity, and toast-message checks.  Split out of ui-checks.ts by
// packet 2.6 (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import type { ActionIR, AggregateIR, ExprIR, StmtIR, UiIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { namedArg, VIEW_EFFECT_BUILTINS } from "./ui-checks-shared.js";

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

/** A short type label for an arg-mismatch message (`string`, `int`, `Money?`). */

export interface BodyCheckCtx {
  aggByName: Map<string, AggregateIR>;
  /** Every declared `projection` name in the model — F3's lookup set. */
  projectionNames: ReadonlySet<string>;
  /** The subset a frontend can actually read (`isFrontendReadableProjection`).
   *  F3 rejects a read of a projection OUTSIDE this set on every target; a read
   *  INSIDE it is a per-framework question (only some frontends have the
   *  client), decided by `validateUiProjectionReadFramework` in system-checks. */
  readableProjections: ReadonlySet<string>;
  /** Receiver-root names the walker resolves to an api / workflow-
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

/** Fix 4 — run the same IR body checks over every named action's body, with
 *  the action's params in scope: the F1/F2/payload checks and, via the
 *  `inActionBody` flag, the action-only purity checks (Fix 3 body-call +
 *  Fix 5 await-floor). */

export function checkActionBodies(
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

export function checkBody(e: ExprIR | undefined, ctx: BodyCheckCtx, diags: LoomDiagnostic[]): void {
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
      // F3 — a ui read of a `projection` has no frontend path yet.
      checkProjectionRead(e, ctx, diags);
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
        message: diagMessage("loom.unresolved-action-ref#call-references-no-sibling", {
          where: ctx.where,
          name: stmt.name,
        }),
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
 *  (`docs/old/proposals/fable-elmish-frontend.md` §8), keeps the `Model → Html` view
 *  pure so `Msg`/`update` project straight off the `ActionIR` list.  Fires only
 *  through `checkBody`'s `lambda` arm — an `action` body is walked via
 *  `checkActionBodies` and never reaches here, so effects there are untouched.
 *
 *  Scope: two arms, both raising `loom.effect-in-lambda`.
 *    1. Effect StmtIR kinds (`:=`/`+=`/`emit`/bare `call`/`match await`) + a
 *       single-expression view-effect (`navigate`/`toast`) call.
 *    2. A direct remote MUTATION reachable in the lambda body (`onClick: e => {
 *       X.create(v) }`).  This lowers to an `expression`-statement wrapping a
 *       `method-call` — a *pure* StmtIR kind the arm-1 token scan skips — so it
 *       needs its own detection (`firstMutatingCallInLambda`), reusing the same
 *       remote-write classifier as the action-body await-floor.  Closes the last
 *       inline-effect form so the MVU `Model → Html` view is pure BY
 *       CONSTRUCTION on every target (fable-elmish-frontend.md §2.2 / §8). */

function checkLambdaPurity(
  lambda: Extract<ExprIR, { kind: "lambda" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  // Extern-component `action`-typed param callback — effects are legitimate and
  // walk in the caller's scope; the call arm marked it exempt.
  if (ctx.exemptLambdas.has(lambda)) return;
  const arrow = lambda.param ? `${lambda.param} => …` : `() => …`;
  // Arm 1 — effect StmtIR / view-effect.
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
  if (token) {
    diags.push({
      severity: "error",
      code: "loom.effect-in-lambda",
      message: diagMessage("loom.effect-in-lambda#effect", { where: ctx.where, arrow, token }),
      source: ctx.where,
    });
    return;
  }
  // Arm 2 — a direct remote mutation inline in the view (no effect StmtIR token,
  // so arm 1 missed it).  Reads (`.all`/`.byId`/finders) inside a value lambda
  // stay legal — only a mutating command is rejected.
  const mut = firstMutatingCallInLambda(lambda, ctx);
  if (!mut) return;
  diags.push({
    severity: "error",
    code: "loom.effect-in-lambda",
    message: diagMessage("loom.effect-in-lambda#remote-mutation", {
      where: ctx.where,
      arrow,
      aggName: mut.aggName,
      op: mut.op,
    }),
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
  if (arg0?.kind !== "member") return;
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
      message: diagMessage("loom.action-op-has-params", {
        where: ctx.where,
        name: recv.name,
        opName,
        aggName: agg.name,
        length: op.params.length,
        params: op.params.map((p) => p.name).join(", "),
      }),
      source: ctx.where,
    });
  }
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
        message: diagMessage("loom.action-payload-mismatch#supplies-a-payload-value", {
          where: ctx.where,
          name: call.name,
          handlerSlot,
          actionName: action.name,
        }),
        source: ctx.where,
      });
    } else if (!supplied && arity > 0) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message: diagMessage("loom.action-payload-mismatch#into-binding-arity", {
          where: ctx.where,
          name: call.name,
          handlerSlot,
          actionName: action.name,
          arity,
          params: action.params.map((p) => p.name).join(", "),
        }),
        source: ctx.where,
      });
    } else if (arity > 1) {
      diags.push({
        severity: "error",
        code: "loom.action-payload-mismatch",
        message: diagMessage("loom.action-payload-mismatch#action-referenced-by-declares", {
          where: ctx.where,
          name: action.name,
          callName: call.name,
          handlerSlot,
          arity,
        }),
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
    if (arg?.kind !== "ref" || arg.refKind !== "unknown") continue;
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
      message: diagMessage("loom.unresolved-action-ref#references-which-is-not", {
        where: ctx.where,
        name: call.name,
        slot,
        argName: arg.name,
      }),
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
  if (root?.refKind !== "unknown") return;
  // `unknown` is fine when the root is a resolvable handle (api /
  // aggregate / workflow — `Sales.Customer.create(…)`, `Customer.byId(…)`,
  // `Views.x`) or an in-scope lambda param / form shell-local.
  if (ctx.handles.has(root.name) || ctx.scope.has(root.name)) return;
  diags.push({
    severity: "error",
    code: "loom.method-call-unresolved-receiver",
    message: diagMessage("loom.method-call-unresolved-receiver", {
      where: ctx.where,
      receiver: describeReceiver(call.receiver),
      member: call.member,
      name: root.name,
    }),
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

/** F3 — `loom.ui-projection-read-unsupported`, the FLAVOUR half.
 *
 *  An unreadable `projection` read (`QueryView { of:
 *  <ApiHandle>.<Projection> }`) would otherwise emit
 *  `/* unresolved: <Handle> *␣/ undefined.<Projection>` — a runtime `TypeError`
 *  AND a build break, from a model with no diagnostic.  F2 above exempts an
 *  api-handle receiver root, correct for an aggregate (`Sales.Customer`), but
 *  that exemption lets a PROJECTION member through and nothing downstream
 *  resolves it.
 *
 *  Two flavours ARE readable and pass: the SINGLETON QUERY-TIME one (one object
 *  out — the dashboard KPI shape), and the GROUPED (`group by`) one, whose LIST
 *  response list-binds through `QueryView` exactly like a find-all (the
 *  query-shape derivation answers `single: false`, so the collection arms read
 *  `.length` of a real array) or feeds a `Chart`.  Every other flavour is
 *  rejected here, on every
 *  target: a KEYED projection returns an array parameterised by key, and a
 *  FOLDED one is read by key off its materialized row table.  Whether a
 *  *readable* projection's frontend has the client is a per-framework
 *  question with no platform in scope here — that is
 *  `validateUiProjectionReadFramework` (system-checks.ts). */

function checkProjectionRead(
  e: Extract<ExprIR, { kind: "member" }>,
  ctx: BodyCheckCtx,
  diags: LoomDiagnostic[],
): void {
  if (!ctx.projectionNames.has(e.member)) return;
  // A readable projection is handled by the per-framework gate, not here.
  if (ctx.readableProjections.has(e.member)) return;
  // Only flag the read shape: the member names a projection AND the receiver is
  // a handle-rooted chain the walker will fail to resolve.  A same-named field
  // on a resolved receiver (`row.SalesTotals`) is not a projection read.
  const root = rootRef(e.receiver);
  if (root?.refKind !== "unknown") return;
  if (!ctx.handles.has(root.name)) return;
  diags.push({
    severity: "error",
    code: "loom.ui-projection-read-unsupported",
    message: diagMessage("loom.ui-projection-read-unsupported#not-ui-consumable", {
      where: ctx.where,
      member: e.member,
      name: root.name,
    }),
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
  const m = mutatingAggCommand(call, ctx);
  if (!m) return;
  diags.push({
    severity: "error",
    code: "loom.missing-effect-marker",
    message: diagMessage("loom.missing-effect-marker", {
      where: ctx.where,
      aggName: m.aggName,
      op: m.op,
    }),
    source: ctx.where,
  });
}

/** Classify a `method-call` as a REMOTE, MUTATING aggregate command
 *  (`Order.placeOrder(o)` / `api.Order.placeOrder(o)`) — the one shape both the
 *  action-body await-floor (`checkMissingEffectMarker`) and the render-tree
 *  lambda-purity gate (`checkLambdaPurity`, the api-mutation arm) must reject.
 *  Returns the aggregate + op when the receiver resolves to an aggregate (bare
 *  Pattern E, or api-handle-rooted Pattern B) and `op` is a public operation /
 *  create / destroy; `undefined` for reads (`byId`, finders), non-aggregate
 *  receivers, and view-effects.  Shared so the two gates classify identically —
 *  a single source of truth for "this is a remote write". */

function mutatingAggCommand(
  call: Extract<ExprIR, { kind: "method-call" }>,
  ctx: BodyCheckCtx,
): { aggName: string; op: string } | undefined {
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
  if (!aggName) return undefined;
  const agg = ctx.aggByName.get(aggName);
  if (!agg) return undefined;
  const op = call.member;
  const isMutating =
    agg.operations.some((o) => o.name === op && o.visibility === "public") ||
    (agg.creates ?? []).some((o) => o.name === op) ||
    (agg.destroys ?? []).some((o) => o.name === op);
  return isMutating ? { aggName, op } : undefined;
}

/** The first REMOTE MUTATING aggregate command reachable anywhere inside a
 *  render-tree lambda's body/block — WITHOUT descending into nested lambdas
 *  (each is checked by its own `checkLambdaPurity` pass, so recursing here would
 *  double-report).  Drives the api-mutation arm of `loom.effect-in-lambda`: a
 *  bare `onClick: e => { X.create(v) }` inline handler performs a remote write in
 *  the view, so it must move to a named `action` (awaited + Result-matched).
 *  The AWAITED form (`match await X.create(v)`) is a `variant-match` StmtIR
 *  already caught by the effect-token scan, so the caller only reaches here for
 *  lambdas that carry no effect StmtIR at all. */

function firstMutatingCallInLambda(
  lambda: Extract<ExprIR, { kind: "lambda" }>,
  ctx: BodyCheckCtx,
): { aggName: string; op: string } | undefined {
  let found: { aggName: string; op: string } | undefined;
  const visitExpr = (e: ExprIR | undefined): void => {
    if (!e || found) return;
    switch (e.kind) {
      case "method-call": {
        const m = mutatingAggCommand(e, ctx);
        if (m) {
          found = m;
          return;
        }
        visitExpr(e.receiver);
        for (const a of e.args) visitExpr(a);
        return;
      }
      case "call":
        for (const a of e.args) visitExpr(a);
        return;
      case "member":
        visitExpr(e.receiver);
        return;
      case "binary":
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "unary":
        visitExpr(e.operand);
        return;
      case "paren":
        visitExpr(e.inner);
        return;
      case "ternary":
        visitExpr(e.cond);
        visitExpr(e.then);
        visitExpr(e.otherwise);
        return;
      case "convert":
        visitExpr(e.value);
        return;
      case "list":
        for (const el of e.elements) visitExpr(el);
        return;
      case "match":
        for (const arm of e.arms) {
          visitExpr(arm.cond);
          visitExpr(arm.value);
        }
        visitExpr(e.otherwise);
        return;
      case "new":
      case "object":
        for (const f of e.fields) visitExpr(f.value);
        return;
      // "lambda" is intentionally NOT descended — a nested lambda self-checks.
      default:
        return;
    }
  };
  const visitStmt = (s: StmtIR): void => {
    if (found) return;
    switch (s.kind) {
      case "precondition":
      case "requires":
      case "let":
      case "expression":
        visitExpr(s.expr);
        return;
      case "assign":
      case "add":
      case "remove":
        visitExpr(s.value);
        return;
      case "emit":
        for (const f of s.fields) visitExpr(f.value);
        return;
      case "call":
        for (const a of s.args) visitExpr(a);
        return;
      case "return":
        visitExpr(s.value);
        return;
      case "variant-match":
        visitExpr(s.subject);
        for (const arm of s.arms) for (const b of arm.body) visitStmt(b);
        for (const b of s.elseBody ?? []) visitStmt(b);
        return;
      default:
        return;
    }
  };
  visitExpr(lambda.body);
  for (const s of lambda.block ?? []) visitStmt(s);
  return found;
}

// -------------------------------------------------------------------------
// `loom.toast-message-unsupported` — an `on <chan>.<Event>(e) { toast(<expr>) }`
// message expression outside the v1 subset every realtime renderer implements.
//
// THE SILENT CRASH.  The AST validator (`checkUiNotification`,
// `src/language/validators/ui.ts`) bounds the handler STATEMENT vocabulary —
// `toast(<one expression>)` / `refetch(<Agg>…)` — but accepts ANY expression
// inside the `toast(…)`.  All three renderers then implement the SAME narrow
// v1 subset and `throw` on anything else:
//
//   src/generator/_frontend/realtime.ts   `renderMessageExpr`      (React/Vue/Svelte/Angular)
//   src/generator/feliz/realtime.ts       `renderFsToastMessage`   (Feliz)
//   src/generator/elixir/realtime-liveview.ts `renderMessageExprElixir` (LiveView)
//
// so `toast(e.order.id)` / `toast(x ? "a" : "b")` / `toast(string(e.at))` parses
// and validates, then aborts `ddd generate system` with a raw `Error` and a
// stack trace — no `loom.*` code, no source location.  Measured on this HEAD
// for all three renderers.  This check makes the throw a defensive backstop.
//
// The gate is the INTERSECTION of the three, which is also their union: the
// three `switch`es are arm-for-arm identical (literal / the event binding /
// single-level member off it / paren / binary), so one target-agnostic rule
// covers every frontend rather than three per-framework arms.
// -------------------------------------------------------------------------

/** Why `e` is outside the toast subset, or `undefined` when it is inside.
 *  Mirrors the three renderers' `switch` arms exactly. */

function toastMessageProblem(
  e: ExprIR,
  bind: string,
): { kind: string; detail: string } | undefined {
  switch (e.kind) {
    case "literal":
      return undefined;
    case "ref":
      return e.name === bind
        ? undefined
        : {
            kind: "ref",
            detail:
              `reads '${e.name}', which is not in scope — only the handler's event ` +
              `binding '${bind}' is`,
          };
    case "member":
      if (e.receiver.kind === "ref" && e.receiver.name === bind) return undefined;
      return {
        kind: "member",
        detail:
          `reads \`${describeReceiver(e)}\` — a toast message admits SINGLE-LEVEL member ` +
          `access off the event binding '${bind}' only`,
      };
    case "paren":
      return toastMessageProblem(e.inner, bind);
    case "binary":
      return toastMessageProblem(e.left, bind) ?? toastMessageProblem(e.right, bind);
    default:
      return {
        kind: e.kind,
        detail: `uses a \`${e.kind}\` expression`,
      };
  }
}

export function checkToastMessages(ui: UiIR, diags: LoomDiagnostic[]): void {
  for (const n of ui.notifications ?? []) {
    const where = `ui '${ui.name}': \`on ${n.paramName}.${n.eventType}\` handler`;
    for (const t of n.toasts) {
      const problem = toastMessageProblem(t, n.bind);
      if (!problem) continue;
      diags.push({
        severity: "error",
        code: "loom.toast-message-unsupported",
        message: diagMessage("loom.toast-message-unsupported", {
          where,
          kind: problem.kind,
          detail: problem.detail,
        }),
        source: where,
      });
    }
  }
}
