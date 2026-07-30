// ---------------------------------------------------------------------------
// Gathering the ALLOWLIST a crash report is built from.
//
// `crash-report.ts` is deliberately storage-blind: it can only report what it
// is handed.  This module is the one place that reads ambient state (the diag
// ring, `navigator`, `location`) and hands it over — and it reads a *named*
// set, never a storage dump, which is what keeps the BYOK key structurally out
// of reach.
//
// The workspace fingerprint arrives through a registered provider rather than
// an import, so the crash boundaries (which render above the app) don't have
// to reach into App state — and so a report built while the app is dead still
// works, just without the fingerprint.
// ---------------------------------------------------------------------------

import { buildInfo } from "./build-info.js";
import {
  fingerprintFiles,
  type CrashReportInput,
  type WorkspaceFingerprintEntry,
} from "./crash-report.js";
import { readDiagnostics, type DiagDetail, type DiagSnapshot } from "./diagnostics.js";

/** A live crash the ring may not have persisted yet (`logDiagnostic` is
 *  async; the user can click Copy first). */
export interface LiveCrash {
  reason: string;
  detail?: DiagDetail;
}

export type WorkspaceProvider = () => ReadonlyArray<{ path: string; content: string }>;

let workspaceProvider: WorkspaceProvider | null = null;

/** Register (or clear, with `null`) the source of the workspace fingerprint.
 *  Called once from `App` with the workspace-sources snapshot. */
export function setCrashWorkspaceProvider(p: WorkspaceProvider | null): void {
  workspaceProvider = p;
}

/** Splice a just-caught crash into the ring if the async `logDiagnostic` for
 *  it hasn't landed yet.  Pure — the dedupe rule is what's worth pinning. */
export function withLiveCrash(
  ring: DiagSnapshot[],
  live: LiveCrash | undefined,
  now: string,
): DiagSnapshot[] {
  if (!live) return ring;
  const already = ring.some(
    (s) => s.reason === live.reason && s.detail?.message === live.detail?.message,
  );
  if (already) return ring;
  return [
    ...ring,
    { t: now, reason: live.reason, detail: live.detail, build: buildInfo(), ua: "", vw: 0, vh: 0, hashLen: 0 },
  ];
}

/** Assemble the report input.  Never throws — a crash report must not be the
 *  second thing that breaks. */
export async function collectCrashReportInput(live?: LiveCrash): Promise<CrashReportInput> {
  const now = new Date().toISOString();
  let snapshots: DiagSnapshot[] = [];
  try {
    snapshots = withLiveCrash(readDiagnostics(), live, now);
  } catch {
    snapshots = [];
  }

  let workspace: WorkspaceFingerprintEntry[] | undefined;
  try {
    const files = workspaceProvider?.();
    if (files && files.length > 0) workspace = await fingerprintFiles(files);
  } catch {
    // A missing fingerprint costs triage a little context; a throw here would
    // cost the whole report.
  }

  return {
    snapshots,
    build: buildInfo(),
    ua: typeof navigator === "undefined" ? undefined : navigator.userAgent,
    viewport:
      typeof window === "undefined"
        ? undefined
        : { w: window.innerWidth, h: window.innerHeight },
    url: typeof location === "undefined" ? undefined : location.href,
    workspace,
    generatedAt: now,
  };
}
