// RealtimeHandlers — the live-event handler component, SvelteKit
// flavour (channels.md Part I).
//
// `on <channelParam>.<Event>(e) { toast(…) }` ui members render into
// one `src/lib/components/RealtimeHandlers.svelte`: a renderless
// component whose `$effect` subscribes to the realtime SSE client
// (`$lib/api/realtime`) and dispatches each arriving event through a
// `switch (event.type)` to its handler's toast call.  The switch arms
// + toast imports come from the shared `_frontend/realtime.ts` core
// (same code the react builder consumes); the toast invocation is
// pack-shaped — each svelte pack ships a `realtime-toast`
// micro-template calling the stack's `$lib/toast.svelte` store.

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import {
  buildRealtimeSwitchCases,
  realtimeNeedsQueryClient,
  toastImports,
} from "../_frontend/realtime.js";
import type { LoadedPack } from "../_packs/loader.js";

/** Render `src/lib/components/RealtimeHandlers.svelte` for a ui with
 *  at least one `on` handler.  Caller gates on
 *  `ui.notifications?.length`. */
export function buildSvelteRealtimeHandlers(ui: UiIR, pack: LoadedPack): string {
  const importLines = toastImports(pack);
  const cases = buildRealtimeSwitchCases(ui, pack, "        ");
  // A `refetch(<Agg>)` handler needs the svelte-query client — invalidation
  // mirrors the mutation `onSuccess` path.  Toast-only uis skip it.
  const needsQc = realtimeNeedsQueryClient(ui);

  return lines(
    "<!-- Auto-generated.  Do not edit by hand. -->",
    '<script lang="ts">',
    "  // Live-event handlers (channels.md Part I): each `on <channel>.<Event>`",
    "  // declared on the ui renders the arriving event as a toast and/or",
    "  // refetches an aggregate's queries.  Renderless; mounted once in the root",
    "  // layout.  The authorized read stays the gate — event payloads carry no",
    "  // privilege.",
    ...(needsQc ? ['  import { useQueryClient } from "@tanstack/svelte-query";'] : []),
    '  import { subscribeRealtime } from "$lib/api/realtime";',
    ...importLines.map((l) => `  ${l}`),
    "",
    ...(needsQc ? ["  const qc = useQueryClient();", ""] : []),
    "  $effect(() => {",
    "    return subscribeRealtime((event) => {",
    "      switch (event.type) {",
    ...cases,
    "      }",
    "    });",
    "  });",
    "</script>",
    "",
  );
}
