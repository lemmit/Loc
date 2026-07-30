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
// generic `{:error, reason}` arm and answer 400 with an `inspect/1` dump.
//
// Statuses are RS-15's ladder: `when` → 409, `requires` → 403,
// `precondition` → 422.

import type { StmtIR, WorkflowStmtIR } from "../../../ir/types/loom-ir.js";

type GuardStmt = Extract<StmtIR | WorkflowStmtIR, { kind: "requires" | "precondition" }>;

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
): { readonly head: string; readonly body: string } {
  const [tag, status, title] =
    kind === "forbidden"
      ? [":forbidden", 403, "Forbidden"]
      : [":precondition_failed", 422, "Unprocessable Entity"];
  return {
    head: `def ${fnName}(conn, {:error, {${tag}, detail}})`,
    body: `ProblemDetails.problem_response(conn, ${status}, ${JSON.stringify(title)}, detail)`,
  };
}

/** Both denial clauses rendered as a `def …,\n    do: …` pair, the shape the
 *  `respond/2` renderers in `explicit-handlers-emit` / `workflow-execution-emit`
 *  splice inline.  `indent` prefixes each `def` (the controller bodies emit at
 *  column 2 in some renderers and 0 in others). */
export function denialResponders(fnName = "respond", indent = ""): string {
  return (["forbidden", "precondition"] as const)
    .map((k) => {
      const { head, body } = denialClause(k, fnName);
      return `${indent}${head},\n${indent}  do: ${body}`;
    })
    .join("\n\n");
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
