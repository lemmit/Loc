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
 *  like `hidden` / `pagehide`).  These are what a crash report is built
 *  around. */
export const CRASH_REASONS = [
  "react-error",
  "react-error-pane",
  "window-error",
  "unhandledrejection",
  "worker-error",
  // Synthesised at startup from a leftover phase marker — see
  // `reapUnfinishedPhase`.  It is an error class (not a pressure breadcrumb)
  // because it is the ONLY record that a process kill happened at all.
  "died-in-phase",
] as const;
export type CrashReason = (typeof CRASH_REASONS)[number];

/** Is this reason an error class (vs. a pressure breadcrumb)? */
export function isCrashReason(reason: string): boolean {
  return (CRASH_REASONS as readonly string[]).includes(reason);
}

/** The subset of error classes the USER actually experienced — the UI went
 *  away.  Only these arm the next-boot "crashed last session" notice: a stray
 *  `unhandledrejection` or a worker hiccup is ring-worthy detail but not
 *  something they saw, and nagging on those would train users to dismiss the
 *  notice unread. */
export const FATAL_CRASH_REASONS = [
  "react-error",
  "react-error-pane",
  // A process kill passes the "did the user experience it?" test better than
  // anything else here: the page vanished and came back.  Without the notice
  // it is the ONLY crash class that is completely invisible — no error, no
  // console line, nothing on screen — so the user just taps Run again and
  // gets killed again.  Two field reports arrived that way.
  "died-in-phase",
] as const;

/** Should this reason arm the next-boot notice? */
export function isFatalCrashReason(reason: string): boolean {
  return (FATAL_CRASH_REASONS as readonly string[]).includes(reason);
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

// ---------------------------------------------------------------------------
// PHASE MARKERS — the only instrument that survives a process kill.
//
// Everything else in this file is reactive: it needs an event (`error`,
// `unhandledrejection`, `pagehide`) and then an ASYNC `capture()` that awaits
// `navigator.storage.estimate()` before anything reaches localStorage.  When
// iOS terminates the renderer for memory — the "bundles, then the whole page
// refreshes, no error anywhere" report — there is no event and no microtask.
// The ring necessarily records NOTHING, which is exactly why the reports keep
// coming back empty on the interesting failure.
//
// So: write the phase name SYNCHRONOUSLY, BEFORE each risky step.  A kill
// leaves the marker behind; the next page load finds it, and the phase names
// where the process died.  This is forensics-by-tombstone, not logging.
//
// The write must stay tiny and synchronous — no JSON of a big object, no
// awaits.  One short string is the whole budget.
// ---------------------------------------------------------------------------

const PHASE_KEY = "loom.diag.phase";

/** Phases, in pipeline order.  Names are stable strings because they are read
 *  back out of localStorage written by a PREVIOUS (possibly older) build. */
export type DiagPhase =
  | "generate"
  | "bundle"
  | "boot:start"
  | "boot:import-bundle"
  | "boot:pglite-assets"
  | "boot:pglite-construct"
  // `boot:ddl` was one marker over four very different operations, and a
  // field report landed on it.  Split so the next one says WHICH: pure-JS
  // synthesis, the tiny bookkeeping round-trip, the drift-path
  // `DROP SCHEMA … CASCADE`, or applying the generated DDL.  Note that
  // `ddl-meta` is ALSO where PGlite really starts up — its first exec.
  | "boot:ddl-synth"
  | "boot:ddl-meta"
  | "boot:ddl-drop"
  | "boot:ddl-apply"
  | "boot:create-app";

interface PhaseMark {
  phase: string;
  /** Optional scale/context captured with the mark (e.g. `"180 stmts, 61KB"`).
   *  A phase name says where; this says how big, which is what separates
   *  "this step is inherently heavy here" from "this step is normally fine". */
  note?: string;
  /** epoch ms — cheaper to write than an ISO string, formatted on read. */
  t: number;
}

/** Record that we are ABOUT TO enter `phase`.  Synchronous by design. */
export function markPhase(phase: DiagPhase, note?: string): void {
  try {
    // `|` separates the optional note; it can't occur in a phase name, and
    // the whole record stays one short line so the write stays cheap.
    const suffix = note ? `|${note.slice(0, 120)}` : "";
    localStorage.setItem(PHASE_KEY, `${Date.now()}:${phase}${suffix}`);
  } catch {
    // storage disabled / quota — diagnostics never break the app
  }
}

/** Record that the risky window closed cleanly.  Anything left behind after
 *  this is a genuine "died mid-phase". */
export function clearPhase(): void {
  try {
    localStorage.removeItem(PHASE_KEY);
  } catch {
    // storage disabled — nothing to clear
  }
}

function readPhase(): PhaseMark | null {
  try {
    const raw = localStorage.getItem(PHASE_KEY);
    if (!raw) return null;
    const sep = raw.indexOf(":");
    if (sep < 0) return null;
    const t = Number(raw.slice(0, sep));
    const rest = raw.slice(sep + 1);
    if (!Number.isFinite(t) || rest.length === 0) return null;
    const bar = rest.indexOf("|");
    if (bar < 0) return { phase: rest, t };
    return { phase: rest.slice(0, bar), note: rest.slice(bar + 1), t };
  } catch {
    return null;
  }
}

/** Called once at startup.  A marker still present means the previous page
 *  load entered that phase and never left it — no `pagehide`, no error, no
 *  chance to clean up.  That is the signature of a renderer kill (iOS OOM) or
 *  a hard reload, and it is precisely the event nothing else can observe.
 *  Promote it into the ring so it lands in the pasted crash report. */
export function reapUnfinishedPhase(): PhaseMark | null {
  const mark = readPhase();
  clearPhase();
  if (!mark) return null;
  void logDiagnostic("died-in-phase", {
    message:
      `previous load entered "${mark.phase}"${mark.note ? ` (${mark.note})` : ""} at ` +
      `${new Date(mark.t).toISOString()} and never completed it — no error and ` +
      "no pagehide, i.e. the process was killed (typically iOS memory pressure) " +
      "or hard-reloaded",
    pane: mark.phase,
  });
  return mark;
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
 *  build worker).  Fatal classes (a React boundary caught a render throw)
 *  additionally set the `lastCrash` flag read on the next boot. */
export async function logDiagnostic(reason: string, detail?: DiagDetail): Promise<void> {
  try {
    const snap = await capture(reason, detail);
    // eslint-disable-next-line no-console
    console.warn("[loom-diag]", reason, snap);
    appendRing(snap);
    if (isFatalCrashReason(reason)) writeLastCrash(snap);
  } catch {
    // diagnostics must never be the thing that crashes the app
  }
}

/** Wire the pre-crash capture points: tab hide and pagehide (the moments a
 *  mobile browser is most likely to background-kill or evict), and expose the
 *  ring reader on `window` for console inspection after a reload. */
export function installDiagnostics(): void {
  if (typeof window === "undefined") return;
  // FIRST: harvest any phase marker the previous load left behind, before
  // this load can write one of its own.
  reapUnfinishedPhase();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void logDiagnostic("hidden");
  });
  // A real navigation/backgrounding is not a kill — drop the marker so it
  // isn't misreported as one on the next load.
  window.addEventListener("pagehide", () => {
    clearPhase();
    void logDiagnostic("pagehide");
  });
  (window as unknown as { __loomDiag?: () => DiagSnapshot[] }).__loomDiag =
    readDiagnostics;
}
