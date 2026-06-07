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

export interface DiagSnapshot {
  /** ISO timestamp. */
  t: string;
  /** What prompted the snapshot ("hidden" / "pagehide" / "window-error" / …). */
  reason: string;
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

const mb = (bytes: number): number => Math.round((bytes / 1_000_000) * 10) / 10;

interface PerfMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

async function capture(reason: string): Promise<DiagSnapshot> {
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
    const ring = readDiagnostics();
    ring.push(snap);
    localStorage.setItem(RING_KEY, JSON.stringify(ring.slice(-RING_MAX)));
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

/** Capture + log + persist one breadcrumb.  Fire-and-forget; never throws. */
export async function logDiagnostic(reason: string): Promise<void> {
  try {
    const snap = await capture(reason);
    // eslint-disable-next-line no-console
    console.warn("[loom-diag]", reason, snap);
    appendRing(snap);
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
