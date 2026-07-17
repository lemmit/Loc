// Cadence helpers (scheduling.md, M-T4.1) — the lowest-altitude unit tests for
// `src/util/timer.ts`, shared by the AST cadence validator and the lowering.

import { describe, expect, it } from "vitest";
import {
  checkCron,
  cronEquivalentOf,
  MIN_INTERVAL_MS,
  parseDurationMs,
} from "../../src/util/timer.js";

describe("parseDurationMs", () => {
  it("parses each unit to milliseconds", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("15s")).toBe(15_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });
  it("returns 0 for an unparseable duration", () => {
    expect(parseDurationMs("")).toBe(0);
    expect(parseDurationMs("15")).toBe(0); // no unit
    expect(parseDurationMs("abc")).toBe(0);
  });
});

describe("checkCron", () => {
  it("accepts a valid 5-field expression and @nicknames", () => {
    expect(checkCron("*/5 * * * *")).toBeNull();
    expect(checkCron("0 2 * * *")).toBeNull();
    expect(checkCron("@daily")).toBeNull();
    expect(checkCron("@hourly")).toBeNull();
  });
  it("rejects an out-of-range field", () => {
    expect(checkCron("*/5 * 99 * *")).toMatch(/day-of-month must be 1-31/);
    expect(checkCron("99 * * * *")).toMatch(/minute must be 0-59/);
  });
  it("rejects a wrong field count and unknown nickname", () => {
    expect(checkCron("*/5 * *")).toMatch(/5-field/);
    expect(checkCron("@yearlyish")).toMatch(/unknown cron nickname/);
  });
});

describe("cronEquivalentOf", () => {
  it("returns the cron for a cleanly-expressible interval", () => {
    expect(cronEquivalentOf(300_000)).toBe("*/5 * * * *"); // 5m
    expect(cronEquivalentOf(6 * 3_600_000)).toBe("0 */6 * * *"); // 6h
    expect(cronEquivalentOf(86_400_000)).toBe("0 0 * * *"); // 24h
  });
  it("returns null for intervals cron cannot express", () => {
    expect(cronEquivalentOf(15_000)).toBeNull(); // sub-minute
    expect(cronEquivalentOf(7 * 60_000)).toBeNull(); // 7m — non-dividing
    expect(cronEquivalentOf(90 * 60_000)).toBeNull(); // 90m — non-dividing hours
  });
  it("has a one-second floor", () => {
    expect(MIN_INTERVAL_MS).toBe(1_000);
  });
});
