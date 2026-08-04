import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_REASONS,
  capRing,
  clearDiagnostics,
  clearLastCrash,
  clearPhase,
  DETAIL_COMPONENT_FRAMES,
  DETAIL_MESSAGE_MAX,
  DETAIL_STACK_FRAMES,
  type DiagSnapshot,
  errorDetail,
  isCrashReason,
  isFatalCrashReason,
  logDiagnostic,
  markPhase,
  readDiagnostics,
  readLastCrash,
  reapUnfinishedPhase,
  truncateDetail,
} from "../../web/src/util/diagnostics.js";

// ---------------------------------------------------------------------------
// M-T8.14 slice 1 — capture completeness.
//
// Before this, `logDiagnostic` took only a reason string: message, stack and
// component stack went to `console.error` and died with the tab, so the ring
// reported PRESSURE and never the crash.  These tests pin the payload round-
// tripping through storage, the capture-time budgets that keep a pathological
// stack from evicting the earlier breadcrumbs, and the invariant the whole
// module rests on — diagnostics must never be the thing that crashes the app.
// ---------------------------------------------------------------------------

class MemStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemStorage());
  vi.stubGlobal("window", {
    innerWidth: 390,
    innerHeight: 844,
    location: { hash: "#project=abc" },
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("diag detail — capture-time truncation", () => {
  it("caps the message at the documented budget", () => {
    const d = truncateDetail({ message: "x".repeat(DETAIL_MESSAGE_MAX + 200) })!;
    expect(d.message).toHaveLength(DETAIL_MESSAGE_MAX + 1); // + the ellipsis
    expect(d.message?.endsWith("…")).toBe(true);
  });

  it("leaves a short message untouched", () => {
    expect(truncateDetail({ message: "boom" })?.message).toBe("boom");
  });

  it("caps the stack at 30 frames and says how many it dropped", () => {
    const stack = Array.from({ length: 90 }, (_, i) => `    at f${i}`).join("\n");
    const out = truncateDetail({ stack })!.stack!;
    expect(out).toContain("at f29");
    expect(out).not.toContain("at f30\n");
    expect(out).toContain(`${90 - DETAIL_STACK_FRAMES} more frame(s) truncated`);
  });

  it("caps the component stack at 20 frames", () => {
    const componentStack = Array.from({ length: 50 }, (_, i) => `    at C${i}`).join("\n");
    const out = truncateDetail({ componentStack })!.componentStack!;
    expect(out).toContain("at C19");
    expect(out).not.toContain("at C20\n");
    expect(out).toContain(`${50 - DETAIL_COMPONENT_FRAMES} more frame(s) truncated`);
  });

  it("collapses an empty detail to undefined rather than an empty object", () => {
    expect(truncateDetail({})).toBeUndefined();
    expect(truncateDetail(undefined)).toBeUndefined();
  });

  it("keeps the pane label — it is how a contained crash is attributed", () => {
    expect(truncateDetail({ pane: "Builder" })?.pane).toBe("Builder");
  });
});

describe("errorDetail — total over anything thrown", () => {
  it("reads message + stack off an Error", () => {
    const e = new Error("kaboom");
    const d = errorDetail(e);
    expect(d.message).toBe("kaboom");
    expect(d.stack).toContain("kaboom");
  });

  it("handles a thrown string, a bare object and a primitive", () => {
    expect(errorDetail("plain").message).toBe("plain");
    expect(errorDetail({ message: "objish" }).message).toBe("objish");
    expect(errorDetail({ a: 1 }).message).toBe('{"a":1}');
    expect(errorDetail(undefined).message).toBe("undefined");
  });

  it("merges the pane / component stack the boundary supplies", () => {
    const d = errorDetail(new Error("x"), { pane: "Model", componentStack: "\n at Pane" });
    expect(d.pane).toBe("Model");
    expect(d.componentStack).toContain("at Pane");
  });

  it("applies the same budgets as a direct capture", () => {
    const e = new Error("y".repeat(DETAIL_MESSAGE_MAX + 50));
    expect(errorDetail(e).message).toHaveLength(DETAIL_MESSAGE_MAX + 1);
  });
});

describe("crash classes", () => {
  it("counts every error class and nothing else", () => {
    for (const r of CRASH_REASONS) expect(isCrashReason(r)).toBe(true);
    expect(isCrashReason("hidden")).toBe(false);
    expect(isCrashReason("pagehide")).toBe(false);
  });

  it("names the build-worker class — worker death used to be unobservable", () => {
    expect(CRASH_REASONS).toContain("worker-error");
  });
});

describe("ring cap", () => {
  const snap = (t: string): DiagSnapshot =>
    ({ t, reason: "hidden", ua: "", vw: 0, vh: 0, hashLen: 0 }) as DiagSnapshot;

  it("keeps the newest 12 and drops the oldest", () => {
    let ring: DiagSnapshot[] = [];
    for (let i = 0; i < 20; i++) ring = capRing(ring, snap(`t${i}`));
    expect(ring).toHaveLength(12);
    expect(ring[0]?.t).toBe("t8");
    expect(ring[11]?.t).toBe("t19");
  });
});

describe("logDiagnostic — round-trip through storage", () => {
  it("persists the structured detail, not just the reason", async () => {
    await logDiagnostic("react-error-pane", {
      message: "Cannot read properties of undefined",
      stack: "Error\n    at Pane (index.js:1:1)",
      componentStack: "\n    at BuilderPane",
      pane: "Builder",
    });
    const ring = readDiagnostics();
    expect(ring).toHaveLength(1);
    expect(ring[0]?.reason).toBe("react-error-pane");
    expect(ring[0]?.detail?.message).toBe("Cannot read properties of undefined");
    expect(ring[0]?.detail?.stack).toContain("at Pane");
    expect(ring[0]?.detail?.componentStack).toContain("at BuilderPane");
    expect(ring[0]?.detail?.pane).toBe("Builder");
  });

  it("stamps every entry with the build identity", async () => {
    await logDiagnostic("window-error", { message: "x" });
    // No `define` under vitest → the honest `dev` fallback, never absent.
    expect(readDiagnostics()[0]?.build?.sha).toBe("dev");
  });

  it("truncates at capture, so one huge stack can't evict the ring", async () => {
    await logDiagnostic("react-error", {
      stack: Array.from({ length: 200 }, (_, i) => `    at f${i}`).join("\n"),
    });
    expect(readDiagnostics()[0]?.detail?.stack).not.toContain("at f31\n");
  });

  it("stays capped at 12 entries", async () => {
    for (let i = 0; i < 15; i++) await logDiagnostic("hidden");
    expect(readDiagnostics()).toHaveLength(12);
  });

  it("arms lastCrash only for fatal boundary crashes — not breadcrumbs or non-fatal error classes", async () => {
    await logDiagnostic("hidden");
    expect(readLastCrash()).toBeNull();

    // Ring-worthy but NOT notice-worthy: the user saw no crash, and a notice
    // armed by stray rejections/worker hiccups would sit over the tab bars
    // (the no-network lane caught it doing exactly that) and train users to
    // dismiss it unread.
    await logDiagnostic("worker-error", { message: "worker died", pane: "build-worker" });
    await logDiagnostic("unhandledrejection", { message: "stray" });
    await logDiagnostic("window-error", { message: "stray" });
    expect(readLastCrash()).toBeNull();

    await logDiagnostic("react-error-pane", { message: "pane down", pane: "builder" });
    const flag = readLastCrash();
    expect(flag?.reason).toBe("react-error-pane");
    expect(flag?.message).toBe("pane down");
    expect(flag?.build.sha).toBe("dev");
    expect(flag?.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("clears lastCrash on dismiss, and with the ring", async () => {
    await logDiagnostic("react-error", { message: "a" });
    clearLastCrash();
    expect(readLastCrash()).toBeNull();

    await logDiagnostic("react-error", { message: "b" });
    clearDiagnostics();
    expect(readLastCrash()).toBeNull();
    expect(readDiagnostics()).toEqual([]);
  });

  it("never throws when storage throws — diagnostics can't be the crash", async () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("quota exceeded");
      },
      removeItem() {
        throw new Error("nope");
      },
    });
    await expect(logDiagnostic("react-error", { message: "x" })).resolves.toBeUndefined();
    expect(readDiagnostics()).toEqual([]);
    expect(readLastCrash()).toBeNull();
    expect(() => clearDiagnostics()).not.toThrow();
  });

  it("survives a corrupt ring rather than propagating the parse error", () => {
    localStorage.setItem("loom.diag", "{not json");
    expect(readDiagnostics()).toEqual([]);
    localStorage.setItem("loom.diag", '"a string, not an array"');
    expect(readDiagnostics()).toEqual([]);
  });

  it("ignores a malformed lastCrash flag", () => {
    localStorage.setItem("loom.diag.lastCrash", '{"reason":42}');
    expect(readLastCrash()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase markers — the tombstone that survives a renderer kill.
//
// Every other capture point in this module is reactive: it needs an event
// (`error` / `unhandledrejection` / `pagehide`) and then an ASYNC `capture()`
// that awaits `navigator.storage.estimate()` before anything is written.  When
// iOS terminates the renderer for memory there is no event and no microtask,
// so the ring records nothing at all — which is why the field reports of
// "bundles, then the whole page refreshes" arrived with an empty ring.
//
// A phase marker is written SYNCHRONOUSLY before each risky step, so a kill
// leaves it behind and the next load can name the step that died.
// ---------------------------------------------------------------------------
describe("phase markers", () => {
  it("writes synchronously — no await between mark and storage", () => {
    markPhase("boot:pglite-construct");
    // Read back with no `await` anywhere: this is the whole point.  If the
    // write ever moves behind a promise, a process kill loses it.
    expect(localStorage.getItem("loom.diag.phase")).toMatch(/^\d+:boot:pglite-construct$/);
  });

  it("reaps a leftover marker into the ring as an error-class entry", async () => {
    markPhase("boot:import-bundle");
    const mark = reapUnfinishedPhase();
    expect(mark?.phase).toBe("boot:import-bundle");
    await Promise.resolve();
    const ring = readDiagnostics();
    const died = ring.find((s) => s.reason === "died-in-phase");
    expect(died).toBeDefined();
    // The phase rides in `pane`, which the crash report renders verbatim.
    expect(died?.detail?.pane).toBe("boot:import-bundle");
    expect(died?.detail?.message).toContain("boot:import-bundle");
  });

  it("consumes the marker so one kill is reported once", () => {
    markPhase("bundle");
    expect(reapUnfinishedPhase()?.phase).toBe("bundle");
    expect(reapUnfinishedPhase()).toBeNull();
  });

  it("reports nothing when the phase completed cleanly", () => {
    markPhase("generate");
    clearPhase();
    expect(reapUnfinishedPhase()).toBeNull();
  });

  it("counts `died-in-phase` as an error class, not a pressure breadcrumb", () => {
    // It must sort into the report's "Crashes" section — it is the only
    // record that a kill happened at all.
    expect(isCrashReason("died-in-phase")).toBe(true);
    expect(CRASH_REASONS).toContain("died-in-phase");
  });

  // The phase says WHERE it died; the note says how much work it was
  // carrying.  A field report landed on `boot:ddl` with PGlite already
  // initialised — the next one needs to distinguish "182 statements, 61KB"
  // from "3 statements" before any fix is worth attempting.
  it("round-trips a scale note alongside the phase", () => {
    markPhase("boot:ddl-apply", "182 stmts, 61KB");
    const mark = reapUnfinishedPhase();
    expect(mark?.phase).toBe("boot:ddl-apply");
    expect(mark?.note).toBe("182 stmts, 61KB");
  });

  it("surfaces the note in the reaped message the report renders", async () => {
    markPhase("boot:ddl-apply", "182 stmts, 61KB");
    reapUnfinishedPhase();
    await Promise.resolve();
    const died = readDiagnostics().find((s) => s.reason === "died-in-phase");
    expect(died?.detail?.message).toContain("182 stmts, 61KB");
    // The phase still rides in `pane` on its own — the report renders that
    // field verbatim and it must stay a clean phase name.
    expect(died?.detail?.pane).toBe("boot:ddl-apply");
  });

  it("caps the note so a pathological one can't blow the storage budget", () => {
    markPhase("boot:ddl-apply", "x".repeat(500));
    expect((localStorage.getItem("loom.diag.phase") ?? "").length).toBeLessThan(200);
  });

  it("still parses a marker with no note", () => {
    markPhase("boot:pglite-construct");
    const mark = reapUnfinishedPhase();
    expect(mark?.phase).toBe("boot:pglite-construct");
    expect(mark?.note).toBeUndefined();
  });

  // A process kill is the only crash class with NO visible symptom: no error,
  // no console line, the page simply comes back.  Two field reports arrived
  // that way, with the user re-tapping Run into the same kill each time.  The
  // notice is the whole feedback loop.
  it("arms the next-boot notice, because the user saw the page vanish", async () => {
    markPhase("boot:ddl-meta", "9 stmts, 1KB");
    reapUnfinishedPhase();
    await Promise.resolve();
    expect(isFatalCrashReason("died-in-phase")).toBe(true);
    const flag = readLastCrash();
    expect(flag?.reason).toBe("died-in-phase");
    expect(flag?.message).toContain("boot:ddl-meta");
  });

  it("never throws when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    });
    expect(() => markPhase("bundle")).not.toThrow();
    expect(() => clearPhase()).not.toThrow();
    expect(() => reapUnfinishedPhase()).not.toThrow();
  });
});
