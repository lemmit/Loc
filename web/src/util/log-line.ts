// One line of captured runtime output — the shared shape for every
// log stream that feeds the Output panel (backend Hono console, preview
// app console, and — structurally — the test harness's ConsoleLine).
export interface LogLine {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export const LOG_LEVELS: readonly LogLine["level"][] = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
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
