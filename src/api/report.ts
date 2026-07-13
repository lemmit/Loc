// ---------------------------------------------------------------------------
// Structured-diagnostics serializers — the pure core that turns Langium
// (phases ①③④) and IR (phase ⑦) diagnostics into the contract wire shape
// (docs/old/proposals/ai-diagnostics-contract.md).  Transport-neutral: consumed by
// the CLI, the (future) MCP server, the LSP adapters, and the in-browser
// playground alike.  No Node-only imports — safe in the browser.
// ---------------------------------------------------------------------------

import { type AstNode, CstUtils, type LangiumDocument } from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import type {
  GenerateDeployable,
  GenerateReport,
  JsonDiagnostic,
  JsonPhase,
  JsonReportSummary,
  JsonSeverity,
  ValidateReport,
} from "../diagnostics/contract.js";
import type { LoomDiagnostic } from "../ir/validate/validate.js";
import { fixHintFor } from "../language/fix-hints.js";
import type { Model } from "../language/generated/ast.js";
import { addressOf, buildOutline } from "../language/print/index.js";

/** Single source for the `loomVersion` field and the CLI `.version()`. */
export const LOOM_VERSION = "0.1.0";

/** Defensive fallback for an IR diagnostic that somehow lacks a `code`.
 *  Every `diags.push` in `validate.ts` now carries a stable `loom.*` code
 *  (gated by test/ir/diagnostic-codes-completeness.test.ts), so this should
 *  not fire in practice — it only guards a future uncoded addition. */
const IR_FALLBACK_CODE = "loom.ir-validate";

function severityOf(d: Diagnostic): JsonSeverity {
  return d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
}

/** The internal Langium phase marker, stashed on `Diagnostic.data.code` for
 *  lex/parse/link errors (validator diagnostics carry a `loom.*` `code`). */
function dataCode(d: Diagnostic): string | undefined {
  return (d.data as { code?: string } | undefined)?.code;
}

function phaseOf(d: Diagnostic): JsonPhase {
  switch (dataCode(d)) {
    case "lexing-error":
    case "parsing-error":
      return "parse";
    case "linking-error":
      return "scope-link";
    default:
      return "ast-validate";
  }
}

function codeOf(d: Diagnostic): string {
  if (typeof d.code === "string" && d.code.startsWith("loom.")) return d.code;
  switch (dataCode(d)) {
    case "lexing-error":
      return "loom.lex-error";
    case "parsing-error":
      return "loom.parse-error";
    case "linking-error":
      return "loom.linking-error";
    default:
      return typeof d.code === "string" ? d.code : "loom.unknown";
  }
}

/** Resolve a CST-backed diagnostic to its AST node + address + source slice
 *  (best-effort; all fields may be absent). */
function locate(
  d: Diagnostic,
  doc: LangiumDocument,
): { ast?: AstNode; node?: string; sourceText?: string } {
  try {
    const rootCst = doc.parseResult?.value?.$cstNode;
    if (!rootCst) return {};
    const offset = doc.textDocument.offsetAt(d.range.start);
    const leaf = CstUtils.findLeafNodeAtOffset(rootCst, offset);
    const ast = leaf?.astNode;
    if (!ast) return {};
    const node = addressOf(ast);
    const raw = ast.$cstNode?.text;
    const sourceText = raw ? raw.split("\n", 1)[0]?.slice(0, 200) : undefined;
    return { ast, node, sourceText };
  } catch {
    return {};
  }
}

export function langiumDiagnosticToJson(d: Diagnostic, doc: LangiumDocument): JsonDiagnostic {
  const { ast, node, sourceText } = locate(d, doc);
  const fixHint = ast ? fixHintFor(d, doc, ast) : undefined;
  return {
    code: codeOf(d),
    severity: severityOf(d),
    phase: phaseOf(d),
    message: typeof d.message === "string" ? d.message : d.message.value,
    ...(node ? { node } : {}),
    range: {
      start: { line: d.range.start.line, character: d.range.start.character },
      end: { line: d.range.end.line, character: d.range.end.character },
    },
    ...(sourceText ? { sourceText } : {}),
    ...(fixHint ? { fixHint } : {}),
  };
}

export function irDiagnosticToJson(d: LoomDiagnostic): JsonDiagnostic {
  return {
    code: d.code ?? IR_FALLBACK_CODE,
    severity: d.severity,
    phase: "ir-validate",
    message: d.message,
    // IR diagnostics run on lowered IR — no CST range.  `source` is the
    // location handle until CST provenance is threaded through lowering.
    ...(d.source ? { node: d.source } : {}),
  };
}

/**
 * Total, deterministic order (contract §3.4): CST-ranged diagnostics first by
 * (line, character), then rangeless (IR) diagnostics, all tie-broken by
 * (code, node) so two runs over the same model are byte-identical.
 */
export function sortDiagnostics(diags: JsonDiagnostic[]): JsonDiagnostic[] {
  return [...diags].sort((a, b) => {
    if (a.range && !b.range) return -1;
    if (!a.range && b.range) return 1;
    if (a.range && b.range) {
      if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
      if (a.range.start.character !== b.range.start.character)
        return a.range.start.character - b.range.start.character;
    }
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const na = a.node ?? "";
    const nb = b.node ?? "";
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

function summarise(diagnostics: JsonDiagnostic[]): JsonReportSummary {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

export function buildValidateReport(args: {
  modelPath: string;
  langiumDiagnostics: Diagnostic[];
  doc: LangiumDocument;
  irDiagnostics: LoomDiagnostic[];
  model: Model | undefined;
}): ValidateReport {
  const diagnostics = sortDiagnostics([
    ...args.langiumDiagnostics.map((d) => langiumDiagnosticToJson(d, args.doc)),
    ...args.irDiagnostics.map(irDiagnosticToJson),
  ]);
  const summary = summarise(diagnostics);

  // Outline is always a valid object, even on a broken AST (contract §6).
  let outline: ValidateReport["outline"] = { systems: [], contexts: [] };
  if (args.model) {
    try {
      outline = buildOutline(args.model);
    } catch {
      outline = { systems: [], contexts: [] };
    }
  }

  return {
    loomVersion: LOOM_VERSION,
    model: args.modelPath,
    ok: summary.errors === 0,
    summary,
    diagnostics,
    outline,
  };
}

export function buildGenerateReport(args: {
  modelPath: string;
  diagnostics: JsonDiagnostic[];
  deployables: GenerateDeployable[];
}): GenerateReport {
  const diagnostics = sortDiagnostics(args.diagnostics);
  const summary = summarise(diagnostics);
  return {
    loomVersion: LOOM_VERSION,
    model: args.modelPath,
    ok: summary.errors === 0,
    summary,
    diagnostics,
    deployables: args.deployables,
  };
}
