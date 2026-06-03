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
import type { JsonDiagnostic, JsonSeverity, ValidateReport } from "../diagnostics/contract.js";
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
 * `fixHint` patch.  Resolves each patch to LSP `TextEdit`s against `source` and
 * wraps it in a `WorkspaceEdit` keyed by `uri`, so the editor can apply the fix
 * directly.  Diagnostics whose patch fails to resolve are skipped.
 */
export async function fixHintCodeActions(
  report: ValidateReport,
  source: string,
  uri: string,
): Promise<CodeAction[]> {
  const actions: CodeAction[] = [];
  for (const d of report.diagnostics) {
    const patch = d.fixHint?.patch;
    if (!patch) continue;
    const resolved = await resolvePatchEdits(source, [patch]);
    if (!resolved.ok || resolved.edits.length === 0) continue;
    const lspDiag = toLspDiagnostic(d);
    actions.push({
      title: d.fixHint?.summary ?? "Apply fix",
      kind: CodeActionKind.QuickFix,
      diagnostics: lspDiag ? [lspDiag] : [],
      isPreferred: true,
      edit: { changes: { [uri]: resolved.edits as TextEdit[] } },
    });
  }
  return actions;
}
