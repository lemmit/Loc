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
// **Slice scope:** `return`/`let`, *in-memory* mutation (`assign` →
// `%{record | field: …}`, the same struct-update the vanilla foundation does —
// no Ash changeset, no persistence beyond the response), `precondition`/
// `requires` guards (raise), and `emit` (a `Phoenix.PubSub.broadcast` of a
// domain event — no persistence, so it fits the run fn; same form the regular
// Ash op body renders).  Still gated on `foundation: ash` → host on vanilla:
// `add`/`remove`, which mutate a join table via `manage_relationship` and so
// need a changeset the generic action's run fn doesn't carry
// (`isAshReturningOpEmittable`).  Covers `operation foo(): Agg or NotFound { … }`
// with the guard/mutate/emit body patterns.
// ---------------------------------------------------------------------------

import { variantTag } from "../../ir/stdlib/unions.js";
import type { AggregateIR, BoundedContextIR, OperationIR } from "../../ir/types/loom-ir.js";
import { aggregateUsesPrincipalContextFilter } from "../../ir/types/loom-ir.js";
import { isAshReturningOpEmittable } from "../../ir/util/operation-returns.js";
import { snake, upperFirst } from "../../util/naming.js";
import { type RenderCtx, renderExpr } from "./render-expr.js";
// Foundation-neutral helpers shared with the vanilla emitter.
import { errorVariantsOf } from "./vanilla/operation-returns-emit.js";

/** A returning op the Ash slice can emit today: `return`/`let`, in-memory
 *  `assign` mutation, and `precondition`/`requires` guards.  `emit`/`add`/`remove`
 *  bodies still need machinery the generic action's run fn doesn't carry and stay
 *  gated on Ash.  Shares `isAshReturningOpEmittable` with the validator gate so
 *  the two never drift. */
export function isAshReturningOpSupported(op: OperationIR): boolean {
  return isAshReturningOpEmittable(op);
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
  ctxModule: string,
): string {
  const opSnake = snake(op.name);
  const renderCtx: RenderCtx = {
    thisName: "record",
    // The bounded-context module (e.g. `MyApp.Sales`) — an `emit` body builds
    // `%<ctxModule>.Events.<Name>{…}` and broadcasts on `<ctxModule>.PubSub`.
    contextModule: ctxModule,
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

  // Body: `let` binds, in-memory mutations + guards, then the terminal tagged
  // term.  A generic action has no changeset, so an `assign` struct-updates the
  // loaded record in place (`%{record | field: …}`, same as the vanilla
  // foundation — the fall-through success serialises the mutated struct), and
  // `precondition`/`requires` raise.  (`emit`/`add`/`remove` stay gated — the
  // validator keeps rejecting them on the ash foundation.)
  const bodyLines: string[] = [];
  for (const s of op.statements) {
    if (s.kind === "let") {
      bodyLines.push(`            ${snake(s.name)} = ${renderExpr(s.expr, renderCtx)}`);
    } else if (s.kind === "assign") {
      const field = snake(s.target.segments[0] ?? "");
      bodyLines.push(
        `            record = %{record | ${field}: ${renderExpr(s.value, renderCtx)}}`,
      );
    } else if (s.kind === "precondition") {
      bodyLines.push(
        `            if not (${renderExpr(s.expr, renderCtx)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`,
      );
    } else if (s.kind === "requires") {
      bodyLines.push(
        `            if not (${renderExpr(s.expr, renderCtx)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`,
      );
    } else if (s.kind === "emit") {
      // Broadcast a domain event — the same `Phoenix.PubSub.broadcast` the
      // regular Ash op body (`render-stmt.ts`) and workflow emit render.  No
      // persistence, so it fits the in-memory generic-action run fn; the
      // per-context Dispatcher consumes it exactly as for a non-returning op.
      const fields = s.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, renderCtx)}`)
        .join(", ");
      bodyLines.push(
        `            Phoenix.PubSub.broadcast(${ctxModule}.PubSub, "events", %${ctxModule}.Events.${upperFirst(s.eventName)}{${fields}})`,
      );
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
  // Bind `_record` when the body never touches the loaded struct (a literal-only
  // return) so `mix compile --warnings-as-errors` doesn't trip on an unused var.
  const recordUsed = [...paramBinds, ...bodyLines].some((l) => /\brecord\b/.test(l));
  const recordPat = recordUsed ? "record" : "_record";
  // A tenancy aggregate's `base_filter expr(... == ^actor(:field))` applies to
  // the `Ash.get` below too, so the load must run with the request actor (DEBT-01).
  // The generic action receives it via the run fn's context; pass it through.
  // Non-tenancy aggregates keep `_context` (unused) so output stays byte-identical.
  const needsActor = aggregateUsesPrincipalContextFilter(agg);
  const contextPat = needsActor ? "context" : "_context";
  const getActorOpt = needsActor ? ", actor: context.actor" : "";
  return `    action :${opSnake}, :term do
${argLines.join("\n")}
      run fn input, ${contextPat} ->
        case Ash.get(__MODULE__, input.arguments.id${getActorOpt}) do
          {:ok, ${recordPat}} ->
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
  // Covers every statement kind the run fn renders so a param used only in a
  // guard / assign still gets its `input.arguments.<p>` bind (else "undefined
  // variable").
  // An `emit` references params/this-props through its field value exprs —
  // serialise them all so a param used only in an emit keeps its bind.
  if (s.kind === "emit") {
    return s.fields.some((f) => JSON.stringify(f.value).includes(`"${name}"`));
  }
  const expr =
    s.kind === "let"
      ? s.expr
      : s.kind === "return"
        ? s.value
        : s.kind === "assign"
          ? s.value
          : s.kind === "precondition" || s.kind === "requires"
            ? s.expr
            : undefined;
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
  // A tenancy aggregate threads the request actor into the generic action so
  // its `Ash.get` (under the `^actor(:field)` base_filter) resolves (DEBT-01).
  const actorOpt = aggregateUsesPrincipalContextFilter(agg)
    ? ", actor: conn.assigns.current_user"
    : "";
  const callArgs = ["id", ...paramReads].join(", ") + actorOpt;
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
        ${webModule}.ProblemDetails.problem_response(conn, 404, "Not Found", "${aggPascal} not found")

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
