// -------------------------------------------------------------------------
// Domain-emit action rendering — Ash `actions do … end` blocks for the
// aggregate's operations, their per-action policies, and operation-level
// validations.  Depends on ./predicates; consumed by the core resource
// renderer (domain-emit.ts).
// -------------------------------------------------------------------------

import type { AggregateIR, BoundedContextIR, OperationIR } from "../../../ir/types/loom-ir.js";
import { classifyForWire, singleFieldShape } from "../../../ir/validate/invariant-classify.js";
import { snake } from "../../../util/naming.js";
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

/** `policies do … end` block — one `policy action(:op)` per guarded
 *  operation, authorizing via the op's generated SimpleCheck.  Idiomatic
 *  Ash authorization: a failed check yields `Ash.Error.Forbidden`, which
 *  the bang code-interface raises and Phoenix maps to HTTP 403 (matching
 *  Hono/.NET).  Returns "" when the aggregate has no guarded operations. */
export function renderPolicies(agg: AggregateIR, resourceModule: string): string {
  const guarded = agg.operations.filter(isGuardedOperation);
  if (guarded.length === 0) return "";
  const blocks = guarded.map(
    (op) =>
      `    policy action(:${snake(op.name)}) do\n      authorize_if ${policyCheckModule(
        resourceModule,
        op,
      )}\n    end`,
  );
  return `\n  policies do\n${blocks.join("\n")}\n  end\n`;
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
  _ctx: BoundedContextIR,
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

  const defaultCreate = `    create :create do
      primary? true
      accept [${fieldNames.join(", ")}]
    end`;

  const opActions = ops.map((op) => renderOperationAction(op, renderCtx, ctxModule));

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
