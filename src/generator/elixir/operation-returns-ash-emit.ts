// ---------------------------------------------------------------------------
// Ash operation `or`-union returns — exception-less.md (A3), DEBT-03.
//
// On the Ash foundation a Loom `operation` normally lowers to an Ash `update`
// action whose result is the resource struct — which *cannot* carry a
// discriminated union (a `change fn` must hand back a changeset, not a
// `%{type: "NotFound", …}` map).  See exception-less.md "Why Phoenix is
// deferred".  The documented fix (and the one implemented here) emits a
// union-returning operation as an Ash 3.x **generic action**
// (`action :<op>, :term do … run fn input, _ctx -> {:ok, tagged} end end`)
// instead of an `update`:
//
//   - The `run` fn loads the record by id (`Ash.get(__MODULE__, id)`), runs the
//     operation body, and returns one of three tagged terms — `{:success, body}`
//     for the aggregate / scalar success variant, `{:problem, tag, data}` for an
//     `error`-payload variant, or `{:not_found, id}` when the record is absent.
//   - The controller calls the generic action's code interface and translates:
//     a success → 200 + body, an error variant → its RFC-7807 ProblemDetails
//     status (the same `problem_variant/5` responder the vanilla foundation
//     emits), an absent record → the shared 404.
//
// **Slice scope (first slice):** *return-dominant* bodies only — every statement
// is a `return` or a `let`.  A generic action has no changeset, so
// mutation-then-return (`assign`/`add`/`remove`/`emit` before the return) and
// `requires`/`precondition` guards stay gated on `foundation: ash`
// (`validateOperationReturnsUnimplemented` keeps rejecting them).  This covers
// the canonical `operation foo(): Agg or NotFound { return NotFound { … } }`
// shape every current fixture uses; the mutation/guard forms are a follow-up
// (they need the generic-action changeset bridge the doc describes).
// ---------------------------------------------------------------------------

import { variantTag } from "../../ir/stdlib/unions.js";
import type { AggregateIR, BoundedContextIR, OperationIR } from "../../ir/types/loom-ir.js";
import { isReturnDominantOp } from "../../ir/util/operation-returns.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";
// Foundation-neutral helpers shared with the vanilla emitter.
import { errorVariantsOf } from "./vanilla/operation-returns-emit.js";

/** A returning op the Ash slice can emit today: its body is *return-dominant*
 *  (every statement is a `return` or a `let`).  Bodies with mutations
 *  (`assign`/`add`/`remove`/`emit`) or guards (`precondition`/`requires`) need
 *  the generic-action changeset bridge and stay gated on Ash for now.  Shares
 *  `isReturnDominantOp` with the validator gate so the two never drift. */
export function isAshReturningOpSupported(op: OperationIR): boolean {
  return isReturnDominantOp(op);
}

/** Does this aggregate have any public returning op the Ash slice emits (→ the
 *  controller needs the shared `problem_variant/5` responder)? */
export function aggregateHasAshReturningOp(agg: AggregateIR): boolean {
  return agg.operations.some((op) => op.visibility === "public" && isAshReturningOpSupported(op));
}

/** The wire field list a success-by-aggregate fall-through serialises — the same
 *  ordered `wireShape` the CRUD/find actions expose, so the success body matches
 *  `GET /<plural>/:id`. */
function wireFieldsOf(agg: AggregateIR): string[] {
  return (agg.wireShape ?? []).map((f) => snake(f.name));
}

/** A return variant is an *error* iff it names a `kind: "error"` payload. */
function isErrorTag(tag: string, ctx: BoundedContextIR): boolean {
  return ctx.payloads.some((p) => p.name === tag && p.kind === "error");
}

// ---------------------------------------------------------------------------
// Resource action — the generic action whose run fn returns the tagged term.
// ---------------------------------------------------------------------------

/** Emit the `action :<op>, :term do … end` generic action for a returning op.
 *  Rendered inside the resource's `actions do … end` block (domain-emit). */
export function renderAshReturningOpAction(
  ctx: BoundedContextIR,
  agg: AggregateIR,
  op: OperationIR,
): string {
  const opSnake = snake(op.name);
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: "", // not needed — return-dominant bodies only touch record/params
    foundation: "ash",
  };

  // Generic-action arguments: the record id (so the run fn can load it) plus
  // each operation parameter.  `:term` keeps the argument types permissive —
  // the controller already validated the request body against the op's request
  // schema before calling the code interface.
  const argLines = [
    `      argument :id, :string, allow_nil?: false`,
    ...op.params.map((p) => `      argument :${snake(p.name)}, :term`),
  ];

  // Param binds (only those the body references stay free of dead-binding
  // warnings — `let`/`return` exprs reference params by their snake name).
  const usedParams = op.params.filter((p) =>
    op.statements.some((s) => statementReferencesName(s, p.name)),
  );
  const paramBinds = usedParams.map(
    (p) => `            ${snake(p.name)} = input.arguments.${snake(p.name)}`,
  );

  // Body: the `let` binds, then the terminal tagged term.
  const bodyLines: string[] = [];
  for (const s of op.statements) {
    if (s.kind === "let") {
      bodyLines.push(`            ${snake(s.name)} = ${renderExpr(s.expr, renderCtx)}`);
    } else if (s.kind === "return") {
      bodyLines.push(`            ${renderReturnTerm(s, ctx, agg, renderCtx)}`);
    }
  }
  // A body that doesn't end in an explicit `return` falls through to its
  // aggregate success variant — serialise the (unmutated, return-dominant)
  // record's wire shape.
  const lastIsReturn = op.statements[op.statements.length - 1]?.kind === "return";
  const succeedsWithAggregate =
    op.returnType?.kind === "union" &&
    op.returnType.variants.some((v) => v.kind === "entity" && v.name === agg.name);
  if (!lastIsReturn && succeedsWithAggregate) {
    bodyLines.push(
      `            {:ok, {:success, %{${wireFieldsOf(agg)
        .map((f) => `${f}: record.${f}`)
        .join(", ")}}}}`,
    );
  }

  const bindBlock = paramBinds.length > 0 ? `${paramBinds.join("\n")}\n` : "";
  return `    action :${opSnake}, :term do
${argLines.join("\n")}
      run fn input, _context ->
        case Ash.get(__MODULE__, input.arguments.id) do
          {:ok, record} ->
${bindBlock}${bodyLines.join("\n")}

          {:error, _} ->
            {:ok, {:not_found, input.arguments.id}}
        end
      end
    end`;
}

/** Render a `return` statement as the run fn's terminal tagged term:
 *  `{:problem, "<tag>", <data-map>}` for an error variant, else
 *  `{:success, <value>}`. */
function renderReturnTerm(
  s: Extract<OperationIR["statements"][number], { kind: "return" }>,
  ctx: BoundedContextIR,
  _agg: AggregateIR,
  rc: RenderCtx,
): string {
  const value = renderExpr(s.value, rc);
  if (s.variantTag && isErrorTag(s.variantTag, ctx)) {
    // An error payload literal renders to an Elixir map already; wrap a
    // non-map value defensively (matches the vanilla emitter).  The outer
    // `{:ok, …}` is the generic action's required run-fn success wrapper — the
    // *business* error rides as the `:problem` tag inside it.
    const data = s.value.kind === "object" ? value : `%{value: ${value}}`;
    return `{:ok, {:problem, ${JSON.stringify(s.variantTag)}, ${data}}}`;
  }
  return `{:ok, {:success, ${value}}}`;
}

/** Cheap structural check: does a return/let statement reference `<name>` as a
 *  ref?  Used only to drop dead `input.arguments.<param>` binds. */
function statementReferencesName(s: OperationIR["statements"][number], name: string): boolean {
  // Serialise the relevant expr and look for the snake name as a word — cheap
  // but sufficient (params are bound to their snake name in the rendered body).
  const expr = s.kind === "let" ? s.expr : s.kind === "return" ? s.value : undefined;
  if (!expr) return false;
  return JSON.stringify(expr).includes(`"${name}"`);
}

// ---------------------------------------------------------------------------
// Controller action — case over the tagged code-interface result.
// ---------------------------------------------------------------------------

/** The `POST /<plural>/:id/<op>` member action for a returning operation:
 *  call the generic action's code interface, then translate the tagged term —
 *  success → 200 + body, each error variant → its ProblemDetails status, an
 *  absent record → the shared 404. */
export function renderAshReturningOpControllerAction(
  webModule: string,
  contextModule: string,
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  aggPlural: string,
): string {
  const opSnake = snake(op.name);
  const opPath = snake(op.routeSlug ?? op.name);
  const aggSnake = snake(agg.name);
  const aggPascal = upperFirst(agg.name);
  // Positional code-interface args: id, then each op param read from `params`.
  // Bind `params` only when an op param actually reads it — an unused `= params`
  // trips `mix compile --warnings-as-errors`.
  const paramReads = op.params.map((p) => `params[${JSON.stringify(snake(p.name))}]`);
  const callArgs = ["id", ...paramReads].join(", ");
  const headPattern = op.params.length > 0 ? `%{"id" => id} = params` : `%{"id" => id}`;
  const errorClauses = errorVariantsOf(op, ctx).map(
    (v) => `      {:ok, {:problem, ${JSON.stringify(v.tag)}, data}} ->
        problem_variant(conn, ${v.status}, ${JSON.stringify(v.type)}, ${JSON.stringify(v.title)}, data)`,
  );
  return `  @doc "POST /api/${aggPlural}/:id/${opPath}"
  def ${opSnake}(conn, ${headPattern}) do
    case ${contextModule}.${opSnake}_${aggSnake}(${callArgs}) do
      {:ok, {:success, body}} ->
        json(conn, body)

${errorClauses.join("\n\n")}

      {:ok, {:not_found, _}} ->
        ${webModule}.ProblemDetails.not_found_response(conn, "${aggPascal}", id)

      {:error, _} ->
        ${webModule}.ProblemDetails.problem_response(conn, 422, "Unprocessable Entity", "Operation '${op.name}' failed")
    end
  end`;
}

/** The shared per-controller responder for an error variant — RFC-7807
 *  envelope + the variant's own fields as §3.2 extension members.  Identical
 *  shape to the vanilla foundation's `problem_variant/5`. */
export function renderAshProblemVariantHelper(): string {
  return `  defp problem_variant(conn, status, type, title, data) do
    body =
      Map.merge(
        %{type: type, title: title, status: status, detail: title, instance: conn.request_path},
        data
      )

    conn
    |> put_resp_content_type("application/problem+json")
    |> put_status(status)
    |> json(body)
  end`;
}
