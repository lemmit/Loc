// RealtimeHandlers — the live-event handler component, Angular flavour
// (channels.md Part I).
//
// `on <channelParam>.<Event>(e) { toast(…) }` ui members render into
// one `src/app/realtime-handlers.component.ts`: a renderless standalone
// component (selector `app-realtime-handlers`) whose constructor
// subscribes to the realtime SSE client (`src/api/realtime.ts`) and
// dispatches each arriving event through a `switch (event.type)` to its
// handler's toast/refetch; the subscription is torn down via the
// injected `DestroyRef`.  The switch arms + toast imports come from the
// shared `_frontend/realtime.ts` core (the same code the react / vue /
// svelte builders consume); the toast invocation is pack-shaped — each
// Angular pack ships a `realtime-toast` micro-template calling the
// generator-emitted `LoomToastService` (`buildAngularToastService`), and
// a `realtime-toast-setup` line injecting it into the constructor's DI
// context.
//
// A `refetch(<Agg>)` handler needs the TanStack `QueryClient`; the
// invalidation mirrors the api module's mutation-success path (same
// `["<tag>"]` key), so both hit the same cache entries.

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import {
  buildRealtimeSwitchCases,
  realtimeNeedsQueryClient,
  toastImports,
} from "../_frontend/realtime.js";
import type { LoadedPack } from "../_packs/loader.js";

/** True when any handler renders a toast, so the component injects the
 *  toast service + imports it.  A refetch-only ui skips both (an unused
 *  injected local is an `ng build` strict error). */
function realtimeNeedsToast(ui: UiIR): boolean {
  return (ui.notifications ?? []).some((n) => n.toasts.length > 0);
}

/** Render `src/app/realtime-handlers.component.ts` for a ui with at
 *  least one `on` handler.  Caller gates on `ui.notifications?.length`. */
export function buildAngularRealtimeHandlers(ui: UiIR, pack: LoadedPack): string {
  const needsToast = realtimeNeedsToast(ui);
  const needsQc = realtimeNeedsQueryClient(ui);
  const importLines = needsToast ? toastImports(pack) : [];
  // Injection line for the toast service (chakra's `realtime-toast-setup`
  // twin) — Angular's is `const toast = inject(LoomToastService);`.
  const setup =
    needsToast && pack.templates.has("realtime-toast-setup")
      ? pack.render("realtime-toast-setup", {}).trim()
      : null;
  // The switch nests constructor → subscribeRealtime callback → switch,
  // so the `case` keyword sits eight columns in (the same indent the
  // shared builder expects from react / vue / svelte).
  const cases = buildRealtimeSwitchCases(ui, pack, "        ");

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    "// Live-event handlers (channels.md Part I): each `on <channel>.<Event>`",
    "// declared on the ui renders the arriving event as a toast and/or",
    "// refetches an aggregate's queries.  Renderless; mounted once in the app",
    "// shell.  The authorized read stays the gate — event payloads carry no",
    "// privilege.",
    'import { Component, DestroyRef, inject } from "@angular/core";',
    ...(needsQc ? ['import { QueryClient } from "@tanstack/angular-query-experimental";'] : []),
    'import { subscribeRealtime } from "../api/realtime";',
    ...importLines,
    "",
    "@Component({",
    '  selector: "app-realtime-handlers",',
    '  template: "",',
    "})",
    "export class RealtimeHandlersComponent {",
    "  constructor() {",
    ...(setup ? [`    ${setup}`] : []),
    ...(needsQc ? ["    const qc = inject(QueryClient);"] : []),
    "    const destroyRef = inject(DestroyRef);",
    "    const unsubscribe = subscribeRealtime((event) => {",
    "      switch (event.type) {",
    ...cases,
    "      }",
    "    });",
    "    destroyRef.onDestroy(unsubscribe);",
    "  }",
    "}",
    "",
  );
}

/** The minimal toast surface the Angular realtime handlers render into
 *  (`src/app/loom-toast.service.ts`).  A root-provided service that
 *  appends a transient message element to a fixed-position host in
 *  `document.body` — no pack toast infrastructure is assumed, so it
 *  renders identically under every Angular design pack (the Angular twin
 *  of the vue generator's `src/lib/toast.ts` queue).  Emitted only when
 *  a ui has at least one toast-bearing `on` handler. */
export function buildAngularToastService(): string {
  return lines(
    "// Auto-generated.  Do not edit by hand.",
    "// Minimal toast surface for realtime live-event handlers (channels.md",
    "// Part I).  A root-provided service that appends a transient message",
    "// element to a fixed-position host in document.body; no pack toast",
    "// infrastructure is assumed, so it renders identically under every",
    "// Angular design pack.",
    'import { Injectable } from "@angular/core";',
    "",
    '@Injectable({ providedIn: "root" })',
    "export class LoomToastService {",
    "  show(message: string): void {",
    '    if (typeof document === "undefined") return;',
    "    const host = this.host();",
    '    const el = document.createElement("div");',
    '    el.className = "loom-toast";',
    '    el.setAttribute("role", "status");',
    '    el.setAttribute("data-testid", "channel-toast");',
    "    el.textContent = message;",
    "    host.appendChild(el);",
    "    globalThis.setTimeout(() => el.remove(), 4000);",
    "  }",
    "",
    "  private host(): HTMLElement {",
    '    const id = "loom-toast-host";',
    "    let host = document.getElementById(id);",
    "    if (!host) {",
    '      host = document.createElement("div");',
    "      host.id = id;",
    '      host.setAttribute("data-testid", "channel-toast-host");',
    "      host.style.cssText =",
    '        "position:fixed;bottom:16px;right:16px;z-index:3000;display:flex;flex-direction:column;gap:8px;";',
    "      document.body.appendChild(host);",
    "    }",
    "    return host;",
    "  }",
    "}",
    "",
  );
}
