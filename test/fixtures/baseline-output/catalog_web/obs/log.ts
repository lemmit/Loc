// Auto-generated.
import { pino, type Logger } from "pino";

/** Base process logger.  Level is read from `LOG_LEVEL` (env), default
 *  `info`.  In dev, pipe stdout through `pino-pretty` for readable
 *  output:  `tsx index.ts | pino-pretty`.
 *
 *  Configuration aligned with the project's log envelope
 *  (`{ ts, level, event, request_id, ...fields }`):
 *    - `base: undefined`     — drop pino's default `{ pid, hostname }`
 *                                fields (noisy; orchestrator already records).
 *    - `formatters.level`     — emit the level *label* (`"info"`) rather
 *                                than pino's default numeric severity.
 *    - `timestamp`            — emit `"ts":"<ISO>"` rather than pino's
 *                                default epoch-ms `"time"`. */
export const baseLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
});

/** Per-request child logger type — created by the request-id middleware
 *  with `baseLogger.child({ request_id })`, so every line carries the
 *  correlation id automatically. */
export type RequestLogger = Logger;
