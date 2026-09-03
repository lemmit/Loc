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
// The message expression is the validator-bounded subset
// (`loom.ui-handler-statement-unknown` admits only `toast(<expr>)`): literals,
// the event binding, MULTI-LEVEL member access off it, and operators.
// Anything outside that fails loud here rather than emitting broken markup —
// the throw is the defensive backstop behind `loom.toast-message-unsupported`,
// which rejects the same shapes with a source location one phase earlier.

import type { ExprIR, UiIR, UiNotificationIR } from "../../ir/types/loom-ir.js";
import type { RealtimeStreamCredential } from "../../ir/util/realtime-rooms.js";
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
  /** The stream credential from the shared realtime plan
   *  (`realtimeStreamCredential`, `src/ir/util/realtime-rooms.ts` RULE 2).
   *  `"session-cookie"` emits `withCredentials: true` — the `EventSource`
   *  twin of the api client's `credentials: "include"`, so the stream rides
   *  the SAME HttpOnly `session` cookie an ordinary API call does and reaches
   *  the backend cross-origin (the compose default points the bundle at the
   *  backend's own port, where a bare `EventSource` sends no cookie and the
   *  auth middleware answers 401).  `"none"` keeps the v1 bare constructor
   *  byte-identical for an `auth: none` deployable. */
  credential: RealtimeStreamCredential = "none",
): string {
  const typeList = eventTypes.map((t) => JSON.stringify(t)).join(", ");
  const withCredentials = credential === "session-cookie";
  // The `withCredentials` init is emitted ONLY under the credentialed gate:
  // it is a no-op same-origin, but emitting it unconditionally would change
  // every `auth: none` fixture's bytes for nothing.
  const sourceArgs = withCredentials
    ? `\`\${${apiBaseSymbol}}/realtime/events\`, { withCredentials: true }`
    : `\`\${${apiBaseSymbol}}/realtime/events\``;
  const credentialNote = withCredentials
    ? `//
// The stream is an ordinary AUTHENTICATED route (it is on no backend's auth
// bypass list), and \`EventSource\` cannot set an \`Authorization\` header — so it
// carries the same HttpOnly \`session\` cookie every other API call does, via
// \`withCredentials: true\`.  Without it the browser omits the cookie on the
// cross-origin stream and the backend answers 401.
`
    : "";
  return `// Auto-generated.  Do not edit by hand.
// Realtime SSE client (channels.md Part I) — subscribes to the backend's
// GET /realtime/events stream.  Events carried by a \`delivery: broadcast\`
// channel arrive as \`{ type, ...fields }\`; the connection auto-reconnects
// (EventSource semantics).  The authorized read remains the gate — refetch
// through the API for anything privileged.
${credentialNote}import { ${apiBaseSymbol} } from "./config";

export type RealtimeEvent = { type: string } & Record<string, unknown>;

/** Event types the backend's broadcast channels carry. */
export const REALTIME_EVENT_TYPES = [${typeList}] as const;

/** Subscribe to the realtime stream.  Returns an unsubscribe fn that
 *  closes the EventSource.  \`onEvent\` fires once per carried event. */
export function subscribeRealtime(onEvent: (event: RealtimeEvent) => void): () => void {
  const source = new EventSource(${sourceArgs});
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

/** The field names of a member chain rooted at the handler's event binding,
 *  outermost LAST — `e.order.id` with `bind === "e"` gives `["order", "id"]`.
 *  `undefined` when the chain does not bottom out at a bare `bind` reference
 *  (`currentUser.email`, `(e).id`, `f(x).y`), which is outside the subset.
 *
 *  THE one definition of "a toast member chain": all four realtime renderers
 *  call it, so the shape they accept cannot drift apart per target.  The
 *  validator gate (`toastMessageProblem`, `src/ir/validate/checks/ui-checks.ts`)
 *  mirrors it in the `ir/` layer, which cannot import from `generator/`. */
export function toastMemberPath(e: ExprIR, bind: string): string[] | undefined {
  const path: string[] = [];
  let cur: ExprIR = e;
  while (cur.kind === "member") {
    path.unshift(cur.member);
    cur = cur.receiver;
  }
  return cur.kind === "ref" && cur.name === bind ? path : undefined;
}

/** Render the message-expression subset to JS.  `bind` reads as the raw wire
 *  event; member access off it is `String(...)`-wrapped so the
 *  `Record<string, unknown>` field concatenates cleanly.
 *
 *  NULLABLE LINKS.  Every hop past the first is null-aware (`?.`) and the whole
 *  chain falls back to `""`, so a missing link anywhere renders as the EMPTY
 *  STRING rather than throwing or leaking `"undefined"` into toast copy.  That
 *  is the cross-target contract the other three renderers match. */
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
      const path = toastMemberPath(e, bind);
      if (!path) {
        throw new Error(
          "RealtimeHandlers: toast messages support member access off the event binding only.",
        );
      }
      // The wire event is `{ type: string } & Record<string, unknown>` —
      // String()-wrap so the field concatenates / interpolates cleanly.  `event`
      // itself is always defined, so only the hops PAST the first need `?.`.
      const chain = path.map((m, i) => (i === 0 ? `.${m}` : `?.${m}`)).join("");
      return `String(event${chain} ?? "")`;
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
