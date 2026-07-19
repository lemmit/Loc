// RealtimeHandlers — the live-event handler component, Vue flavour
// (channels.md Part I).
//
// `on <channelParam>.<Event>(e) { toast(…) }` ui members render into
// one `src/components/RealtimeHandlers.vue`: a renderless component
// whose `onMounted` subscribes to the realtime SSE client
// (`src/api/realtime.ts`) and dispatches each arriving event through a
// `switch (event.type)` to its handler's toast call; `onUnmounted`
// closes the stream.  The switch arms + toast imports come from the
// shared `_frontend/realtime.ts` core (the same code the react/svelte
// builders consume); the toast invocation is pack-shaped — each vue
// pack ships a `realtime-toast` micro-template calling the generated
// `src/lib/toast.ts` queue (`pushToast`).

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import {
  buildRealtimeSwitchCases,
  realtimeNeedsQueryClient,
  toastImports,
} from "../_frontend/realtime.js";
import type { LoadedPack } from "../_packs/loader.js";

/** Render `src/components/RealtimeHandlers.vue` for a ui with at least
 *  one `on` handler.  Caller gates on `ui.notifications?.length`. */
export function buildVueRealtimeHandlers(ui: UiIR, pack: LoadedPack): string {
  const importLines = toastImports(pack);
  // The switch nests onMounted → subscribeRealtime callback → switch,
  // so the `case` keyword sits eight columns in (matches the react /
  // svelte indent the shared builder expects).
  const cases = buildRealtimeSwitchCases(ui, pack, "        ");
  // A `refetch(<Agg>)` handler needs the vue-query client — invalidation
  // mirrors the mutation `onSuccess` path.  Toast-only uis skip it.
  const needsQc = realtimeNeedsQueryClient(ui);

  return lines(
    "<!-- Auto-generated.  Do not edit by hand. -->",
    '<script setup lang="ts">',
    "  // Live-event handlers (channels.md Part I): each `on <channel>.<Event>`",
    "  // declared on the ui renders the arriving event as a toast and/or",
    "  // refetches an aggregate's queries.  Renderless; mounted once at the App",
    "  // root.  The authorized read stays the gate — event payloads carry no",
    "  // privilege.",
    '  import { onMounted, onUnmounted } from "vue";',
    ...(needsQc ? ['  import { useQueryClient } from "@tanstack/vue-query";'] : []),
    '  import { subscribeRealtime } from "../api/realtime";',
    ...importLines.map((l) => `  ${l}`),
    "",
    ...(needsQc ? ["  const qc = useQueryClient();"] : []),
    "  let unsubscribe: (() => void) | undefined;",
    "  onMounted(() => {",
    "    unsubscribe = subscribeRealtime((event) => {",
    "      switch (event.type) {",
    ...cases,
    "      }",
    "    });",
    "  });",
    "  onUnmounted(() => unsubscribe?.());",
    "</script>",
    "",
    "<template><!-- realtime handlers (renderless) --></template>",
    "",
  );
}
