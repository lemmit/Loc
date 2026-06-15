// ---------------------------------------------------------------------------
// Vanilla operation `or`-union returns — exception-less.md (A3), global plan
// T2.c.  An `operation foo(): Success or NotFound { return NotFound { … } }`
// produces a tagged result the controller translates to HTTP: a success → 200
// with the wire body, an error variant → an RFC-7807 ProblemDetails at the
// variant's mapped status (`errorStatusOverrides[tag] ?? defaultErrorStatus`).
//
// Vanilla's natural carrier is a tagged tuple — the context function returns
// `{:ok, value} | {:error, <tag>, data_map}`, and the controller `case`s on it.
// No per-variant struct module is needed (the data rides as a plain map, the
// same RFC-7807 §3.2 extension shape the other backends emit).  `foundation:
// ash` stays gated; only `vanilla` un-gates (`validateOperationReturnsUnimplemented`).
// ---------------------------------------------------------------------------

import { variantTag } from "../../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  BoundedContextIR,
  OperationIR,
  StmtIR,
} from "../../../ir/types/loom-ir.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";

/** An operation that declares an `or`-union return type (exception-less). */
export function isReturningOperation(op: OperationIR): boolean {
  return !!op.returnType;
}

/** Does this aggregate have any public returning operation (→ the controller
 *  needs the shared `problem_variant/5` responder)? */
export function aggregateHasReturningOp(agg: AggregateIR): boolean {
  return agg.operations.some((op) => op.visibility === "public" && isReturningOperation(op));
}

/** A return variant is an *error* iff it names a `kind: "error"` payload in
 *  this context; the other (success) variant is the aggregate itself. */
function isErrorTag(tag: string, ctx: BoundedContextIR): boolean {
  return ctx.payloads.some((p) => p.name === tag && p.kind === "error");
}

/** The error variants of a returning op, with their resolved HTTP status. */
export function errorVariantsOf(
  op: OperationIR,
  ctx: BoundedContextIR,
): Array<{ tag: string; status: number; type: string; title: string }> {
  if (op.returnType?.kind !== "union") return [];
  return op.returnType.variants
    .map((v) => variantTag(v))
    .filter((tag) => isErrorTag(tag, ctx))
    .map((tag) => ({
      tag,
      status: ctx.errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag),
      type: errorTypeUri(tag),
      title: errorTitle(tag),
    }));
}

// ---------------------------------------------------------------------------
// Context function — runs the body, returns the tagged result.
// ---------------------------------------------------------------------------

/** `<op>_<agg>(record, params) :: {:ok, term()} | {:error, binary(), map()}`. */
export function renderReturningOpFunction(
  facadeMod: string,
  ctx: BoundedContextIR,
  agg: AggregateIR,
  op: OperationIR,
): string {
  const aggPascal = upperFirst(agg.name);
  const aggModule = `${facadeMod}.${aggPascal}`;
  const opSnake = snake(op.name);
  const aggSnake = snake(agg.name);
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: facadeMod,
    foundation: "vanilla",
  };

  // The `params` arg is always referenced by the `when is_map(params)` guard,
  // so it never trips the unused-variable check even when the op has no params
  // (an underscore-prefixed name used in a guard would itself warn).
  const paramReads = op.params.map(
    (p) => `    ${snake(p.name)} = Map.get(params, ${JSON.stringify(p.name)})`,
  );
  const bodyLines = op.statements.map((s) => renderReturningStmt(s, ctx, renderCtx));
  const body = [...paramReads, ...bodyLines].join("\n");

  return `  @doc "Returning operation \`${op.name}\` on \`${aggPascal}\` (exception-less)."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, term()} | {:error, binary(), map()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params) when is_map(params) do
${body}
  end`;
}

/** A statement in a returning-op body.  `return` is the terminal tagged tuple;
 *  `let` binds a local; anything else (precondition/emit/assign) is a v1 gap —
 *  the cross-backend fixtures are return-only — emitted as a TODO so the module
 *  still compiles. */
function renderReturningStmt(s: StmtIR, ctx: BoundedContextIR, rc: RenderCtx): string {
  switch (s.kind) {
    case "return": {
      const value = renderExpr(s.value, rc);
      if (s.variantTag && isErrorTag(s.variantTag, ctx)) {
        // Error variant → `{:error, "<tag>", <fields-map>}`.  A record value
        // renders to an Elixir map already; wrap a non-map value defensively.
        const data = s.value.kind === "object" ? value : `%{value: ${value}}`;
        return `    {:error, ${JSON.stringify(s.variantTag)}, ${data}}`;
      }
      return `    {:ok, ${value}}`;
    }
    case "let":
      return `    ${snake(s.name)} = ${renderExpr(s.expr, rc)}`;
    case "expression":
      return `    _ = ${renderExpr(s.expr, rc)}`;
    default:
      return `    # TODO(exception-less): unsupported returning-op statement '${s.kind}'`;
  }
}

// ---------------------------------------------------------------------------
// Controller action — case over the tagged result.
// ---------------------------------------------------------------------------

/** The `POST /<plural>/:id/<op>` member action for a returning operation:
 *  load the aggregate, run the op, then translate the tagged result — a success
 *  to 200 + body, each error variant to its RFC-7807 ProblemDetails status. */
export function renderReturningOpControllerAction(
  ctxModule: string,
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
): string {
  const opSnake = snake(op.name);
  const aggSnake = snake(agg.name);
  const aggPascal = upperFirst(agg.name);
  const errorClauses = errorVariantsOf(op, ctx).map(
    (v) => `        {:error, ${JSON.stringify(v.tag)}, data} ->
          problem_variant(conn, ${v.status}, ${JSON.stringify(v.type)}, ${JSON.stringify(v.title)}, data)`,
  );
  return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id) do
      case ${ctxModule}.${opSnake}_${aggSnake}(record, attrs) do
        {:ok, success} ->
          json(conn, success)

${errorClauses.join("\n\n")}
      end
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end`;
}

/** The shared per-controller responder for an error variant — RFC-7807
 *  envelope + the variant's own fields as §3.2 extension members. */
export function renderProblemVariantHelper(): string {
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
