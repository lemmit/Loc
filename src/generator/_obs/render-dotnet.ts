// ---------------------------------------------------------------------------
// .NET / Microsoft.Extensions.Logging renderer for the neutral log-event
// catalog (see `./log-events.ts`).  Sister to `render-hono.ts` — produces
// the source line every per-model .NET emitter pastes at a log seam, so
// the same catalog event surfaces with the same level + fields on the
// .NET backend as on the Hono one.
//
// Idiom: ILogger.Log<Level>(template, params) with `{Event}` + per-field
// `{Pascal}` placeholders.  ASP.NET logging consumers (the default
// console sink, Serilog, Application Insights, etc.) extract those
// placeholders as STRUCTURED properties — so a log pipeline filtering on
// `event = "operation_invoked"` works identically to its pino-fed
// counterpart, even though the wire JSON shape is the sink's choice
// (default console isn't pino-shaped; Serilog can be configured to
// match if cross-backend log parity matters at the JSON level).
//
// Assumes each emitting class has an `ILogger<TSelf> _log` field — the
// per-class injection idiom matching DomainExceptionFilter in
// api.tpl.ts.  Calls render against that field by name.
// ---------------------------------------------------------------------------

import { type LogEventKey, LogEvents } from "./log-events.js";

const METHOD: Record<string, string> = {
  trace: "LogTrace",
  debug: "LogDebug",
  info: "LogInformation",
  warn: "LogWarning",
  error: "LogError",
};

/** One field passed to a .NET log call — `name` is the snake_case
 *  catalog key (becomes a `{Pascal}` placeholder in the template), and
 *  `valueExpr` is the C# expression evaluated for the structured value.
 *  Caller passes a SUBSET of the catalog entry's `fields` — sites that
 *  don't have a particular field at hand (e.g. onError without an op
 *  name) just omit it.  Renderer doesn't enforce; the catalog declares
 *  what's POSSIBLE per event, not what's required at every site. */
export interface DotnetField {
  name: string;
  valueExpr: string;
}

/** Render `_log.<LogLevel>("{Event} key1={Pascal1} key2={Pascal2}",
 *  "event_name", v1, v2);` from a catalog entry + the fields the call
 *  site has on hand.  Assumes `_log` is the ILogger field; assumes the
 *  call site has the field name in scope as a C# identifier matching
 *  `valueExpr`. */
export function renderDotnetLogCall(eventKey: LogEventKey, fields: DotnetField[] = []): string {
  const e = LogEvents[eventKey];
  const method = METHOD[e.level];
  // Template: `{Event}` followed by snake-cased `key={Pascal}` pairs.
  // The placeholder names ARE the structured property names ASP.NET /
  // Serilog will surface — Pascal-case is the convention.
  const head = "{Event}";
  const tail = fields.map((f) => `${f.name}={${snakeToPascal(f.name)}}`);
  const template = [head, ...tail].join(" ");
  const args = [`"${e.event}"`, ...fields.map((f) => f.valueExpr)].join(", ");
  return `_log.${method}("${template}", ${args});`;
}

/** Same renderer but accepts an explicit exception expression as the
 *  first positional argument — the ILogger.Log<Level>(Exception, ...)
 *  overload.  Used at catch sites (extern_handler_threw, internal_error)
 *  so the stack trace rides the structured record. */
export function renderDotnetLogCallWithException(
  eventKey: LogEventKey,
  exceptionExpr: string,
  fields: DotnetField[] = [],
): string {
  const e = LogEvents[eventKey];
  const method = METHOD[e.level];
  const head = "{Event}";
  const tail = fields.map((f) => `${f.name}={${snakeToPascal(f.name)}}`);
  const template = [head, ...tail].join(" ");
  // ILogger.Log<Level>(Exception, string template, params object[] args)
  // — exception first, template next, structured args last.
  const args = [`"${e.event}"`, ...fields.map((f) => f.valueExpr)].join(", ");
  return `_log.${method}(${exceptionExpr}, "${template}", ${args});`;
}

/** snake_case → PascalCase: `request_id` → `RequestId`. */
function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join("");
}
