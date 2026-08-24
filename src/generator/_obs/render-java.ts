// ---------------------------------------------------------------------------
// Java / SLF4J renderer for the neutral log-event catalog (see
// `./log-events.ts`).  Sister to `render-hono.ts` / `render-dotnet.ts` /
// `render-phoenix.ts`.
//
// The Java backend logs through its own emitted `CatalogLog` facade —
// `CatalogLog.event(name, level, k1, v1, k2, v2, …)` — so unlike the other
// renderers this one does NOT build the whole call.  The per-emitter call
// sites already own their field pairs (many are interpolated Java
// expressions); what they must not own is the event NAME and LEVEL, which
// belong to the catalog.  `javaLogEvent(key)` renders exactly that leading
// pair, so a catalog rename propagates and a mistyped key is a TypeScript
// error rather than an off-catalog log line discovered by the nightly
// `java-obs-e2e` boot.
//
// Level fold: `CatalogLog` has no `trace` sink (SLF4J's TRACE is not wired
// in the emitted logback.xml), so the catalog's trace tier folds to `debug`
// — the same fold `test/generator/_obs/catalog-parity.test.ts` allows.
// ---------------------------------------------------------------------------

import { type LogEventKey, LogEvents } from "./log-events.js";

/** The quoted catalog event NAME — the first `CatalogLog.event(…)` argument. */
export function javaLogEventName(key: LogEventKey): string {
  return `"${LogEvents[key].event}"`;
}

/** The quoted catalog LEVEL — the second `CatalogLog.event(…)` argument, with
 *  the catalog's `trace` tier folded to `debug`. */
export function javaLogEventLevel(key: LogEventKey): string {
  const { level } = LogEvents[key];
  return `"${level === "trace" ? "debug" : level}"`;
}

/** The leading `"<event>", "<level>"` argument pair of a `CatalogLog.event(…)`
 *  call — the shape almost every call site wants.  Sites that break the two
 *  literals across source lines use the two accessors above instead. */
export function javaLogEvent(key: LogEventKey): string {
  return `${javaLogEventName(key)}, ${javaLogEventLevel(key)}`;
}
