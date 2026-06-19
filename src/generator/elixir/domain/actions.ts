// -------------------------------------------------------------------------
// Domain-emit action rendering — Ash `actions do … end` blocks for the
// aggregate's operations, their per-action policies, and operation-level
// validations.  Depends on ./predicates; consumed by the core resource
// renderer (domain-emit.ts).
// -------------------------------------------------------------------------

import { isConstructible } from "../../../ir/enrich/wire-projection.js";
import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { classifyForWire, singleFieldShape } from "../../../ir/validate/invariant-classify.js";
import { snake } from "../../../util/naming.js";
import {
  isAshReturningOpSupported,
  renderAshReturningOpAction,
} from "../operation-returns-ash-emit.js";
import type { RenderCtx } from "../render-expr.js";
import { renderAshType, renderExpr } from "../render-expr.js";
import { renderElixirStatements } from "../render-stmt.js";
import {
  ashBuiltinValidate,
  exprUsesThis,
  isGuardedOperation,
  isRefCollection,
  operationGuards,
  policyCheckModule,
  stmtUsesCurrentUser,
  stmtUsesParam,
  stmtUsesThis,
} from "./predicates.js";

/** `policies do … end` block — a base `policy always()` that authorizes
 *  every action, then one `policy action(:op)` per guarded operation
 *  authorizing via the op's generated SimpleCheck.  Ash's policy authorizer
 *  DENIES any action with no matching policy, so without the base allow the
 *  un-guarded CRUD actions (`:read`/`:create`/`:destroy`/…) would all 403.
 *  Ash ANDs every applicable policy, so a guarded op is authorized only if
 *  both the base allow AND its specific check pass — the guard stays
 *  enforced (a failed check still yields `Ash.Error.Forbidden` → HTTP 403,
 *  matching Hono/.NET); coarse "must be authenticated" auth is enforced
 *  separately by the deployable's JWT plug.  Returns "" when the aggregate
 *  has no guarded operations (no authorizer is attached in that case). */
export function renderPolicies(agg: AggregateIR, resourceModule: string): string {
  const guarded = agg.operations.filter(isGuardedOperation);
  if (guarded.length === 0) return "";
  // Base allow: un-guarded actions are authorized for any caller; the
  // guarded `policy action(:op)` blocks below AND a second check on top.
  const baseAllow = `    policy always() do\n      authorize_if always()\n    end`;
  const blocks = guarded.map(
    (op) =>
      `    policy action(:${snake(op.name)}) do\n      authorize_if ${policyCheckModule(
        resourceModule,
        op,
      )}\n    end`,
  );
  return `\n  policies do\n${baseAllow}\n${blocks.join("\n")}\n  end\n`;
}

/** One `Ash.Policy.SimpleCheck` module per guarded operation.  Reuses the
 *  domain expression renderer by binding `current_user = actor`; multiple
 *  `requires` clauses AND together.  A nil actor is forbidden outright.
 *  Emitted as sibling modules after the resource (like the Jason impl). */
export function renderPolicyChecks(
  agg: AggregateIR,
  ctx: RenderCtx,
  resourceModule: string,
): string {
  const guarded = agg.operations.filter(isGuardedOperation);
  if (guarded.length === 0) return "";
  const modules = guarded.map((op) => {
    const cond = operationGuards(op)
      .map((e) => renderExpr(e, ctx))
      .join(" and ");
    const describe = op.statements
      .filter((s) => s.kind === "requires")
      .map((s) => s.source)
      .join("; ");
    return `defmodule ${policyCheckModule(resourceModule, op)} do
  @moduledoc false
  use Ash.Policy.SimpleCheck

  @impl true
  def describe(_opts), do: ${JSON.stringify(`requires: ${describe}`)}

  @impl true
  def match?(nil, _context, _opts), do: false

  def match?(actor, _context, _opts) do
    current_user = actor
    ${cond}
  end
end`;
  });
  return `${modules.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Actions (operations)
// ---------------------------------------------------------------------------

export function renderActions(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  ctxModule: string,
): string {
  const ops = agg.operations;
  // Ref-collection fields (`Id<T>[]`) aren't attributes on the
  // resource (they live in a join table); the create action can't
  // `accept` them without a `change manage_relationship` block, which
  // we defer.  Callers seed reference collections via the operations
  // that mutate them (`addToParty`, etc.).
  const fieldNames = agg.fields
    .filter((f) => !isRefCollection(f.type))
    .map((f) => `:${snake(f.name)}`);

  // A non-constructible aggregate (no create surface — `!isConstructible`)
  // emits no `:create` action, matching the Hono/.NET backends and the
  // suppressed frontend create page.  Ash otherwise defaults to all-CRUD;
  // this is the DEBT-09 gate for the Phoenix backend.  It's reached only
  // through its own operations / events.
  const defaultCreate = isConstructible(agg)
    ? `    create :create do
      primary? true
      accept [${fieldNames.join(", ")}]
    end`
    : "";

  // Return-dominant `or`-union ops (exception-less.md A3, DEBT-03) lower to an
  // Ash generic action that hands back a tagged term — an `update` action's
  // result can't carry a discriminated union.  Everything else stays an
  // `update` action.
  const opActions = ops.map((op) =>
    isAshReturningOpSupported(op)
      ? renderAshReturningOpAction(ctx, agg, op)
      : renderOperationAction(op, renderCtx, ctxModule),
  );

  // Ash forbids two actions of the same name.  A mutate operation whose
  // name collides with a default action (notably `crudish`'s `update`,
  // which emits an explicit `update :update do`) shadows that default —
  // drop it from the `defaults [...]` list so the explicit action stands
  // alone.  The action name is unchanged, so the unconditional PATCH
  // /<aggs>/{id} (action: :update) route still resolves.
  const opActionNames = new Set(ops.map((op) => snake(op.name)));
  const defaultActions = ["read", "update", "destroy"].filter((a) => !opActionNames.has(a));

  return `\n  actions do
    defaults [${defaultActions.map((a) => `:${a}`).join(", ")}]

${defaultCreate}
${opActions.join("\n")}
  end\n`;
}

function renderOperationAction(op: OperationIR, ctx: RenderCtx, _ctxModule: string): string {
  const args = op.params
    .map((p) => `      argument :${snake(p.name)}, ${renderAshType(p.type, ctx.contextModule)}`)
    .join("\n");

  // Collect precondition statements and lower them to Ash validate clauses.
  const available = new Set(op.params.map((p) => p.name));
  const validateLines = renderOperationValidates(op, ctx, available);

  // Filter out precondition AND requires statements before rendering the
  // change block — preconditions become validate clauses (above), and
  // requires guards become Ash policies (see renderPolicies); neither
  // belongs in the change fn.  (A `requires` left here would raise an
  // ArgumentError → HTTP 500 instead of the policy's 403.)
  const nonPrecondStmts = op.statements.filter(
    (s) => s.kind !== "precondition" && s.kind !== "requires",
  );
  const stmts = renderElixirStatements(nonPrecondStmts, ctx, "changeset");

  // Bind the domain-style identifiers (`record`, `current_user`, each param)
  // that the rendered body refers to but Ash's `change fn changeset, ctx ->`
  // callback doesn't supply natively.  Detect which are actually used so the
  // block stays free of dead bindings.
  const usesRecord = nonPrecondStmts.some(stmtUsesThis);
  const usesCurrentUser = nonPrecondStmts.some((s) => stmtUsesCurrentUser(s));
  const usedParams = op.params.filter((p) => nonPrecondStmts.some((s) => stmtUsesParam(s, p.name)));
  const contextBinding = usesCurrentUser ? "context" : "_context";
  const bindings: string[] = [];
  if (usesRecord) bindings.push("        record = changeset.data");
  if (usesCurrentUser) bindings.push("        current_user = context.actor");
  for (const p of usedParams) {
    bindings.push(
      `        ${snake(p.name)} = Ash.Changeset.get_argument(changeset, :${snake(p.name)})`,
    );
  }
  const bindingBlock = bindings.length > 0 ? `${bindings.join("\n")}\n` : "";

  const argsBlock = op.params.length > 0 ? `\n${args}` : "";
  const validateBlock = validateLines.length > 0 ? `\n${validateLines.join("\n")}` : "";
  const changeBlock =
    nonPrecondStmts.length > 0
      ? `\n      change fn changeset, ${contextBinding} ->\n${bindingBlock}${stmts}\n        changeset\n      end`
      : "";

  // Ash 3.x rejects both function-based changes AND function-form
  // validations as non-atomic, and refuses to register the action without
  // an explicit opt-out (under `--warnings-as-errors` the "action cannot be
  // done atomically" warning is fatal).  Flag the action when it emits a
  // `change fn` body OR a `validate fn ...` clause.  A purely built-in
  // validation (min/max/match/… — all atomic-safe) leaves the action atomic,
  // so an unnecessary `require_atomic? false` would be noise there.
  const hasFnValidate = validateLines.some((l) => l.includes("validate fn"));
  const atomicLine =
    nonPrecondStmts.length > 0 || hasFnValidate ? "\n      require_atomic? false" : "";

  return `    update :${snake(op.name)} do${atomicLine}${argsBlock}${validateBlock}${changeBlock}
    end`;
}

// ---------------------------------------------------------------------------
// Operation argument validation — lower precondition StmtIRs to
// Ash `validate` clauses inside the action block.
//
// Recognised single-field shapes (min/max/between/regex/len-*) emit the
// idiomatic Ash built-in validator; everything else emits a function form:
//
//   validate fn changeset, _opts ->
//     if <expr>, do: :ok, else: {:error, "<message>"}
//   end
// ---------------------------------------------------------------------------

function renderOperationValidates(
  op: OperationIR,
  ctx: RenderCtx,
  available: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];

  for (const stmt of op.statements) {
    if (stmt.kind !== "precondition") continue;

    const inv = { expr: stmt.expr, source: stmt.source };

    // Check if this is a single-field shape we can lower idiomatically.
    if (classifyForWire(inv, { available })) {
      const single = singleFieldShape(inv);
      if (single) {
        const ashValidate = ashBuiltinValidate(single.field, single.pattern);
        if (ashValidate) {
          lines.push(
            `      ${ashValidate}, message: ${JSON.stringify(`Precondition failed: ${stmt.source}`)}`,
          );
          continue;
        }
      }
    }

    // Fall back to the function form.  Render against `record` (= changeset.data)
    // when the predicate touches `this` so the rendered output's `record.X`
    // resolves; emit the local binding only when actually used.
    const exprStr = renderExpr(stmt.expr, ctx);
    const recordLine = exprUsesThis(stmt.expr) ? "        record = changeset.data\n" : "";
    lines.push(
      `      validate fn changeset, _opts ->\n${recordLine}        if ${exprStr}, do: :ok, else: {:error, ${JSON.stringify(`Precondition failed: ${stmt.source}`)}}\n      end`,
    );
  }

  return lines;
}
