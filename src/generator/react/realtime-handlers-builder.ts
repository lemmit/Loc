// RealtimeHandlers — the live-event handler component (channels.md Part I).
//
// `on <channelParam>.<Event>(e) { toast(…) }` ui members render into one
// `src/components/RealtimeHandlers.tsx`: a renderless component that
// subscribes to the realtime SSE client (`src/api/realtime.ts`) on mount
// and dispatches each arriving event through a `switch (event.type)` to
// its handler's toast call.  The switch arms + toast imports come from
// the shared `_frontend/realtime.ts` core (the SvelteKit frontend reuses
// them); the toast invocation is pack-shaped — each
// design pack ships a `realtime-toast` micro-template (and declares the
// matching import under `imports["realtime-toast"]`); chakra v2's
// hook-based toast additionally ships a `realtime-toast-setup` line
// rendered inside the component body.
//
// The message expression is the validator-bounded v1 subset
// (`loom.ui-handler-unsupported` admits only `toast(<expr>)`): literals,
// the event binding, single-level member access off it, and operators.
// Anything deeper fails loud here rather than emitting broken TSX.

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import {
  buildRealtimeSwitchCases,
  realtimeNeedsQueryClient,
  toastImports,
} from "../_frontend/realtime.js";
import type { LoadedPack } from "../_packs/loader.js";

/** Render `src/components/RealtimeHandlers.tsx` for a ui with at least
 *  one `on` handler.  Caller gates on `ui.notifications?.length`. */
export function buildRealtimeHandlers(ui: UiIR, pack: LoadedPack): string {
  const importLines = toastImports(pack);
  const setup = pack.templates.has("realtime-toast-setup")
    ? pack.render("realtime-toast-setup", {}).trim()
    : null;
  const cases = buildRealtimeSwitchCases(ui, pack, "        ");
  // A `refetch(<Agg>)` handler needs the react-query client — invalidation
  // mirrors the mutation `onSuccess` path.  Toast-only uis skip it.
  const needsQc = realtimeNeedsQueryClient(ui);

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    "// Live-event handlers (channels.md Part I): each `on <channel>.<Event>`",
    "// declared on the ui renders the arriving event as a toast and/or",
    "// refetches an aggregate's queries.  Renderless; mounted once at the App",
    "// root.  The authorized read stays the gate — event payloads carry no",
    "// privilege.",
    'import { useEffect } from "react";',
    ...(needsQc ? ['import { useQueryClient } from "@tanstack/react-query";'] : []),
    'import { subscribeRealtime } from "../api/realtime";',
    ...importLines,
    "",
    "export function RealtimeHandlers(): null {",
    ...(needsQc ? ["  const qc = useQueryClient();"] : []),
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
