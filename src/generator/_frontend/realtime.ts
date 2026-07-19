// Realtime SSE wire — frontend-shared pieces (channels.md Part I).
//
// Two consumers per frontend:
//   - `renderRealtimeClient` — the `realtime.ts` EventSource client
//     module (pack-agnostic; sits next to the api `config` module, so
//     the `./config` relative import holds for react's `src/api/` and
//     SvelteKit's `src/lib/api/` alike — only the exported base-URL
//     symbol name differs).
//   - `buildRealtimeSwitchCases` + `toastImports` — the framework-
//     neutral halves of the RealtimeHandlers component: the
//     `switch (event.type)` arms (plain JS + the pack's
//     `realtime-toast` micro-template per handler) and the pack-
//     declared toast import lines.  The component wrapper around them
//     is framework-shaped (react's renderless `useEffect` component
//     vs svelte's `$effect` script) and stays per-frontend.
//
// The message expression is the validator-bounded v1 subset
// (`loom.ui-handler-unsupported` admits only `toast(<expr>)`): literals,
// the event binding, single-level member access off it, and operators.
// Anything deeper fails loud here rather than emitting broken markup.

import type { ExprIR, UiIR, UiNotificationIR } from "../../ir/types/loom-ir.js";
import type { LoadedPack } from "../_packs/loader.js";

/** The realtime SSE client — one EventSource against the backend's
 *  `GET /realtime/events`, fanning typed events out to subscribers
 *  (channels.md Part I).  v1 is broadcast-to-all: the authorized read
 *  stays the gate, so consumers typically refetch/invalidate rather
 *  than trust payloads for anything privileged. */
export function renderRealtimeClient(
  eventTypes: readonly string[],
  /** Exported base-URL symbol in the sibling `./config` module.  Every
   *  frontend now emits `API_BASE_URL` (the shared `src/util/api-base.ts`
   *  emitter), so all callers pass it explicitly; the default matches. */
  apiBaseSymbol = "API_BASE_URL",
): string {
  const typeList = eventTypes.map((t) => JSON.stringify(t)).join(", ");
  return `// Auto-generated.  Do not edit by hand.
// Realtime SSE client (channels.md Part I) — subscribes to the backend's
// GET /realtime/events stream.  Events carried by a \`delivery: broadcast\`
// channel arrive as \`{ type, ...fields }\`; the connection auto-reconnects
// (EventSource semantics).  The authorized read remains the gate — refetch
// through the API for anything privileged.
import { ${apiBaseSymbol} } from "./config";

export type RealtimeEvent = { type: string } & Record<string, unknown>;

/** Event types the backend's broadcast channels carry. */
export const REALTIME_EVENT_TYPES = [${typeList}] as const;

/** Subscribe to the realtime stream.  Returns an unsubscribe fn that
 *  closes the EventSource.  \`onEvent\` fires once per carried event. */
export function subscribeRealtime(onEvent: (event: RealtimeEvent) => void): () => void {
  const source = new EventSource(\`\${${apiBaseSymbol}}/realtime/events\`);
  const handler = (m: MessageEvent) => {
    try {
      onEvent(JSON.parse(m.data as string) as RealtimeEvent);
    } catch {
      // Malformed frame — skip (keep the stream alive).
    }
  };
  for (const t of REALTIME_EVENT_TYPES) source.addEventListener(t, handler);
  return () => source.close();
}
`;
}

/** True when any handler declares a `refetch(<Agg>)` action, so the
 *  RealtimeHandlers component needs a `useQueryClient()` handle (`qc`).
 *  Every frontend gates the import + `const qc = …` on this — a
 *  toast-only ui keeps its byte-identical, query-client-free output. */
export function realtimeNeedsQueryClient(ui: UiIR): boolean {
  return (ui.notifications ?? []).some((n) => (n.refetches?.length ?? 0) > 0);
}

/** The `switch (event.type)` arms of a RealtimeHandlers component —
 *  one `case` per event type, one pack-rendered `realtime-toast` line
 *  per handler toast, then one `qc.invalidateQueries` per refetch target
 *  (the realtime twin of a mutation's `onSuccess` invalidation — same
 *  `["<tag>"]` key, so both hit the same cache entries).  `indent` is
 *  the case-keyword column (react's component nests two levels deeper
 *  than svelte's script). */
export function buildRealtimeSwitchCases(ui: UiIR, pack: LoadedPack, indent: string): string[] {
  const notifications = ui.notifications ?? [];
  const byEvent = new Map<string, UiNotificationIR[]>();
  for (const n of notifications) {
    const list = byEvent.get(n.eventType) ?? [];
    list.push(n);
    byEvent.set(n.eventType, list);
  }
  const cases: string[] = [];
  for (const [eventType, handlers] of [...byEvent.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    cases.push(`${indent}case ${JSON.stringify(eventType)}:`);
    for (const n of handlers) {
      for (const msg of n.toasts) {
        const message = renderMessageExpr(msg, n.bind);
        cases.push(`${indent}  ${pack.render("realtime-toast", { message }).trim()}`);
      }
      // Cache invalidation — `qc.invalidateQueries({ queryKey: ["<tag>"] })`,
      // dedup'd per event so two handlers refetching the same aggregate
      // emit one line.  `queryTag` is the pre-resolved query key.
      const seen = new Set<string>();
      for (const r of n.refetches ?? []) {
        if (seen.has(r.queryTag)) continue;
        seen.add(r.queryTag);
        cases.push(
          `${indent}  qc.invalidateQueries({ queryKey: [${JSON.stringify(r.queryTag)}] });`,
        );
      }
    }
    cases.push(`${indent}  break;`);
  }
  return cases;
}

/** Import lines the pack's `realtime-toast` template needs, from the
 *  manifest's `imports["realtime-toast"]` declarations. */
export function toastImports(pack: LoadedPack): string[] {
  const specs = pack.manifest.imports?.["realtime-toast"] ?? [];
  return specs.map((s) => `import { ${s.named.join(", ")} } from ${JSON.stringify(s.from)};`);
}

/** Render the v1 message-expression subset to JS.  `bind` reads as the
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
