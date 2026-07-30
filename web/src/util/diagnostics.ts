// ---------------------------------------------------------------------------
// Lightweight crash/pressure breadcrumbs — the "measure before optimizing"
// layer for the mobile-crash work.
//
// We don't yet have proof of *why* the playground crashes on mobile after a
// refresh (JS throw vs. out-of-memory tab-kill vs. storage-eviction reload).
// This captures a tiny snapshot of JS heap (Chrome/Android only) and storage
// usage (all browsers, incl. iOS Safari) at the moments that precede a crash —
// tab hide / pagehide and any caught error — and keeps the last few in
// localStorage so they survive the very reload a crash causes.  After a
// crash, `window.__loomDiag()` (or reading `loom.diag`) shows what memory and
// storage looked like just before.  Pure console + localStorage; the
// playground is static (GitHub Pages), so there's no backend to beacon to.
// ---------------------------------------------------------------------------

import { buildInfo, type BuildInfo } from "./build-info.js";

/** The part of a crash that actually makes it diagnosable.  Everything here
 *  used to go to `console.error` and die with the tab; the ring carried only
 *  memory/storage pressure plus the word `react-error`. */
export interface DiagDetail {
  /** `error.message` (or the stringified rejection reason). */
  message?: string;
  /** `error.stack`, capped at {@link DETAIL_STACK_FRAMES} frames. */
  stack?: string;
  /** React's component stack, capped at {@link DETAIL_COMPONENT_FRAMES}. */
  componentStack?: string;
  /** Which pane / worker the crash was contained to, when known. */
  pane?: string;
}

/** Capture-time truncation budgets.  Applied at capture rather than at report
 *  assembly so a pathological stack can't blow the 12-entry ring past the
 *  ~5 MB localStorage quota and cost us the *earlier* breadcrumbs too. */
export const DETAIL_MESSAGE_MAX = 500;
export const DETAIL_STACK_FRAMES = 30;
export const DETAIL_COMPONENT_FRAMES = 20;

/** Reasons that denote an actual error (as opposed to a pressure breadcrumb
 *  like `hidden` / `pagehide`).  These set the `lastCrash` flag and are what
 *  a crash report is built around. */
export const CRASH_REASONS = [
  "react-error",
  "react-error-pane",
  "window-error",
  "unhandledrejection",
  "worker-error",
] as const;
export type CrashReason = (typeof CRASH_REASONS)[number];

/** Is this reason an error class (vs. a pressure breadcrumb)? */
export function isCrashReason(reason: string): boolean {
  return (CRASH_REASONS as readonly string[]).includes(reason);
}

export interface DiagSnapshot {
  /** ISO timestamp. */
  t: string;
  /** What prompted the snapshot ("hidden" / "pagehide" / "window-error" / …). */
  reason: string;
  /** Error payload — present for the {@link CRASH_REASONS} classes. */
  detail?: DiagDetail;
  /** Identity of the bundle that produced the snapshot.  Without it a
   *  minified stack from a since-overwritten deploy is unresolvable. */
  build?: BuildInfo;
  /** JS heap in MB — only present where `performance.memory` exists
   *  (Chromium; absent on iOS Safari / Firefox). */
  mem?: { usedMB: number; totalMB: number; limitMB: number };
  /** Origin storage estimate in MB plus the used/quota ratio — the signal
   *  for eviction risk.  Present wherever `navigator.storage.estimate` is. */
  storage?: { usageMB: number; quotaMB: number; pct: number };
  ua: string;
  vw: number;
  vh: number;
  /** URL-hash length — large shared/project hashes are a load cost worth
   *  correlating against. */
  hashLen: number;
}

const RING_KEY = "loom.diag";
const RING_MAX = 12;
const LAST_CRASH_KEY = "loom.diag.lastCrash";

/** Keep the newest `n` lines of a multi-line blob. */
function headLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n  … ${lines.length - max} more frame(s) truncated`;
}

/** Apply the capture-time budgets.  Pure — the unit tests drive this
 *  directly rather than going through `localStorage`. */
export function truncateDetail(detail: DiagDetail | undefined): DiagDetail | undefined {
  if (!detail) return undefined;
  const out: DiagDetail = {};
  if (detail.message) {
    out.message =
      detail.message.length > DETAIL_MESSAGE_MAX
        ? `${detail.message.slice(0, DETAIL_MESSAGE_MAX)}…`
        : detail.message;
  }
  if (detail.stack) out.stack = headLines(detail.stack, DETAIL_STACK_FRAMES);
  if (detail.componentStack) {
    out.componentStack = headLines(detail.componentStack, DETAIL_COMPONENT_FRAMES);
  }
  if (detail.pane) out.pane = detail.pane;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Normalize anything thrown (Error, string, DOMException, `{}`) into a
 *  {@link DiagDetail}.  Pure and total — a boundary must never crash while
 *  describing a crash. */
export function errorDetail(err: unknown, extra?: { pane?: string; componentStack?: string }): DiagDetail {
  let message = "";
  let stack: string | undefined;
  if (err instanceof Error) {
    message = err.message || String(err);
    stack = err.stack;
  } else if (typeof err === "string") {
    message = err;
  } else if (err && typeof err === "object") {
    const rec = err as { message?: unknown; stack?: unknown };
    message = typeof rec.message === "string" ? rec.message : safeStringify(err);
    if (typeof rec.stack === "string") stack = rec.stack;
  } else {
    message = String(err);
  }
  return truncateDetail({ message, stack, ...extra }) ?? {};
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Append + cap, oldest-first.  Pure half of {@link appendRing}. */
export function capRing(ring: DiagSnapshot[], snap: DiagSnapshot): DiagSnapshot[] {
  return [...ring, snap].slice(-RING_MAX);
}

/** The "you crashed last session" flag.  The ring already survives the
 *  reload a crash causes, but nothing read it on boot, so the user never
 *  learned that a report was worth filing. */
export interface LastCrash {
  reason: string;
  t: string;
  build: BuildInfo;
  message?: string;
}

export function readLastCrash(): LastCrash | null {
  try {
    const raw = localStorage.getItem(LAST_CRASH_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const rec = v as Partial<LastCrash>;
    if (typeof rec.reason !== "string" || typeof rec.t !== "string") return null;
    return {
      reason: rec.reason,
      t: rec.t,
      build: rec.build ?? buildInfo(),
      message: typeof rec.message === "string" ? rec.message : undefined,
    };
  } catch {
    return null;
  }
}

export function clearLastCrash(): void {
  try {
    localStorage.removeItem(LAST_CRASH_KEY);
  } catch {
    // storage disabled — nothing to clear
  }
}

function writeLastCrash(snap: DiagSnapshot): void {
  try {
    const flag: LastCrash = {
      reason: snap.reason,
      t: snap.t,
      build: snap.build ?? buildInfo(),
      message: snap.detail?.message,
    };
    localStorage.setItem(LAST_CRASH_KEY, JSON.stringify(flag));
  } catch {
    // storage disabled / quota — the ring entry is still the primary record
  }
}

const mb = (bytes: number): number => Math.round((bytes / 1_000_000) * 10) / 10;

interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

async function capture(reason: string, detail?: DiagDetail): Promise<DiagSnapshot> {
  const perfMem = (performance as unknown as { memory?: PerfMemory }).memory;
  const mem = perfMem
    ? {
        usedMB: mb(perfMem.usedJSHeapSize),
        totalMB: mb(perfMem.totalJSHeapSize),
        limitMB: mb(perfMem.jsHeapSizeLimit),
      }
    : undefined;

  let storage: DiagSnapshot["storage"];
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const usage = est.usage ?? 0;
      const quota = est.quota ?? 0;
      storage = {
        usageMB: mb(usage),
        quotaMB: mb(quota),
        pct: quota > 0 ? Math.round((usage / quota) * 100) : 0,
      };
    }
  } catch {
    // estimate() can reject under some privacy modes — skip the field.
  }

  return {
    t: new Date().toISOString(),
    reason,
    detail: truncateDetail(detail),
    build: buildInfo(),
    mem,
    storage,
    ua: navigator.userAgent,
    vw: window.innerWidth,
    vh: window.innerHeight,
    hashLen: window.location.hash.length,
  };
}

function appendRing(snap: DiagSnapshot): void {
  try {
    localStorage.setItem(RING_KEY, JSON.stringify(capRing(readDiagnostics(), snap)));
  } catch {
    // storage disabled / quota — the console line below still recorded it.
  }
}

/** Read the persisted breadcrumb ring (oldest-first).  `[]` when none /
 *  unreadable.  Exposed on `window.__loomDiag` for post-crash inspection. */
export function readDiagnostics(): DiagSnapshot[] {
  try {
    const raw = localStorage.getItem(RING_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as DiagSnapshot[]) : [];
  } catch {
    return [];
  }
}

/** Drop the persisted breadcrumb ring (and the `lastCrash` flag with it —
 *  a user who clears the ring has said the crash is dealt with). */
export function clearDiagnostics(): void {
  try {
    localStorage.removeItem(RING_KEY);
  } catch {
    // storage disabled — nothing to clear
  }
  clearLastCrash();
}

/** Capture + log + persist one breadcrumb.  Fire-and-forget; never throws.
 *
 *  `detail` is what turns a breadcrumb into a bug report — pass it from every
 *  error-class capture point (both React boundaries, both window handlers, the
 *  build worker).  Error-class reasons additionally set the `lastCrash` flag
 *  read on the next boot. */
export async function logDiagnostic(reason: string, detail?: DiagDetail): Promise<void> {
  try {
    const snap = await capture(reason, detail);
    // eslint-disable-next-line no-console
    console.warn("[loom-diag]", reason, snap);
    appendRing(snap);
    if (isCrashReason(reason)) writeLastCrash(snap);
  } catch {
    // diagnostics must never be the thing that crashes the app
  }
}

/** Wire the pre-crash capture points: tab hide and pagehide (the moments a
 *  mobile browser is most likely to background-kill or evict), and expose the
 *  ring reader on `window` for console inspection after a reload. */
export function installDiagnostics(): void {
  if (typeof window === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void logDiagnostic("hidden");
  });
  window.addEventListener("pagehide", () => void logDiagnostic("pagehide"));
  (window as unknown as { __loomDiag?: () => DiagSnapshot[] }).__loomDiag =
    readDiagnostics;
}
