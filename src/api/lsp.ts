// ---------------------------------------------------------------------------
// LSP / editor adapters — turn the Loom toolkit's contract wire shapes into the
// types Monaco and VS Code already speak (D-API-TOOLKIT).  The `ModelPatch` and
// `JsonDiagnostic` formats are ours; these converters are the thin boundary
// that makes them recognizable to editors:
//
//   JsonDiagnostic → lsp.Diagnostic        (squiggles / markers)
//   ModelPatch     → lsp.TextEdit[]        (via resolvePatchEdits)
//   fixHint        → lsp.CodeAction        (the quick-fix lightbulb)
//
// Pure + browser-safe (vscode-languageserver-types is types + small enums), so
// the playground's Monaco editor and the VS Code extension use the same code.
// ---------------------------------------------------------------------------

import {
  type CodeAction,
  CodeActionKind,
  type Diagnostic,
  DiagnosticSeverity,
  type TextEdit,
} from "vscode-languageserver-types";
import type {
  JsonDiagnostic,
  JsonSeverity,
  ModelPatch,
  ValidateReport,
} from "../diagnostics/contract.js";
import { resolvePatchEdits } from "../language/model-patch.js";

const SEVERITY: Record<JsonSeverity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};

/** A single diagnostic as LSP `Diagnostic`, or `undefined` for a rangeless
 *  (IR-phase) diagnostic that has no editor location to anchor to. */
export function toLspDiagnostic(d: JsonDiagnostic): Diagnostic | undefined {
  if (!d.range) return undefined;
  return {
    range: d.range,
    severity: SEVERITY[d.severity],
    code: d.code,
    source: "loom",
    message: d.message,
  };
}

/** Every CST-backed diagnostic in a report as LSP `Diagnostic`s (rangeless IR
 *  diagnostics are dropped — they surface in the report's `diagnostics`, but
 *  there's nowhere in the editor to underline them). */
export function toLspDiagnostics(report: ValidateReport): Diagnostic[] {
  return report.diagnostics.map(toLspDiagnostic).filter((d): d is Diagnostic => d !== undefined);
}

/**
 * Quick-fix `CodeAction`s for every diagnostic in a report that carries a
 * `fixHint`.  Resolves each patch to LSP `TextEdit`s against `source` and wraps
 * it in a `WorkspaceEdit` keyed by `uri`, so the editor can apply the fix
 * directly.  Patches that fail to resolve are skipped.
 *
 * Both hint shapes are honoured:
 * - a hint carrying `patch` is THE repair — one action, `isPreferred`;
 * - a `choose` hint expands to one action per `options[]` entry, none preferred
 *   (several repairs are equally valid, so the author picks).
 */
export async function fixHintCodeActions(
  report: ValidateReport,
  source: string,
  uri: string,
): Promise<CodeAction[]> {
  const actions: CodeAction[] = [];
  for (const d of report.diagnostics) {
    const hint = d.fixHint;
    if (!hint) continue;
    // [patch] for a single-patch hint, else one entry per `choose` option.
    const candidates: { summary: string; patch: ModelPatch; preferred: boolean }[] = hint.patch
      ? [{ summary: hint.summary, patch: hint.patch, preferred: true }]
      : (hint.options ?? []).flatMap((o) =>
          o.patch ? [{ summary: o.summary, patch: o.patch, preferred: false }] : [],
        );
    for (const c of candidates) {
      const resolved = await resolvePatchEdits(source, [c.patch]);
      if (!resolved.ok || resolved.edits.length === 0) continue;
      const lspDiag = toLspDiagnostic(d);
      actions.push({
        title: c.summary ?? "Apply fix",
        kind: CodeActionKind.QuickFix,
        diagnostics: lspDiag ? [lspDiag] : [],
        ...(c.preferred ? { isPreferred: true } : {}),
        edit: { changes: { [uri]: resolved.edits as TextEdit[] } },
      });
    }
  }
  return actions;
}
