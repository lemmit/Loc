import type { BuildDiagnostic } from "../build/protocol";
import type { Diagnostic } from "./protocol";

/** Project the build worker's diagnostics onto the LSP shape the Problems
 *  panel renders.
 *
 *  Mobile runs no language client — Monaco and the `ddd-server` worker are
 *  desktop-only (M-T8.15) — so its Problems panel is fed from `generate`,
 *  which validates the same model through the same compiler and already
 *  reports `file:line`. The two sources differ in WHEN they fire (live
 *  keystrokes vs. on generate), not in what they know.
 *
 *  `BuildDiagnostic` lines/columns are 1-based and optional; LSP ranges are
 *  0-based and required. A diagnostic with no position lands on line 1, which
 *  is where a whole-document error belongs. */
export function buildDiagnosticsToLsp(items: readonly BuildDiagnostic[]): Diagnostic[] {
  return items.map((d) => {
    const line = Math.max(0, (d.line ?? 1) - 1);
    const character = Math.max(0, (d.column ?? 1) - 1);
    return {
      // Zero-width range at the reported position: the build worker reports a
      // point, and inventing an end column would draw a squiggle over text it
      // never looked at.
      range: { start: { line, character }, end: { line, character } },
      severity: d.severity,
      message: d.message,
      source: d.source ?? "loom",
      code: d.code,
    };
  });
}
