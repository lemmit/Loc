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
  ExprIR,
  OperationIR,
  ProvSite,
  StmtIR,
} from "../../../ir/types/loom-ir.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { provColumn } from "./provenance-emit.js";

/** The wire field list a returning op's success branch serialises `record`
 *  into — the same ordered `wireShape` the find/CRUD controllers expose, so the
 *  success body matches what `GET /<plural>/:id` returns for the same aggregate. */
function wireFieldsOf(agg: AggregateIR): string[] {
  return (agg.wireShape ?? []).map((f) => snake(f.name));
}

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

  // Success-path serialisation.  A body that doesn't end in an explicit
  // `return` falls through to its aggregate success variant (`Order` in
  // `Order or NotFound`) — the mutated `record`.  Append the terminal
  // `{:ok, %{…wireShape…}}` so the context fn always returns a wire-ready
  // tagged tuple (the controller just `json`s the map; no struct leaks
  // `__meta__`/`__struct__` onto the wire).
  const lastIsReturn = op.statements[op.statements.length - 1]?.kind === "return";
  const succeedsWithAggregate =
    op.returnType?.kind === "union" &&
    op.returnType.variants.some((v) => v.kind === "entity" && v.name === agg.name);
  const tailLines =
    !lastIsReturn && succeedsWithAggregate
      ? [
          `    {:ok, %{${wireFieldsOf(agg)
            .map((f) => `${f}: record.${f}`)
            .join(", ")}}}`,
        ]
      : [];
  const body = [...paramReads, ...bodyLines, ...tailLines].join("\n");

  return `  @doc "Returning operation \`${op.name}\` on \`${aggPascal}\` (exception-less)."
  @spec ${opSnake}_${aggSnake}(${aggModule}.t(), map()) ::
          {:ok, term()} | {:error, binary(), map()}
  def ${opSnake}_${aggSnake}(%${aggModule}{} = record, params) when is_map(params) do
${body}
  end`;
}

/** A statement in a returning-op body.  `return` is the terminal tagged tuple;
 *  the guard/mutation/emit forms mirror what the other backends render for a
 *  returning op (exception-less.md "Two-regime split"):
 *
 *  - `precondition`/`requires` are bug-shaped guards — they **raise** (the
 *    aggregate-internal 500 / forbidden path), not return a typed error.
 *  - `assign field := value` mutates the threaded `record` struct so the
 *    fall-through success branch serialises the updated aggregate.
 *  - `emit` broadcasts a domain event over `Phoenix.PubSub` (the same form the
 *    vanilla workflow body emits).
 *
 *  `add`/`remove` collection mutations struct-rebind the threaded `record`'s
 *  containment list (jsonb `{:array, :map}`) or arithmetic on a scalar column.
 *  A bare `call` (`f(args)`) lowers to a discarding no-op — vanilla emits no
 *  aggregate-`function` helpers, so there is no callable target, and a bare
 *  call discards its result anyway.  The switch is now exhaustive over
 *  `StmtIR` — there is no `# TODO` fallthrough. */
export function renderReturningStmt(
  s: StmtIR,
  ctx: BoundedContextIR,
  rc: RenderCtx,
  /** Statement position in the body — disambiguates the per-capture temp
   *  vars (`__lin_<i>` / `__prov_inputs_<i>`) when an op has multiple
   *  provenanced writes.  Unused unless `rc.captureProvenance` is set. */
  index = 0,
): string {
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
    case "precondition":
      // Bug-shaped guard → raises (aggregate-internal 500 ProblemDetails).
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Precondition failed: ${s.source}`)})`;
    case "requires":
      // Authorization guard → raises (translated to a forbidden response).
      return `    if not (${renderExpr(s.expr, rc)}), do: raise(ArgumentError, ${JSON.stringify(`Forbidden: ${s.source}`)})`;
    case "assign": {
      // `field := value` → struct-update the threaded `record`, so the
      // fall-through success branch serialises the mutated aggregate.
      const field = snake(s.target.segments[0] ?? "");
      const write = `    record = %{record | ${field}: ${renderExpr(s.value, rc)}}`;
      // A provenanced write (named-op persist path only) wraps the struct
      // update with lineage capture: snapshot the leaf inputs BEFORE the
      // mutation (so a self-referential `x := x + n` records the pre-write
      // value), do the write, build the lineage, route it to the co-located
      // backing column AND the per-process trace buffer (drained in the save
      // transaction).
      if (rc.captureProvenance && s.prov) {
        return renderProvenancedAssign(field, s.prov, s.value, rc, index);
      }
      return write;
    }
    case "add": {
      // `items += Item{...}` (collection) appends to the threaded record's
      // containment list (stored `{:array, :map}` jsonb); a scalar `total += n`
      // (collection:false) is arithmetic on the column.  Both re-bind `record`
      // so the persist step (context-emit) `put_change`s the mutated field.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderExpr(s.value, rc);
      return s.collection
        ? `    record = %{record | ${field}: (record.${field} || []) ++ [${value}]}`
        : `    record = %{record | ${field}: record.${field} + ${value}}`;
    }
    case "remove": {
      // `items -= x` drops the first matching element; scalar `n -= x` subtracts.
      const field = snake(s.target.segments[0] ?? "");
      const value = renderExpr(s.value, rc);
      return s.collection
        ? `    record = %{record | ${field}: List.delete(record.${field} || [], ${value})}`
        : `    record = %{record | ${field}: record.${field} - ${value}}`;
    }
    case "emit": {
      // Broadcast a domain event — same form the vanilla workflow body emits.
      const fields = s.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, rc)}`).join(", ");
      const appModule = rc.contextModule.split(".")[0]!;
      const struct = `%${rc.contextModule}.Events.${upperFirst(s.eventName)}{${fields}}`;
      return `    Phoenix.PubSub.broadcast(${appModule}.PubSub, "events", ${struct})`;
    }
    case "expression":
      return `    _ = ${renderExpr(s.expr, rc)}`;
    case "call": {
      // `f(args)` — a bare call to a domain `function` / private-operation.
      // The vanilla schema module does NOT emit aggregate `function` helpers
      // (unlike the Ash resource, which exposes them as `def <name>(record,…)`),
      // so there is no callable target here.  A bare call discards its result
      // anyway (the value form rides `let`/`assign` instead), so this lowers to
      // a no-op that still threads `record` — keeping the body compilable under
      // `--warnings-as-errors` without referencing an undefined function.  The
      // argument expressions are evaluated for their (pure) side-effect-free
      // value and discarded.
      const args = s.args.map((a) => renderExpr(a, rc));
      const argTuple = args.length ? `{${args.join(", ")}}` : "nil";
      return `    _ = ${argTuple}  # vanilla: bare call to '${s.name}' (no aggregate-function target); record unchanged`;
    }
  }
}

/** Render a provenanced `field := value` write with inline lineage capture.
 *  Mirrors the Hono `withTrace` / .NET `withProvCapture` shape, in Elixir's
 *  immutable struct-rebind idiom. */
function renderProvenancedAssign(
  field: string,
  prov: ProvSite,
  value: ExprIR,
  rc: RenderCtx,
  index: number,
): string {
  const appModule = rc.contextModule.split(".")[0]!;
  // No leading underscore — these are READ after being set, and Elixir's
  // `--warnings-as-errors` flags a used `_`-prefixed var.  The `loom_` prefix
  // avoids collision with any snake-cased param/let local.
  const inputsVar = `loom_prov_inputs_${index}`;
  const linVar = `loom_lineage_${index}`;
  const inputs = collectVanillaLeaves(value, rc)
    .map((l) => `%{path: ${JSON.stringify(l.path)}, value: ${l.value}}`)
    .join(", ");
  const targetLit = `%{type: ${JSON.stringify(prov.target.type)}, field: ${JSON.stringify(prov.target.field)}}`;
  return [
    `    ${inputsVar} = [${inputs}]`,
    `    record = %{record | ${field}: ${renderExpr(value, rc)}}`,
    `    ${linVar} = %{snapshot_id: ${JSON.stringify(prov.snapshotId)}, target: ${targetLit}, inputs: ${inputsVar}, computed_value: record.${field}}`,
    `    record = %{record | ${provColumn(field)}: ${linVar}}`,
    `    _ = ${appModule}.Provenance.record(${linVar})`,
  ].join("\n");
}

/** Bounded walk over a provenanced write's RHS collecting leaf inputs — the
 *  `this`-props, params and let-bindings (and member chains rooted at them)
 *  that fed the value, each rendered to its current Elixir value.  Lambdas are
 *  skipped (their bodies reference lambda-local params, not stored leaves).
 *  Elixir sibling of the TS/.NET `collectLeaves`. */
function collectVanillaLeaves(
  e: ExprIR,
  rc: RenderCtx,
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "param" || e.refKind === "let") {
        out.push({ path: e.name, value: renderExpr(e, rc) });
      }
      break;
    case "member":
      out.push({ path: leafPath(e), value: renderExpr(e, rc) });
      break;
    case "method-call":
      collectVanillaLeaves(e.receiver, rc, out);
      for (const a of e.args) collectVanillaLeaves(a, rc, out);
      break;
    case "call":
      for (const a of e.args) collectVanillaLeaves(a, rc, out);
      break;
    case "paren":
      collectVanillaLeaves(e.inner, rc, out);
      break;
    case "unary":
      collectVanillaLeaves(e.operand, rc, out);
      break;
    case "binary":
      collectVanillaLeaves(e.left, rc, out);
      collectVanillaLeaves(e.right, rc, out);
      break;
    case "ternary":
      collectVanillaLeaves(e.cond, rc, out);
      collectVanillaLeaves(e.then, rc, out);
      collectVanillaLeaves(e.otherwise, rc, out);
      break;
  }
  return out;
}

/** Dotted source-side path for a member-access chain (e.g. `line.price`). */
function leafPath(e: ExprIR): string {
  if (e.kind === "ref") return e.name;
  if (e.kind === "this") return "this";
  if (e.kind === "member") return `${leafPath(e.receiver)}.${e.member}`;
  return "<expr>";
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
  // The tagged-result dispatch lives in a dedicated `<op>_<agg>_result/2`
  // helper rather than an inline `case` so Elixir 1.18's type checker can't
  // narrow the scrutinee to the op's exact inferred result (e.g. an op whose
  // body always rejects infers `{:error, …}`-only, which would flag the
  // `{:ok, _}` arm — and vice-versa).  A multi-clause private fn keeps every
  // outcome reachable.
  const resultFn = `${opSnake}_${aggSnake}_result`;
  // Public (not `defp`): Elixir 1.18 infers a private fn's parameter type
  // from its (single) call site, so a `defp` helper would re-trigger an
  // "unused clause" warning for whichever outcome this op's body can't
  // produce.  A public fn keeps the parameter at its full clause domain.
  const resultClauses = [
    `  def ${resultFn}(conn, {:ok, success}), do: json(conn, success)`,
    ...errorVariantsOf(op, ctx).map(
      (v) => `  def ${resultFn}(conn, {:error, ${JSON.stringify(v.tag)}, data}),
    do: problem_variant(conn, ${v.status}, ${JSON.stringify(v.type)}, ${JSON.stringify(v.title)}, data)`,
    ),
  ].join("\n\n");
  return `
  def ${opSnake}(conn, %{"id" => id} = params) do
    attrs = Map.drop(params, ["id"])

    with {:ok, record} <- ${ctxModule}.get_${aggSnake}(id) do
      ${resultFn}(conn, ${ctxModule}.${opSnake}_${aggSnake}(record, attrs))
    else
      {:error, :not_found} ->
        ProblemDetails.not_found_response(conn, "${aggPascal}", id)
    end
  end

${resultClauses}`;
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
