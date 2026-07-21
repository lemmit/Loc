// Realtime SSE consumption — Feliz (F#/Fable/Elmish) flavour (channels.md
// Part I).
//
// `on <channelParam>.<Event>(e) { toast(…) refetch(<Agg>) }` ui members
// render into a self-contained Elmish subscription appended to `App.fs`:
// one browser `EventSource` against `/api/realtime/events`, an
// `addEventListener` per carried event type, and — per handler — a
// transient built-in toast (a fixed-position DOM host, no pack toast
// infra) plus a re-fetch of the affected aggregate's list read.
//
// The re-fetch reuses the app's EXISTING read wiring: the handler issues
// the same `Api.<all><Agg>` async the `init` fires and dispatches the same
// `<All><Agg>Loaded` Msg the update arm already lands — so no new Msg case,
// update arm, or Model field is minted (the refetch targets are folded into
// the ui's read set by the caller, exactly like foreign-key idselect
// targets).  Broadcast is at-most-once and untrusted (the authorized read
// stays the gate), so the handler re-fetches through the Api rather than
// trusting the frame body.
//
// The toast message is the validator-bounded v1 subset
// (`loom.ui-handler-unsupported` admits only `toast(<expr>)`): literals,
// the event binding, single-level member access off it, and operators.
// Anything deeper fails loud here rather than emitting broken F#.

import type { ExprIR, UiIR, UiNotificationIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { felizAllRead } from "./wire.js";

// A single self-contained JS toast: append a transient message element to a
// fixed-position host in document.body (created on first use), auto-removed
// after 4s.  Uses only single quotes so it nests inside the F# `[<Emit("…")>]`
// string without escaping.
const TOAST_EMIT_JS =
  "(function(m){var h=document.getElementById('loom-toast-host');" +
  "if(!h){h=document.createElement('div');h.id='loom-toast-host';" +
  "h.setAttribute('data-testid','channel-toast-host');" +
  "h.style.cssText='position:fixed;bottom:16px;right:16px;z-index:3000;" +
  "display:flex;flex-direction:column;gap:8px';document.body.appendChild(h);}" +
  "var e=document.createElement('div');e.className='loom-toast';" +
  "e.setAttribute('role','status');e.setAttribute('data-testid','channel-toast');" +
  "e.textContent=m;h.appendChild(e);setTimeout(function(){e.remove();},4000);})($0)";

/** The distinct aggregates a ui's `on` handlers `refetch(<Agg>)` — folded
 *  into the ui's read set by the caller so the `Api.<all>`/`<All>Loaded`/
 *  Model wiring the subscription re-issues is emitted. */
export function felizRealtimeRefetchAggregates(ui: UiIR): string[] {
  const out = new Set<string>();
  for (const n of ui.notifications ?? []) for (const r of n.refetches ?? []) out.add(r.aggregate);
  return [...out].sort();
}

/** True when the ui has at least one live-event handler — the emit gate the
 *  caller combines with the backend actually serving the SSE wire. */
export function felizHasRealtimeHandlers(ui: UiIR): boolean {
  return (ui.notifications?.length ?? 0) > 0;
}

/** The realtime subscription module (helpers + `realtimeSub`), spliced into
 *  `App.fs` after `update` (it references `Msg`/`Api`/the reads' `Loaded`
 *  cases) and wired via `Program.withSubscription realtimeSub`. */
export function renderFelizRealtime(ui: UiIR): string {
  const notifications = ui.notifications ?? [];
  const byEvent = new Map<string, UiNotificationIR[]>();
  for (const n of notifications) {
    const list = byEvent.get(n.eventType) ?? [];
    list.push(n);
    byEvent.set(n.eventType, list);
  }

  const handlerLines: string[] = [];
  for (const [eventType, handlers] of [...byEvent.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // A payload decode is emitted only when a toast reads a field off the
    // event binding (a pure-literal / refetch-only handler needs no parse).
    const needsPayload = handlers.some((h) => h.toasts.some((t) => exprReadsBinding(t, h.bind)));
    // The `es?addEventListener(…)` statement aligns with `let es` (4 cols),
    // its lambda body one step in (6), the nested async one more (8) — F#'s
    // offside rule rejects any other alignment.
    handlerLines.push(`    es?addEventListener(${JSON.stringify(eventType)}, fun (m: obj) ->`);
    if (needsPayload) {
      handlerLines.push("      let payload = Fable.Core.JS.JSON.parse (unbox (m?data))");
    }
    for (const h of handlers) {
      for (const toast of h.toasts) {
        handlerLines.push(`      showToast (${renderFsToastMessage(toast, h.bind)})`);
      }
    }
    // One re-fetch per distinct aggregate across this event's handlers.
    const seen = new Set<string>();
    for (const h of handlers) {
      for (const r of h.refetches ?? []) {
        if (seen.has(r.aggregate)) continue;
        seen.add(r.aggregate);
        const read = felizAllRead(r.aggregate);
        handlerLines.push("      Async.StartImmediate(async {");
        handlerLines.push(`        let! result = Api.${read.apiFn} ()`);
        handlerLines.push(`        dispatch (${read.msgCase} result) })`);
      }
    }
    handlerLines.push("    ) |> ignore");
  }

  return lines(
    "// Realtime SSE subscription (channels.md Part I) — one EventSource against",
    "// /api/realtime/events, dispatching per carried event type: a transient",
    "// built-in toast + a re-fetch of the affected aggregate's list read.  The",
    "// broadcast frame is untrusted (at-most-once); the authorized read stays the",
    "// gate, so the handler re-fetches through the Api rather than trusting it.",
    `[<Fable.Core.Emit("${TOAST_EMIT_JS}")>]`,
    "let private showToast (message: string) : unit = jsNative",
    "",
    '[<Fable.Core.Emit("new EventSource($0)")>]',
    "let private createEventSource (url: string) : obj = jsNative",
    "",
    "let private realtimeSub (_: Model) : Sub<Msg> =",
    "  let start (dispatch: Msg -> unit) : System.IDisposable =",
    '    let es = createEventSource "/api/realtime/events"',
    ...handlerLines,
    "    { new System.IDisposable with member _.Dispose() = es?close() |> ignore }",
    '  [ [ "realtime" ], start ]',
  );
}

/** True when a v1 toast expression reads the event binding (bare or via a
 *  member) — gates the `payload` decode. */
function exprReadsBinding(e: ExprIR, bind: string): boolean {
  switch (e.kind) {
    case "ref":
      return e.name === bind;
    case "member":
      return exprReadsBinding(e.receiver, bind);
    case "paren":
      return exprReadsBinding(e.inner, bind);
    case "binary":
      return exprReadsBinding(e.left, bind) || exprReadsBinding(e.right, bind);
    default:
      return false;
  }
}

/** Render the v1 toast-message subset to an F# string expression.  The
 *  event binding decodes to `payload` (a Thoth-free `JSON.parse` obj);
 *  member access reads a field dynamically (`payload?<member>`) and every
 *  leaf is `string`-coerced so binary `+` stays a string concatenation. */
function renderFsToastMessage(e: ExprIR, bind: string): string {
  switch (e.kind) {
    case "literal":
      // A string literal renders verbatim (F# and JSON share `"…"` escaping
      // for the ASCII subset the DSL admits); a non-string literal is
      // string-coerced so it concatenates.
      return e.lit === "string" ? JSON.stringify(e.value) : `(string ${e.value})`;
    case "ref":
      if (e.name === bind) return "(string payload)";
      throw new Error(
        `Feliz realtime: unsupported name '${e.name}' in toast message (only the event binding '${bind}' is in scope).`,
      );
    case "member": {
      if (e.receiver.kind !== "ref" || e.receiver.name !== bind) {
        throw new Error(
          "Feliz realtime: toast messages support single-level member access off the event binding only.",
        );
      }
      return `(string (payload?${e.member}))`;
    }
    case "paren":
      return `(${renderFsToastMessage(e.inner, bind)})`;
    case "binary":
      return `${renderFsToastMessage(e.left, bind)} ${e.op} ${renderFsToastMessage(e.right, bind)}`;
    default:
      throw new Error(`Feliz realtime: unsupported expression kind '${e.kind}' in toast message.`);
  }
}
