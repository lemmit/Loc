// ---------------------------------------------------------------------------
// Permanent `console.*` tee for the runtime worker.
//
// The generated Hono backend logs through pino.  pino's browser build
// binds the `console.*` methods at logger-creation time, and the backend
// creates its `baseLogger` while booting (inside the worker's `boot`
// RPC).  So whatever `console.info` exists at boot is the function pino
// keeps calling forever.
//
// The old approach patched `console.*` per-RPC and restored it in a
// `finally`.  That looked right but lost every structured line: pino
// bound the *boot* RPC's patch, so later dispatch logs (request_start /
// request_end / domain errors) flowed into the boot RPC's already-sent
// sink instead of the dispatch's — the Backend Logs tab stayed empty.
//
// Fix: install the tee ONCE (before any bundle is imported) and leave it
// in place.  It pushes into a swappable module-level sink, so the
// function pino bound at boot always routes to whichever RPC is current.
// `setLogSink(logs)` at the top of an RPC, `setLogSink(null)` after.
// ---------------------------------------------------------------------------

import { asStructuredPayload, formatLogArg, LOG_LEVELS, type LogLine } from "../util/log-line.js";

let activeLogSink: LogLine[] | null = null;

/** Point the tee at `sink` (an RPC's log array) or `null` between RPCs. */
export function setLogSink(sink: LogLine[] | null): void {
  activeLogSink = sink;
}

/** Wrap every `console[level]` on `target` so calls are teed into the
 *  active sink (when set) and still written through to the real console.
 *  Idempotent enough for one install at worker init; `target` is a seam
 *  for tests. */
export function installConsoleTee(target: Console = console): void {
  for (const level of LOG_LEVELS) {
    const original = target[level] as (...a: unknown[]) => void;
    target[level] = (...args: unknown[]): void => {
      const sink = activeLogSink;
      if (sink) {
        // Structured pino lines arrive as a single object argument
        // (`console.info({ level, event, ts, request_id, … })`); detect
        // that shape so the Output panel renders it without re-parsing,
        // and take the semantic level off the payload (pino-in-browser
        // routes `logger.trace` through `console.debug`).
        const structured = args.length === 1 ? asStructuredPayload(args[0]) : undefined;
        sink.push({
          level: structured?.level ?? level,
          text: args.map(formatLogArg).join(" "),
          ...(structured ? { structured } : {}),
        });
      }
      original(...args);
    };
  }
}
