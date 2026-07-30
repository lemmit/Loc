import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRASH_REASONS,
  capRing,
  clearDiagnostics,
  clearLastCrash,
  DETAIL_COMPONENT_FRAMES,
  DETAIL_MESSAGE_MAX,
  DETAIL_STACK_FRAMES,
  type DiagSnapshot,
  errorDetail,
  isCrashReason,
  logDiagnostic,
  readDiagnostics,
  readLastCrash,
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
