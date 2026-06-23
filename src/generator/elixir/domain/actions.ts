// -------------------------------------------------------------------------
// Domain-emit action rendering — Ash `actions do … end` blocks for the
// aggregate's operations, their per-action policies, and operation-level
// validations.  Depends on ./predicates; consumed by the core resource
// renderer (domain-emit.ts).
// -------------------------------------------------------------------------

import { isConstructible } from "../../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ContextStampAssignmentIR,
  ExprIR,
  OperationIR,
} from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { classifyForWire, singleFieldShape } from "../../../ir/validate/invariant-classify.js";
import { snake } from "../../../util/naming.js";
import {
  isAshReturningOpSupported,
  renderAshReturningOpAction,
} from "../operation-returns-ash-emit.js";
import type { RenderCtx } from "../render-expr.js";
import { relationshipNameFor, renderAshType, renderExpr } from "../render-expr.js";
import { renderElixirStatements } from "../render-stmt.js";
import type { valueCollectionsWithVo } from "../value-collection-resource-emit.js";
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
/** A `requires`-guarded op that emits an Ash policy + SimpleCheck — i.e. a
 *  guarded op handled by the normal update-action path.  A *returning* op
 *  (emitted as a generic action) handles its `requires`/`precondition` inline in
 *  the run fn (`isAshReturningOpSupported`), so it must NOT also emit a policy
 *  check (the check's changeset/actor context doesn't carry the run fn's
 *  `record`/param binds — DEBT-03). */
export function isAshPolicyGuardedOperation(op: AggregateIR["operations"][number]): boolean {
  return isGuardedOperation(op) && !isAshReturningOpSupported(op);
}

export function renderPolicies(agg: AggregateIR, resourceModule: string): string {
  const guarded = agg.operations.filter(isAshPolicyGuardedOperation);
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
  const guarded = agg.operations.filter(isAshPolicyGuardedOperation);
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

/** The reference-collection (`Id<T>[]`) management seam for an Ash create/update
 *  action — one `argument :<f>, {:array, :uuid}` + one `change manage_relationship`
 *  per ref-collection field.  Set-replace by id: `:append_and_remove` looks each
 *  input id up by primary key and relates the existing target (its preset is
 *  `on_lookup: :relate, on_no_match: :error, on_missing: :unrelate`), so the join
 *  rows end up exactly the given set without ever creating a target.  The exact
 *  analogue of the VO-collection seam; the READ side
 *  (the `<f>_through` m2m relationship + the `:<f>` `{:array, :uuid}` `list`
 *  aggregate + the load preparation) is already emitted by domain-emit, and the wire encoder
 *  now includes `:<f>` too — so create/update accepting the id list is the last
 *  missing half.  Empty → byte-identical pre-ref-collection output. */
function refCollManageLines(agg: AggregateIR, associations: AssociationIR[]): string[] {
  return associations.flatMap((a) => {
    const f = snake(a.fieldName);
    const rel = relationshipNameFor(agg, a.fieldName);
    return [
      `      argument :${f}, {:array, :uuid}, allow_nil?: true`,
      `      change manage_relationship(:${f}, :${rel}, type: :append_and_remove)`,
    ];
  });
}

export function renderActions(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  renderCtx: RenderCtx,
  ctxModule: string,
  /** The promoted-capability filter (§11.6) the default `:read` action must
   *  apply — non-null when some read of `agg` `ignoring`s a capability, so that
   *  capability's predicate left the always-on `base_filter` and must be
   *  re-applied on every read that does NOT bypass it (the default `:read`
   *  carries no `ignoring`, so it gets the full promoted predicate).  Null →
   *  the default `:read` stays a bare default (byte-identical pre-bypass). */
  promotedReadExpr?: string | null,
  /** Value-object collection fields (`charges: Money[]`) — `has_many` child
   *  resources managed via `manage_relationship` on create/update rather than
   *  `accept`ed as scalar attributes.  Empty → byte-identical pre-VO-collection
   *  output. */
  valueCollections: ReturnType<typeof valueCollectionsWithVo> = [],
  /** Reference-collection fields (`party: Pokemon id[]`) — `many_to_many` join
   *  resources managed via `manage_relationship` on create/update (NOT `accept`ed,
   *  they're a calculated `{:array, :uuid}` on read).  Empty → byte-identical
   *  pre-ref-collection output. */
  associations: AssociationIR[] = [],
): string {
  const ops = agg.operations;
  // Ref-collection fields (`Id<T>[]`) aren't attributes on the resource (they
  // live in a join table); value-object collection fields (`Money[]`) aren't
  // either (they live in a child table, managed via `manage_relationship`).
  // Neither can be `accept`ed by the create action, so exclude both.
  const vcFieldNames = new Set(valueCollections.map((v) => v.vc.fieldName));
  const fieldNames = agg.fields
    .filter((f) => !isRefCollection(f.type) && !vcFieldNames.has(f.name))
    .map((f) => `:${snake(f.name)}`);

  // The value-object collection management seam — one `argument` + one
  // `change manage_relationship` per VO-array field, shared by the create and
  // update actions.  Replace-on-update semantics (`on_missing: :destroy`)
  // mirror the TS/.NET repositories' delete-then-reinsert.  An ordinal is
  // injected per position by a preceding `change` so the array round-trips in
  // declared order (the client body carries no ordinal).
  const vcArgLines = valueCollections.map(
    ({ vc }) => `      argument :${snake(vc.fieldName)}, {:array, :map}, allow_nil?: true`,
  );
  const vcManageLines = valueCollections.flatMap(({ vc }) => {
    const field = snake(vc.fieldName);
    return [
      `      change fn changeset, _ctx ->`,
      `        case Ash.Changeset.get_argument(changeset, :${field}) do`,
      `          items when is_list(items) ->`,
      `            stamped = Enum.with_index(items, fn item, i -> Map.put(Map.new(item, fn {k, v} -> {to_string(k), v} end), "ordinal", i) end)`,
      `            Ash.Changeset.set_argument(changeset, :${field}, stamped)`,
      `          _ -> changeset`,
      `        end`,
      `      end`,
      `      change manage_relationship(:${field}, :${field}, type: :direct_control)`,
    ];
  });
  const vcCreateBody =
    valueCollections.length > 0 ? `\n${[...vcArgLines, ...vcManageLines].join("\n")}` : "";
  // The reference-collection management seam — same shape, for `Id<T>[]` join
  // fields (set-replace by id).  Appended to create alongside the VO seam.
  const rcCreateBody =
    associations.length > 0 ? `\n${refCollManageLines(agg, associations).join("\n")}` : "";

  // A non-constructible aggregate (no create surface — `!isConstructible`)
  // emits no `:create` action, matching the Hono/.NET backends and the
  // suppressed frontend create page.  Ash otherwise defaults to all-CRUD;
  // this is the DEBT-09 gate for the Phoenix backend.  It's reached only
  // through its own operations / events.
  const defaultCreate = isConstructible(agg)
    ? `    create :create do
      primary? true
      accept [${fieldNames.join(", ")}]${vcCreateBody}${rcCreateBody}
    end`
    : "";

  // Return-dominant `or`-union ops (exception-less.md A3, DEBT-03) lower to an
  // Ash generic action that hands back a tagged term — an `update` action's
  // result can't carry a discriminated union.  Everything else stays an
  // `update` action.
  const opActions = ops.map((op) =>
    isAshReturningOpSupported(op)
      ? renderAshReturningOpAction(ctx, agg, op, ctxModule)
      : renderOperationAction(op, renderCtx, ctxModule, valueCollections, agg, associations),
  );

  // Ash forbids two actions of the same name.  A mutate operation whose
  // name collides with a default action (notably `crudish`'s `update`,
  // which emits an explicit `update :update do`) shadows that default —
  // drop it from the `defaults [...]` list so the explicit action stands
  // alone.  The action name is unchanged, so the unconditional PATCH
  // /<aggs>/{id} (action: :update) route still resolves.
  const opActionNames = new Set(ops.map((op) => snake(op.name)));
  // §11.6: when a capability is promoted out of `base_filter`, its predicate is
  // re-applied per-read.  The default `:read` action has no filter clause, so we
  // replace it with an explicit `read :read do filter expr(<promoted>) end` and
  // drop `:read` from the `defaults [...]` list.  `Ash.get` / by-id loads, the
  // primary read, and the auto `findAll` all resolve through `:read`, so this
  // keeps the promoted predicate applied on every read that doesn't `ignoring`
  // it.  Off the promoted path (`promotedReadExpr` null) the default stays bare.
  const explicitRead = promotedReadExpr != null && promotedReadExpr !== "";
  const defaultActions = ["read", "update", "destroy"].filter(
    (a) => !opActionNames.has(a) && !(a === "read" && explicitRead),
  );
  const explicitReadAction = explicitRead
    ? `    read :read do\n      primary? true\n      filter expr(${promotedReadExpr})\n    end\n`
    : "";

  return `\n  actions do
    defaults [${defaultActions.map((a) => `:${a}`).join(", ")}]

${explicitReadAction}${defaultCreate}
${opActions.join("\n")}
  end\n`;
}

// ---------------------------------------------------------------------------
// Lifecycle stamps (audit / softDelete capability stamps) → Ash `changes`.
//
// `contextStamps` (from `stamp onCreate`/`onUpdate`, hand-written or
// macro-emitted via `with audit`/`auditable`) become global `change fn` blocks
// scoped by `on: [:create]` / `on: [:update]` — so EVERY create / update action
// (the default `:create`/`:update` AND each named `update :<op>` action) applies
// them, mirroring the EF Core interceptor / Java `_stampOn*` methods.  Each
// assignment force-changes the attribute (`force_change_attribute` writes the
// managed/private audit columns the action doesn't `accept`).  A non-principal
// value (`createdAt := now()`) renders through the normal expression renderer
// (`now()` → `DateTime.utc_now()`); a bare `currentUser` value resolves to the
// principal id read from the threaded Ash actor (`context.actor.<idKey>`), the
// analogue of Java's `currentUser.id()`.  Event-sourced aggregates and
// principal stamps without auth are gated upstream (validateElixirStampSupport).
// ---------------------------------------------------------------------------

/** Render the value of one stamp assignment.  A bare `currentUser` ref is the
 *  principal id (`current_user.<idKey>`); everything else (including a member
 *  access like `currentUser.role`) renders via the normal expression renderer. */
function renderStampValue(value: ExprIR, ctx: RenderCtx, principalIdKey: string): string {
  if (value.kind === "ref" && value.refKind === "current-user") {
    return `current_user.${principalIdKey}`;
  }
  return renderExpr(value, ctx);
}

export function renderStampChanges(
  agg: AggregateIR,
  ctx: RenderCtx,
  principalIdKey: string,
): string {
  const stampsFor = (event: "create" | "update"): ContextStampAssignmentIR[] =>
    (agg.contextStamps ?? []).filter((r) => r.event === event).flatMap((r) => r.assignments);

  // `on:` scope per stamp event.  onCreate stamps run on create only; onUpdate
  // stamps run on BOTH create and update — mirroring the .NET AuditableInterceptor
  // (`Added || Modified`).  This keeps a NOT-NULL `updated_at` / `updated_by`
  // populated on the initial insert (created == updated), so the `auditable`
  // audit columns (`allow_nil?: false`) don't reject a create.
  const onScope: Record<"create" | "update", string> = {
    create: "[:create]",
    update: "[:create, :update]",
  };

  const block = (event: "create" | "update"): string | undefined => {
    const rules = stampsFor(event);
    if (rules.length === 0) return undefined;
    const usesUser = rules.some((a) => exprUsesCurrentUser(a.value));
    // The actor is read only when a stamp references the principal; otherwise
    // the `_context` is unused (Elixir's --warnings-as-errors rejects an unused
    // bound variable, so name it `_context` when no actor binding is emitted).
    const contextBinding = usesUser ? "context" : "_context";
    const actorBind = usesUser ? "        current_user = context.actor\n" : "";
    const pipes = rules
      .map(
        (a) =>
          `        |> Ash.Changeset.force_change_attribute(:${snake(a.field)}, ${renderStampValue(
            a.value,
            ctx,
            principalIdKey,
          )})`,
      )
      .join("\n");
    return `    change fn changeset, ${contextBinding} ->\n${actorBind}        changeset\n${pipes}\n      end,\n      on: ${onScope[event]}`;
  };

  const blocks = [block("create"), block("update")].filter((b): b is string => b !== undefined);
  if (blocks.length === 0) return "";
  return `\n  changes do\n${blocks.join("\n\n")}\n  end\n`;
}

function renderOperationAction(
  op: OperationIR,
  ctx: RenderCtx,
  _ctxModule: string,
  valueCollections: ReturnType<typeof valueCollectionsWithVo> = [],
  agg?: AggregateIR,
  associations: AssociationIR[] = [],
): string {
  // Value-object collection fields the op writes (e.g. crudish `update`'s
  // `lineItems := lineItems`): they are `has_many` relationships, not stored
  // attributes, so their argument is typed `{:array, :map}` (the managed
  // input), their `change_attribute` assignment is dropped from the body, and
  // a `manage_relationship` replace seam is appended instead.
  const vcByField = new Map(valueCollections.map((v) => [v.vc.fieldName, v.vc]));
  // Reference-collection fields the op writes (crudish `update`'s
  // `party := party`): `many_to_many` join relationships, NOT stored attributes
  // either — typed `{:array, :uuid}`, their `change_attribute` dropped, and a
  // `manage_relationship` set-replace appended (mirrors the VO seam).  Without
  // this an `Id<T>[]` assign emits `change_attribute(:party, …)` on the
  // calculated field, which Ash rejects at runtime.
  const rcByField = new Set(associations.map((a) => a.fieldName));
  const args = op.params
    .map((p) => {
      const ashType = vcByField.has(p.name)
        ? "{:array, :map}"
        : rcByField.has(p.name)
          ? "{:array, :uuid}"
          : renderAshType(p.type, ctx.contextModule);
      return `      argument :${snake(p.name)}, ${ashType}`;
    })
    .join("\n");

  // Collect precondition statements and lower them to Ash validate clauses.
  const available = new Set(op.params.map((p) => p.name));
  const validateLines = renderOperationValidates(op, ctx, available);

  // Filter out precondition AND requires statements before rendering the
  // change block — preconditions become validate clauses (above), and
  // requires guards become Ash policies (see renderPolicies); neither
  // belongs in the change fn.  (A `requires` left here would raise an
  // ArgumentError → HTTP 500 instead of the policy's 403.)
  const nonPrecondStmts = op.statements
    .filter((s) => s.kind !== "precondition" && s.kind !== "requires")
    // Drop the VO-collection AND ref-collection assignment(s) — they become
    // `manage_relationship` changes (appended below) rather than
    // `change_attribute` on a relationship/calculated field.
    .filter(
      (s) =>
        !(
          s.kind === "assign" &&
          (vcByField.has(s.target.segments[0] ?? "") || rcByField.has(s.target.segments[0] ?? ""))
        ),
    );
  const stmts = renderElixirStatements(nonPrecondStmts, ctx, "changeset");

  // The VO-collection management seam for the params this op actually writes:
  // an ordinal-stamp `change` (the body carries no ordinal) + a
  // `manage_relationship(... type: :direct_control)` replace, per field.
  const opVcFields = op.params.map((p) => p.name).filter((n) => vcByField.has(n));
  const vcManageBlock = opVcFields
    .flatMap((field) => {
      const f = snake(field);
      return [
        `      change fn changeset, _ctx ->`,
        `        case Ash.Changeset.get_argument(changeset, :${f}) do`,
        `          items when is_list(items) ->`,
        `            stamped = Enum.with_index(items, fn item, i -> Map.put(Map.new(item, fn {k, v} -> {to_string(k), v} end), "ordinal", i) end)`,
        `            Ash.Changeset.set_argument(changeset, :${f}, stamped)`,
        `          _ -> changeset`,
        `        end`,
        `      end`,
        `      change manage_relationship(:${f}, :${f}, type: :direct_control)`,
      ];
    })
    .join("\n");

  // The ref-collection management seam for the `Id<T>[]` params this op writes —
  // a `manage_relationship(:<f>, :<f>_through, …)` set-replace (no ordinal stamp;
  // a reference collection is an unordered id set, not an ordered VO array).
  const opRcFields = op.params.map((p) => p.name).filter((n) => rcByField.has(n));
  const rcManageBlock = opRcFields
    .map((field) => {
      const f = snake(field);
      const rel = relationshipNameFor(agg ?? ({} as AggregateIR), field);
      return `      change manage_relationship(:${f}, :${rel}, type: :append_and_remove)`;
    })
    .join("\n");

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
    nonPrecondStmts.length > 0 || hasFnValidate || opVcFields.length > 0 || opRcFields.length > 0
      ? "\n      require_atomic? false"
      : "";
  const vcBlock = vcManageBlock ? `\n${vcManageBlock}` : "";
  const rcBlock = rcManageBlock ? `\n${rcManageBlock}` : "";

  return `    update :${snake(op.name)} do${atomicLine}${argsBlock}${validateBlock}${changeBlock}${vcBlock}${rcBlock}
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
    // when the predicate touches `this`, and bind any operation arguments /
    // `currentUser` the predicate references — the `validate fn changeset, ctx ->`
    // callback supplies none of these natively (an unbound `amount` would be an
    // `undefined variable` compile error under `--warnings-as-errors`).  Mirrors
    // the change-fn binding block below; emit only the bindings actually used.
    const exprStr = renderExpr(stmt.expr, ctx);
    const usesCurrentUser = exprUsesCurrentUser(stmt.expr);
    const usedParams = op.params.filter((p) => stmtUsesParam(stmt, p.name));
    const bindings: string[] = [];
    if (exprUsesThis(stmt.expr)) bindings.push("        record = changeset.data");
    if (usesCurrentUser) bindings.push("        current_user = context.actor");
    for (const p of usedParams) {
      bindings.push(
        `        ${snake(p.name)} = Ash.Changeset.get_argument(changeset, :${snake(p.name)})`,
      );
    }
    const bindingBlock = bindings.length > 0 ? `${bindings.join("\n")}\n` : "";
    // The validate callback's second arg is the actor `context` only when the
    // predicate reads `currentUser`; otherwise it stays the ignored `_opts`.
    const ctxParam = usesCurrentUser ? "context" : "_opts";
    lines.push(
      `      validate fn changeset, ${ctxParam} ->\n${bindingBlock}        if ${exprStr}, do: :ok, else: {:error, ${JSON.stringify(`Precondition failed: ${stmt.source}`)}}\n      end`,
    );
  }

  return lines;
}
