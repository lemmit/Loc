// ---------------------------------------------------------------------------
// The Loom toolkit API — transport-neutral operations over a `.ddd` source.
//
// One core, many transports: the CLI, the (future) MCP server, the LSP
// adapters, and the in-browser playground all call these same functions, so
// the operation set never drifts per surface.  Everything here parses
// in-memory on EmptyFileSystem (no Node-only imports) and returns the contract
// wire shapes from `src/diagnostics/contract.ts`.
//
// Operations:
//   validate(source)      → ValidateReport   (diagnostics + outline)
//   generate(source)      → GenerateReport   (validation + deployable manifest)
//   applyPatches(src, ps) → PatchResult      (re-exported from language/)
// ---------------------------------------------------------------------------

import { EmptyFileSystem, type LangiumDocument, URI } from "langium";
import type { Diagnostic } from "vscode-languageserver-types";
import type {
  GenerateReport,
  ModelAggregate,
  ModelView,
  Outline,
  PrimitiveCatalog,
  ValidateReport,
} from "../diagnostics/contract.js";
import { enrichLoomModel } from "../ir/enrich/enrichments.js";
import { wireFieldsForAggregate } from "../ir/enrich/wire-projection.js";
import { lowerModel, mergeLoomModels } from "../ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../ir/types/loom-ir.js";
import { typeLabel } from "../ir/util/type-label.js";
import { type LoomDiagnostic, validateLoomModel } from "../ir/validate/validate.js";
import { createDddServices } from "../language/ddd-module.js";
import type { Model } from "../language/generated/ast.js";
import { buildOutline } from "../language/print/index.js";
import { WALKER_LAYOUT_PRIMITIVES, WALKER_SUB_PRIMITIVES } from "../util/walker-primitive-names.js";
import {
  buildGenerateReport,
  buildValidateReport,
  irDiagnosticToJson,
  langiumDiagnosticToJson,
} from "./report.js";

export type {
  EditError,
  EditResult,
  FindSymbolResult,
  GenerateReport,
  HoverResult,
  JsonDiagnostic,
  ModelAggregate,
  ModelDeployable,
  ModelSystem,
  ModelView,
  ModelWireField,
  NavError,
  NavLocation,
  NavSymbol,
  NavTextEdit,
  Outline,
  PrimitiveCatalog,
  QuickfixResult,
  ReferencesResult,
  RenameResult,
  UnfoldMacroResult,
  ValidateReport,
} from "../diagnostics/contract.js";
export type {
  ModelPatch,
  PatchApplied,
  PatchError,
  PatchResult,
  PatchTextEdit,
} from "../language/model-patch.js";
export { applyPatches, resolvePatchEdits } from "../language/model-patch.js";
export { fixHintCodeActions, toLspDiagnostic, toLspDiagnostics } from "./lsp.js";
export { findSymbol, hover, references } from "./navigate.js";
export { quickfix, rename, unfoldMacro } from "./refactor.js";
export { LOOM_VERSION } from "./report.js";

interface ParsedSource {
  doc: LangiumDocument<Model>;
  model: Model | undefined;
  diagnostics: Diagnostic[];
}

/** Parse a `.ddd` source string in-memory (lex → parse → link → AST-validate)
 *  on a fresh, isolated service instance.  Browser-safe (EmptyFileSystem). */
async function parseSource(source: string): Promise<ParsedSource> {
  const services = createDddServices(EmptyFileSystem);
  const factory = services.shared.workspace.LangiumDocumentFactory;
  const doc = factory.fromString<Model>(source, URI.parse("memory:///source.ddd"));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return {
    doc,
    model: doc.parseResult.value as Model | undefined,
    diagnostics: [...(doc.diagnostics ?? [])],
  };
}

/** A parse/lex error means the AST is incomplete and lowering can throw —
 *  callers skip the IR phases when this is true (contract §6). */
function hasParseError(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => {
    const code = (d.data as { code?: string } | undefined)?.code;
    return d.severity === 1 && (code === "parsing-error" || code === "lexing-error");
  });
}

/** Run the IR phases (lower → enrich → IR-validate) over a parsed model,
 *  surfacing an internal failure as a single diagnostic rather than throwing. */
function irDiagnosticsFor(model: Model, path: string): LoomDiagnostic[] {
  try {
    return validateLoomModel(enrichLoomModel(mergeLoomModels([lowerModel(model)])));
  } catch (err) {
    return [
      {
        severity: "error",
        message: `IR phase failed before generation: ${
          err instanceof Error ? err.message : String(err)
        }`,
        source: path,
        code: "loom.ir-internal",
      },
    ];
  }
}

/**
 * Validate a `.ddd` source — the `parse --json` / `validate --json` contract.
 * Runs the Langium phases AND the IR validator and returns the full
 * `ValidateReport` (coded, phase-attributed diagnostics + the outline).
 */
export async function validate(
  source: string,
  opts: { path?: string } = {},
): Promise<ValidateReport> {
  const path = opts.path ?? "<source>";
  const { doc, model, diagnostics } = await parseSource(source);
  const irDiagnostics = model && !hasParseError(diagnostics) ? irDiagnosticsFor(model, path) : [];
  return buildValidateReport({
    modelPath: path,
    langiumDiagnostics: diagnostics,
    doc,
    irDiagnostics,
    model,
  });
}

/**
 * The model's `outline` — the address book of contexts / aggregates / members
 * (the targets a `ModelPatch` and a diagnostic `node` use).  Cheap: parse +
 * walk, no IR phases.  Always returns a valid object.
 */
export async function outline(source: string): Promise<Outline> {
  const { model } = await parseSource(source);
  if (!model) return { systems: [], contexts: [] };
  try {
    return buildOutline(model);
  } catch {
    return { systems: [], contexts: [] };
  }
}

/**
 * Validation + deployable manifest for a `.ddd` source — the `generate --json`
 * contract (§4).  Reports whether the model would generate and which
 * deployables (name / platform / port) it produces; it does not write files
 * (use the CLI `generate system -o` to emit a tree).
 */
export async function generate(
  source: string,
  opts: { path?: string } = {},
): Promise<GenerateReport> {
  const path = opts.path ?? "<source>";
  const { doc, model, diagnostics } = await parseSource(source);
  const langiumJson = diagnostics.map((d) => langiumDiagnosticToJson(d, doc));

  if (!model || hasParseError(diagnostics)) {
    return buildGenerateReport({ modelPath: path, diagnostics: langiumJson, deployables: [] });
  }

  const loom = enrichLoomModel(mergeLoomModels([lowerModel(model)]));
  const irJson = validateLoomModel(loom).map(irDiagnosticToJson);
  const deployables = loom.systems.flatMap((sys) =>
    sys.deployables.map((d) => ({ name: d.name, platform: d.platform, port: d.port })),
  );
  return buildGenerateReport({
    modelPath: path,
    diagnostics: [...langiumJson, ...irJson],
    deployables,
  });
}

/** Project a bounded context's aggregates to their resolved wire shape. */
function aggregatesOf(ctx: EnrichedBoundedContextIR): ModelAggregate[] {
  return ctx.aggregates.map((agg) => ({
    name: agg.name,
    context: ctx.name,
    // The canonical wire shape is DERIVED on demand (never stamped) — the same
    // `wireFieldsForAggregate` every backend's DTO emitter consumes.
    wire: wireFieldsForAggregate(agg).map((f) => ({
      name: f.name,
      type: typeLabel(f.type),
      optional: f.optional,
      source: f.source,
    })),
  }));
}

/**
 * The resolved model view — the ENRICHED IR projected to the wire contract an
 * agent reasons about: each system's deployable manifest plus every aggregate's
 * canonical `wireShape` (id → properties → containments → derived, with each
 * field's rendered type / optionality / provenance).  This is the semantic
 * layer the AST-level {@link outline} deliberately omits.  Runs lower + enrich
 * (like {@link generate}); returns an empty view when the source can't lower.
 */
export async function readModel(source: string): Promise<ModelView> {
  const { model, diagnostics } = await parseSource(source);
  if (!model || hasParseError(diagnostics)) return { systems: [], contexts: [] };
  let loom: ReturnType<typeof enrichLoomModel>;
  try {
    loom = enrichLoomModel(mergeLoomModels([lowerModel(model)]));
  } catch {
    return { systems: [], contexts: [] };
  }
  return {
    systems: loom.systems.map((sys) => ({
      name: sys.name,
      deployables: sys.deployables.map((d) => ({
        name: d.name,
        platform: d.platform,
        port: d.port,
      })),
      // A system's contexts live under its subdomains (top-level members fold
      // into the lone system as subdomains during lowering).
      aggregates: sys.subdomains.flatMap((sd) => sd.contexts).flatMap(aggregatesOf),
    })),
    // Top-level loose contexts (single-deployable legacy shape) keep their
    // per-context grouping.
    contexts: loom.contexts.map((ctx) => ({ name: ctx.name, aggregates: aggregatesOf(ctx) })),
  };
}

/**
 * The closed page-body primitive vocabulary the UI walker admits — the exact
 * set an agent may use as `BuilderCall` types in a `page`/component body
 * without declaring a domain type.  Static (no source input): sourced from the
 * walker registry's admissibility sets, so it can't drift from what the
 * validator accepts.  Sorted for stable output.
 */
export function listPrimitives(): PrimitiveCatalog {
  return {
    layout: [...WALKER_LAYOUT_PRIMITIVES].sort(),
    sub: [...WALKER_SUB_PRIMITIVES].sort(),
  };
}
