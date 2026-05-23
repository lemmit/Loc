// ---------------------------------------------------------------------------
// Elixir / Phoenix `Logger` renderer for the neutral log-event catalog
// (see `./log-events.ts`).  Sister to `render-hono.ts` and
// `render-dotnet.ts` — produces the source line every per-model Phoenix
// emitter pastes at a log seam, so the same catalog event surfaces with
// the same level + fields on the Phoenix backend as on the Hono /
// .NET ones.
//
// Idiom: `Logger.<level>(message, keyword_list_of_metadata)`.  The
// message is the catalog event name (human-readable + grep-target); the
// metadata carries the structured fields, including a re-stamped
// `event:` key so a downstream filter pivoting on event identity works
// the same across all three backends.
//
// Level mapping: Elixir's Logger has no `trace` — both `trace` and
// `debug` from the catalog land on `Logger.debug`.  The `event:`
// metadata key still distinguishes them by name, and the runtime
// LOG_LEVEL filter at the Elixir layer collapses them anyway in
// production.  `warn` → `warning` (Elixir's spelling).
// ---------------------------------------------------------------------------

import { type LogEventKey, LogEvents } from "./log-events.js";

const LEVEL_TO_METHOD: Record<string, string> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

/** One field passed to a Phoenix log call — `name` is the snake_case
 *  catalog key (becomes a metadata-keyword key, kept snake_case since
 *  Elixir's atoms admit snake_case directly), and `valueExpr` is the
 *  Elixir expression evaluated for the structured value.  Caller passes
 *  a SUBSET of the catalog entry's `fields` — sites that don't have a
 *  particular field at hand just omit it. */
export interface PhoenixField {
  name: string;
  valueExpr: string;
}

/** Render `Logger.<level>("event_name", event: "event_name", k1: v1,
 *  k2: v2)` from a catalog entry + the fields the call site has on
 *  hand.  Assumes the surrounding module has `require Logger` already
 *  declared — the renderer doesn't emit the require itself because per-
 *  module imports are the caller's concern. */
export function renderPhoenixLogCall(eventKey: LogEventKey, fields: PhoenixField[] = []): string {
  const e = LogEvents[eventKey];
  const method = LEVEL_TO_METHOD[e.level];
  // `event:` is always re-stamped in the metadata so cross-backend
  // pipelines pivot on the same key regardless of source.
  const baseMeta = `event: "${e.event}"`;
  const fieldMeta = fields.map((f) => `${f.name}: ${f.valueExpr}`).join(", ");
  const meta = fieldMeta ? `${baseMeta}, ${fieldMeta}` : baseMeta;
  return `Logger.${method}("${e.event}", ${meta})`;
}
