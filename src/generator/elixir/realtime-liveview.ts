// Realtime LiveView wire — Phoenix's native realtime path (channels.md
// Part I, "The Phoenix path").
//
// Unlike the SPA frontends (which need an EventSource client against the
// backend's `GET /realtime/events` SSE endpoint), a LiveView process does
// realtime natively: it `Phoenix.PubSub.subscribe`s to the topic the domain
// `emit`s already broadcast on, and receives each event as a `handle_info`
// message — collapsing the SSE relay to a single in-process hop.  No SSE
// client, no HTTP endpoint.
//
// The topic is the SAME `"events"` topic every domain `emit` broadcasts on
// (`Phoenix.PubSub.broadcast(<App>.PubSub, "events", %<Ctx>.Events.<E>{…})`,
// see `workflow-execution-emit.ts` / `operation-returns-emit.ts`).  The
// reactor/saga choreography path does NOT ride PubSub — it calls
// `<Ctx>.Dispatcher.dispatch/1` directly at the emit site — so this topic
// currently has no subscribers and adding a LiveView one is purely additive:
// it cannot alter choreography delivery (the message shape + topic semantics
// the existing tests pin are untouched).
//
// The toast message expression is the validator-bounded v1 subset
// (`loom.ui-handler-unsupported` admits only `toast(<expr>)`): literals, the
// event binding, single-level member access off it, and operators.  Anything
// deeper fails loud here rather than emitting broken Elixir — the Elixir twin
// of `renderMessageExpr` in `src/generator/_frontend/realtime.ts`.

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { snake } from "../../util/naming.js";

/** The PubSub topic every domain `emit` broadcasts on.  A realtime LiveView
 *  subscribes to it; the choreography path uses direct `Dispatcher.dispatch/1`
 *  calls (never this topic), so subscribing here cannot affect reactor/saga
 *  delivery. */
export const REALTIME_TOPIC = "events";

/** True when `e` reads the handler's event binding — so the `handle_info`
 *  head must capture the broadcast struct (`%…{} = e`) rather than discard it
 *  (`%…{}`), which would otherwise trip `--warnings-as-errors` on an unused
 *  variable when a handler only refetches. */
export function exprUsesBind(e: ExprIR, bind: string): boolean {
  switch (e.kind) {
    case "ref":
      return e.name === bind;
    case "member":
      return exprUsesBind(e.receiver, bind);
    case "paren":
      return exprUsesBind(e.inner, bind);
    case "binary":
      return exprUsesBind(e.left, bind) || exprUsesBind(e.right, bind);
    default:
      return false;
  }
}

/** Render the v1 toast message-expression subset to Elixir — the twin of the
 *  frontends' `renderMessageExpr` (`_frontend/realtime.ts`).  `bind` reads as
 *  the captured broadcast struct; member access off it (`e.orderId`) becomes
 *  `to_string(e.order_id)` so a non-string struct field concatenates / renders
 *  as flash copy cleanly. */
export function renderMessageExprElixir(e: ExprIR, bind: string): string {
  const bindVar = snake(bind);
  const go = (x: ExprIR): string => {
    switch (x.kind) {
      case "literal":
        // A string literal re-quotes with JSON.stringify (valid Elixir string
        // syntax); numeric/bool literals carry their source text verbatim.
        return x.lit === "string" ? JSON.stringify(x.value) : String(x.value);
      case "ref":
        if (x.name === bind) return bindVar;
        throw new Error(
          `realtime handle_info: unsupported name '${x.name}' in toast message (only the event binding '${bind}' is in scope).`,
        );
      case "member": {
        if (x.receiver.kind !== "ref" || x.receiver.name !== bind) {
          throw new Error(
            "realtime handle_info: toast messages support single-level member access off the event binding only.",
          );
        }
        // Event struct fields are snake_case; wrap in to_string so a non-string
        // field renders / concatenates as flash copy.
        return `to_string(${bindVar}.${snake(x.member)})`;
      }
      case "paren":
        return `(${go(x.inner)})`;
      case "binary":
        // Toast messages are strings, so a `+` between parts is Elixir string
        // concatenation (`<>`); any other operator passes through verbatim.
        return `${go(x.left)} ${x.op === "+" ? "<>" : x.op} ${go(x.right)}`;
      default:
        throw new Error(
          `realtime handle_info: unsupported expression kind '${x.kind}' in toast message.`,
        );
    }
  };
  return go(e);
}
