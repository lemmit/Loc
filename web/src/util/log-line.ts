// One line of captured runtime output — the shared shape for every
// log stream that feeds the Output panel (backend Hono console, preview
// app console, and — structurally — the test harness's ConsoleLine).
//
// `level` is the *effective* level shown in the UI:
//   - For unstructured console.* calls it's the method name
//     (`console.warn(...)` → `"warn"`).
//   - For structured pino lines (emitted by every generated Hono
//     backend; see docs/old/proposals/observability.md), it's the level
//     embedded IN the pino payload — NOT the console method pino
//     chose to call.  This matters for `trace`: pino in browser maps
//     `logger.trace(...)` to `console.debug(...)`, so reading the
//     console method would under-represent the semantic level.  The
//     capture (see `runtime.worker.ts`) parses the payload when
//     present and overrides `level` from `payload.level`, so a UI
//     level filter sees the intended semantic stratum.
export interface LogLine {
  level: "log" | "info" | "warn" | "error" | "debug" | "trace";
  text: string;
  /** Parsed pino payload when the line carried a structured log event
   *  (catalog event-name + any structured fields).  Present whenever
   *  the captured argument was a `{ level, event, … }` object; absent
   *  for plain console.* calls.  Lets the Output panel surface the
   *  event name + request_id + payload fields as a richer rendering
   *  rather than dumping the JSON blob into `text`. */
  structured?: StructuredLogPayload;
}

/** Shape of a pino log object emitted by the generated Hono backend.
 *  Mirrors the envelope pinned in `docs/old/proposals/observability.md`:
 *  `ts` / `level` / `event` / `request_id` (when in a request scope) +
 *  arbitrary event-specific fields. */
export interface StructuredLogPayload {
  level: "trace" | "debug" | "info" | "warn" | "error";
  ts?: string;
  event: string;
  request_id?: string;
  [k: string]: unknown;
}

export const LOG_LEVELS: readonly LogLine["level"][] = [
  "log",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
] as const;

// Best-effort stringify of a console argument for transport across a
// worker / port boundary, where structured objects don't survive as
// readable text.  Errors keep their stack; objects are JSON-encoded.
export function formatLogArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Detect a pino log payload — a plain object carrying both a known
 *  level label AND an `event` string (the catalog envelope).  This is
 *  stricter than "is it an object" so unrelated log args that happen
 *  to be objects (e.g. `console.log({result})`) aren't misclassified. */
export function asStructuredPayload(a: unknown): StructuredLogPayload | undefined {
  if (typeof a !== "object" || a === null) return undefined;
  const obj = a as Record<string, unknown>;
  const level = obj.level;
  const event = obj.event;
  if (typeof event !== "string") return undefined;
  if (
    level !== "trace" &&
    level !== "debug" &&
    level !== "info" &&
    level !== "warn" &&
    level !== "error"
  ) {
    return undefined;
  }
  return obj as StructuredLogPayload;
}
