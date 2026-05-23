// Auto-generated.  Namespaced, level-based logging built on `loglevel`.
//
// Levels: verbose (`debug`) in dev, quiet (`warn`) in prod.  Override at
// runtime without a rebuild — append `?debug` to the URL (→ `trace`) or
// `localStorage.setItem("loglevel", "<level>")`.  All output flows through
// the real `console.*`, so host tooling captures it for free (the Loom
// playground's "App logs" stream; Playwright's `page.on("console")`).
import log, { type Logger, type LogLevelDesc } from "loglevel";

const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? false;
const wantsDebug =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("debug");
const defaultLevel: LogLevelDesc = wantsDebug ? "trace" : isDev ? "debug" : "warn";
log.setDefaultLevel(defaultLevel);

// loglevel doesn't tag output with the logger name; this methodFactory
// override prefixes every line with `[ns]` so multi-area logs stay legible.
export function getLogger(ns: string): Logger {
  const logger = log.getLogger(ns);
  const factory = logger.methodFactory;
  logger.methodFactory = (methodName, level, loggerName) => {
    const raw = factory(methodName, level, loggerName);
    const tag = `[${String(loggerName)}]`;
    return (...args: unknown[]) => raw(tag, ...args);
  };
  logger.setLevel(logger.getLevel()); // rebuild bound methods through the factory
  return logger;
}

export default log;
