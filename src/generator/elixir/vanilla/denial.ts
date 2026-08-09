// The Phoenix backend's TYPED DENIAL protocol — one place that owns the term a
// failed `requires` / `precondition` short-circuits to, and the controller
// clause that turns it into an RFC 7807 response.
//
// Why it exists.  A guard denial used to be a bare atom (`{:error, :forbidden}`
// / `{:error, :precondition_failed}`), which carried the STATUS but not the
// MESSAGE — so every controller answered with a hardcoded generic string
// ("A precondition failed"), while node/dotnet/java/python all name the failed
// predicate ("Precondition failed: status != \"cancelled\"").  RFC 7807 wants
// `detail` specific to the OCCURRENCE, and the M-T9.11 wire-golden gate can't
// carry an error-envelope assertion while one backend's `detail` is generic
// (the golden is byte-exact — a waiver would only park the divergence).
//
// So a denial is now a 2-TUPLE — `{:precondition_failed, "<message>"}` — and
// the reason term flows through `{:error, reason}` catch-alls exactly as the
// bare atom did.  The message is built by the SAME rule the other four
// backends use (`renderStatement`'s `raise(ArgumentError, …)` path here, and
// the `DomainError`/`DomainException` throws there): an explicit `message:` if
// the statement declares one, else the derived `"<Prefix>: <source>"`.
//
// Every producer (`operation-returns-emit`, `eventsourced-emit`,
// `workflow-execution-emit`, `workflow-eventsourced-emit`, `dispatch-emit`) and
// every consumer (`api-emit`, `explicit-handlers-emit`, and the two
// `respond/2` renderers) goes through this module, so the two halves cannot
// drift into a shape the other doesn't match — which would silently fall to the
// unrecognised-term arm and answer a sanitized 500.
//
// Statuses are RS-15's ladder — `when` → 409, `requires` → 403,
// `precondition` → 422, plus `NotFound` → 404 — but NONE of them is a literal
// here any more (M-T5.20).  Every rung resolves through `resolveErrorStatus`
// against the api's `httpStatus <Error> -> <Code>` map, the same call shape the
// structural-conflict rungs already used, so a remap moves the runtime arm and
// the OpenAPI declaration together and no rung is silently un-overridable.

import type { StmtIR, WorkflowStmtIR } from "../../../ir/types/loom-ir.js";
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { errorTitle, resolveErrorStatus } from "../../../util/error-defaults.js";

type GuardStmt = Extract<StmtIR | WorkflowStmtIR, { kind: "requires" | "precondition" }>;

/** The per-api `httpStatus <Error> -> <Code>` map, folded app-wide by
 *  `enrichLoomModel` and carried on every context / system IR as
 *  `structuralErrorStatuses`.  Threaded into every denial site here so a rung's
 *  runtime status is resolved once, in one place. */
export type ErrorStatusMap = Record<string, number> | undefined;

/** The `httpStatus` map a denial site resolves against, assembled from the two
 *  places the IR keeps one:
 *
 *   - `errorStatusOverrides` — the per-subdomain merge of every `httpStatus
 *     <Error> -> <Code>` clause on the apis serving it.  Carries EVERY declared
 *     name, so this is the only place a `httpStatus DomainError -> 400` /
 *     `Forbidden` / `NotFound` remap is visible;
 *   - `structuralErrorStatuses` — the app-wide fold, which by construction only
 *     enumerates the four structural-conflict names (`STRUCTURAL_CONFLICT_ERRORS`).
 *
 *  Structural names come last so the app-global fold stays authoritative for the
 *  four it owns (an app-global handler has no per-context tag to resolve with).
 *  When the shared enrichment fold learns to carry the whole ladder, this
 *  collapses to reading one map — the merge is a no-op either way. */
export function denialOverrides(ctx: {
  errorStatusOverrides?: Record<string, number>;
  structuralErrorStatuses?: Record<string, number>;
}): ErrorStatusMap {
  const merged = { ...ctx.errorStatusOverrides, ...ctx.structuralErrorStatuses };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The four rungs of the denial ladder and the stdlib `error` NAME each resolves
 *  through.  Naming them is what makes the ladder remappable: `httpStatus
 *  DomainError -> 400` moves the domain floor exactly the way `httpStatus
 *  Disallowed -> 422` already moved the state gate (M-T5.20). */
export type DenialRung = "forbidden" | "precondition" | "disallowed" | "notFound";

const RUNG_ERROR_NAME: Readonly<Record<DenialRung, string>> = {
  forbidden: "Forbidden", // a `requires` authorization gate denied  → 403
  precondition: "DomainError", // the DOMAIN FLOOR: a `precondition` / domain fault → 422
  disallowed: "Disallowed", // a `when` state gate refused          → 409
  notFound: "NotFound", // the record isn't there                → 404
};

/** The resolved HTTP status for a denial rung — the api's `httpStatus` override
 *  if the author declared one, else the `STDLIB_ERROR_STATUS` default.  The same
 *  call shape the structural-conflict rungs (`ReferencedInUse`, …) already use,
 *  so no rung of the ladder is a hardcoded literal any more. */
export function denialStatus(rung: DenialRung, overrides?: ErrorStatusMap): number {
  return resolveErrorStatus(RUNG_ERROR_NAME[rung], overrides);
}

/** The RFC 7807 `title` for a denial rung, derived so it can never disagree with
 *  the status next to it (elixir shipped a "Precondition Failed" title against a
 *  422 status until #2300 — exactly the drift a hardcoded pair invites).
 *
 *  Two derivations, because the ladder genuinely has two kinds of rung:
 *   - the NAMED rungs (`Disallowed` / `Forbidden` / `NotFound`) title on the
 *     error NAME humanised, matching java's `problem(disallowedStatus,
 *     "Disallowed", …)` — the name is the stable identity, the status is the
 *     remappable projection of it;
 *   - the DOMAIN FLOOR has no error name on the wire (its title has always been
 *     the status reason phrase, "Unprocessable Entity" on all five backends), so
 *     it titles on the RESOLVED status — `httpStatus DomainError -> 400` moves
 *     the title to "Bad Request" alongside it. */
export function denialTitle(rung: DenialRung, overrides?: ErrorStatusMap): string {
  return rung === "precondition"
    ? problemTitle(denialStatus(rung, overrides))
    : errorTitle(RUNG_ERROR_NAME[rung]);
}

/** A whole `ProblemDetails.problem_response(conn, <status>, <title>, <detail>)`
 *  call for one rung — the single place a denial's status/title pair is spelled,
 *  so a call site can't half-resolve one of them.  `detailExpr` is emitted
 *  VERBATIM (an Elixir expression: a bound `detail` variable, `guard_msg`, or an
 *  already-quoted literal).  `problemModule` lets a call site that hasn't
 *  `alias`d the module spell it fully (`<App>Web.ProblemDetails`). */
export function denialResponse(
  rung: DenialRung,
  detailExpr: string,
  overrides?: ErrorStatusMap,
  problemModule = "ProblemDetails",
): string {
  return `${problemModule}.problem_response(conn, ${denialStatus(rung, overrides)}, ${JSON.stringify(
    denialTitle(rung, overrides),
  )}, ${detailExpr})`;
}

/** The sanitized catch-all for an UNRECOGNISED `{:error, reason}` term (M-T6.24).
 *  An error term no denial clause matched is a fault the server did not model —
 *  a 500, not a 400 — and its `detail` is the fixed string `"internal"`, never
 *  `inspect(reason)`: inspecting renders struct names / module paths / raw
 *  internal state into a public response body.  Byte-identical to the other four
 *  backends' unhandled-fault arm. */
export function internalFallbackResponse(): string {
  return `ProblemDetails.problem_response(conn, 500, "Internal Server Error", "internal")`;
}

/** The human message a denial carries — identical to the string the other four
 *  backends put in their thrown `ForbiddenError` / `DomainError`, so the
 *  ProblemDetails `detail` is byte-identical cross-backend. */
export function denialMessage(s: GuardStmt): string {
  if (s.kind === "requires") return `Forbidden: ${s.source}`;
  return s.message ? s.message.text : `Precondition failed: ${s.source}`;
}

/** The Elixir reason TERM a failed guard short-circuits to:
 *  `{:forbidden, "Forbidden: …"}` / `{:precondition_failed, "Precondition
 *  failed: …"}`.  Rendered into `ensure(<cond>, <term>)` and into the inline
 *  `if …, do: :ok, else: {:error, <term>}` workflow form alike. */
export function denialTerm(s: GuardStmt): string {
  const tag = s.kind === "requires" ? ":forbidden" : ":precondition_failed";
  return `{${tag}, ${JSON.stringify(denialMessage(s))}}`;
}

/** The two ProblemDetails clauses a controller needs to answer a typed denial,
 *  as `<head>` / `<body>` pairs so each call site can wrap them in its own
 *  `def respond(conn, …)` / `def <op>_<agg>_result(conn, …)` shape.
 *
 *  `detail` is bound from the tuple, so the response names the predicate that
 *  actually failed rather than a fixed sentence. */
export function denialClause(
  kind: "forbidden" | "precondition",
  fnName = "respond",
  overrides?: ErrorStatusMap,
): { readonly head: string; readonly body: string } {
  const tag = kind === "forbidden" ? ":forbidden" : ":precondition_failed";
  return {
    head: `def ${fnName}(conn, {:error, {${tag}, detail}})`,
    body: denialResponse(kind, "detail", overrides),
  };
}

/** Both denial clauses rendered as a `def …,\n    do: …` pair, the shape the
 *  `respond/2` renderers in `explicit-handlers-emit` / `workflow-execution-emit`
 *  splice inline.  `indent` prefixes each `def` (the controller bodies emit at
 *  column 2 in some renderers and 0 in others). */
export function denialResponders(
  fnName = "respond",
  indent = "",
  overrides?: ErrorStatusMap,
): string {
  return (["forbidden", "precondition"] as const)
    .map((k) => {
      const { head, body } = denialClause(k, fnName, overrides);
      return `${indent}${head},\n${indent}  do: ${body}`;
    })
    .join("\n\n");
}

/** The shared ERROR TAIL of a `respond/2` dispatcher: the `:not_found` arm, both
 *  typed-denial arms, and the sanitized unrecognised-term catch-all — in that
 *  order (the catch-all must stay LAST or Elixir 1.18 flags every clause after
 *  it as unreachable under `--warnings-as-errors`).
 *
 *  The catch-all binds `_reason`, not `reason`: nothing reads the term any more
 *  (see `internalFallbackResponse`), and an unused plain binding is itself a
 *  `--warnings-as-errors` failure. */
export function respondErrorTail(
  fnName = "respond",
  indent = "  ",
  overrides?: ErrorStatusMap,
): string {
  const clause = (head: string, body: string): string =>
    `${indent}${head},\n${indent}  do: ${body}`;
  return [
    clause(
      `def ${fnName}(conn, {:error, :not_found})`,
      denialResponse("notFound", '"Resource not found"', overrides),
    ),
    denialResponders(fnName, indent, overrides),
    clause(`def ${fnName}(conn, {:error, _reason})`, internalFallbackResponse()),
  ].join("\n\n");
}

/** The `when` STATE-GATE rung of the same ladder (RS-17).  A `when`-gated
 *  operation invoked in a state its predicate refuses answers 409 with title
 *  "Disallowed" and a detail naming the operation and aggregate — byte-identical
 *  to node/.NET/Java/Python's `DisallowedException(...)` message.
 *
 *  Same shape and same reason as the guard rungs above: the bare `:disallowed`
 *  atom carried the status but not the message, so the controller answered a
 *  fixed sentence ("Operation not allowed in the current state") where the other
 *  four name the occurrence.  Carrying the message in the tuple also dissolves
 *  what looked like the hard part — the event-sourced `command_error/2` clause is
 *  SHARED across every command of an aggregate and so has no `op` in scope, but
 *  it never needs one: the PRODUCER has `op`, and the consumer just binds the
 *  detail. */
export function disallowedMessage(aggName: string, opName: string): string {
  return `operation '${opName}' is not allowed in the current state of ${aggName}.`;
}

/** `{:disallowed, "operation '…' is not allowed …"}` — the reason term a failed
 *  `when` gate short-circuits to. */
export function disallowedTerm(aggName: string, opName: string): string {
  return `{:disallowed, ${JSON.stringify(disallowedMessage(aggName, opName))}}`;
}

/** The state-gate consumer half — `ProblemDetails.problem_response(conn,
 *  <Disallowed status>, "Disallowed", detail)`.  Status resolves through the
 *  same `httpStatus` map as its sibling rungs; the title stays the error NAME
 *  (matching java's `problem(disallowedStatus, "Disallowed", …)`) so a remap
 *  can't turn the wire's error identity into a bare reason phrase. */
export function disallowedResponse(
  detailExpr = "detail",
  overrides?: ErrorStatusMap,
  problemModule = "ProblemDetails",
): string {
  return denialResponse("disallowed", detailExpr, overrides, problemModule);
}
