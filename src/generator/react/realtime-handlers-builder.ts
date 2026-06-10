// RealtimeHandlers — the live-event handler component (channels.md Part I).
//
// `on <channelParam>.<Event>(e) { toast(…) }` ui members render into one
// `src/components/RealtimeHandlers.tsx`: a renderless component that
// subscribes to the realtime SSE client (`src/api/realtime.ts`) on mount
// and dispatches each arriving event through a `switch (event.type)` to
// its handler's toast call.  The toast invocation is pack-shaped — each
// design pack ships a `realtime-toast` micro-template (and declares the
// matching import under `imports["realtime-toast"]`); chakra v2's
// hook-based toast additionally ships a `realtime-toast-setup` line
// rendered inside the component body.
//
// The message expression is the validator-bounded v1 subset
// (`loom.ui-handler-unsupported` admits only `toast(<expr>)`): literals,
// the event binding, single-level member access off it, and operators.
// Anything deeper fails loud here rather than emitting broken TSX.

import type { ExprIR, UiIR, UiNotificationIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import type { LoadedPack } from "../_packs/loader.js";

/** Render `src/components/RealtimeHandlers.tsx` for a ui with at least
 *  one `on` handler.  Caller gates on `ui.notifications?.length`. */
export function buildRealtimeHandlers(ui: UiIR, pack: LoadedPack): string {
  const notifications = ui.notifications ?? [];
  const byEvent = new Map<string, UiNotificationIR[]>();
  for (const n of notifications) {
    const list = byEvent.get(n.eventType) ?? [];
    list.push(n);
    byEvent.set(n.eventType, list);
  }

  const importLines = toastImports(pack);
  const setup = pack.templates.has("realtime-toast-setup")
    ? pack.render("realtime-toast-setup", {}).trim()
    : null;

  const cases: string[] = [];
  for (const [eventType, handlers] of [...byEvent.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    cases.push(`        case ${JSON.stringify(eventType)}:`);
    for (const n of handlers) {
      for (const msg of n.toasts) {
        const message = renderMessageExpr(msg, n.bind);
        cases.push(`          ${pack.render("realtime-toast", { message }).trim()}`);
      }
    }
    cases.push("          break;");
  }

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    "// Live-event handlers (channels.md Part I): each `on <channel>.<Event>`",
    "// declared on the ui renders the arriving event as a toast.  Renderless;",
    "// mounted once at the App root.  The authorized read stays the gate —",
    "// event payloads carry no privilege.",
    'import { useEffect } from "react";',
    'import { subscribeRealtime } from "../api/realtime";',
    ...importLines,
    "",
    "export function RealtimeHandlers(): null {",
    ...(setup ? [`  ${setup}`] : []),
    // The toast closure (chakra v2's hook-returned `toast`) is reference-
    // stable per provider; subscribing once on mount is the contract.
    "  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once on mount; the pack toast fn is reference-stable",
    "  useEffect(() => {",
    "    return subscribeRealtime((event) => {",
    "      switch (event.type) {",
    ...cases,
    "      }",
    "    });",
    "  }, []);",
    "  return null;",
    "}",
    "",
  );
}

/** Import lines the pack's `realtime-toast` template needs, from the
 *  manifest's `imports["realtime-toast"]` declarations. */
function toastImports(pack: LoadedPack): string[] {
  const specs = pack.manifest.imports?.["realtime-toast"] ?? [];
  return specs.map((s) => `import { ${s.named.join(", ")} } from ${JSON.stringify(s.from)};`);
}

/** Render the v1 message-expression subset to TSX.  `bind` reads as the
 *  raw wire event; member access off it is `String(...)`-wrapped so the
 *  `Record<string, unknown>` field concatenates cleanly. */
function renderMessageExpr(e: ExprIR, bind: string): string {
  switch (e.kind) {
    case "literal":
      return e.lit === "string" ? JSON.stringify(e.value) : e.value;
    case "ref":
      if (e.name === bind) return "event";
      throw new Error(
        `RealtimeHandlers: unsupported name '${e.name}' in toast message (only the event binding '${bind}' is in scope).`,
      );
    case "member": {
      if (e.receiver.kind !== "ref" || e.receiver.name !== bind) {
        throw new Error(
          "RealtimeHandlers: toast messages support single-level member access off the event binding only.",
        );
      }
      // The wire event is `{ type: string } & Record<string, unknown>` —
      // String()-wrap so the field concatenates / interpolates cleanly.
      return `String(event.${e.member} ?? "")`;
    }
    case "paren":
      return `(${renderMessageExpr(e.inner, bind)})`;
    case "binary":
      return `${renderMessageExpr(e.left, bind)} ${e.op} ${renderMessageExpr(e.right, bind)}`;
    default:
      throw new Error(
        `RealtimeHandlers: unsupported expression kind '${e.kind}' in toast message.`,
      );
  }
}
