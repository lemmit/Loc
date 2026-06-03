// ---------------------------------------------------------------------------
// Structured-diagnostics wire contract — the machine-readable interface the
// AI authoring loop consumes (docs/proposals/ai-diagnostics-contract.md).
//
// Pure types, NO imports: this module is the shared shape spoken by the CLI
// `--json` mode and (later) the in-browser `validate` tool (web/ imports
// ../src), so neither side can drift from the other.  The compile-time
// analogue of the runtime RFC 7807 `errors[]` format
// (docs/proposals/validation-error-extension.md).
// ---------------------------------------------------------------------------

/** LSP-compatible severities (design goal §7 — feeds VS Code + playground). */
export type JsonSeverity = "error" | "warning" | "info";

/** The pipeline phase that raised a diagnostic (contract §3.2). */
export type JsonPhase =
  | "parse" // ① lex/parse
  | "macro-expand" // ②
  | "scope-link" // ③ linking
  | "ast-validate" // ④ Langium validators
  | "ir-validate" // ⑦ IR validators
  | "generate"; // ⑤⑥⑧⑨⑩ — only a compiler bug reaches here

/** 0-based, half-open, LSP-compatible position. */
export interface JsonPosition {
  line: number;
  character: number;
}

export interface JsonRange {
  start: JsonPosition;
  end: JsonPosition;
}

/**
 * A repair affordance expressed in *model* terms, never generated-code terms
 * (contract §3.3).  Declared here so it is an optional field from day one;
 * the `replace-text` / `insert-decl` / `choose` patch kinds attach once the
 * model-patch applier (ai-authoring-loop.md §4, build-item 3) lands.  MVP
 * emits no `fixHint`.
 */
export interface JsonFixHint {
  kind: "replace-text" | "insert-decl" | "choose" | "manual";
  summary: string;
  /** A model patch the agent can hand straight to `apply_patch`.  Shape
   *  intentionally left `unknown` until the patch envelope is specified. */
  patch?: unknown;
  options?: { summary: string; patch?: unknown }[];
}

/** A secondary location related to a diagnostic (contract §3, optional). */
export interface JsonRelated {
  node?: string;
  range?: JsonRange;
  message: string;
}

/** One diagnostic, normalized across all phases (contract §3). */
export interface JsonDiagnostic {
  /** Stable machine id, e.g. `loom.bare-aggregate-in-type`. */
  code: string;
  severity: JsonSeverity;
  phase: JsonPhase;
  message: string;
  /** Canonical node address (`<keyword> <Context>.<Decl>[.<member>]`),
   *  shared with the outline address book.  Best-effort; may be absent. */
  node?: string;
  /** Precise source range.  Present for CST-backed (Langium) diagnostics;
   *  absent for IR diagnostics, which run on lowered IR with no CST. */
  range?: JsonRange;
  /** The offending source slice — free error context. */
  sourceText?: string;
  fixHint?: JsonFixHint;
  related?: JsonRelated[];
}

// --- Outline (the node address book, contract §5) --------------------------

export interface OutlineAggregate {
  node: string;
  members: string[];
}

export interface OutlineContext {
  name: string;
  aggregates: OutlineAggregate[];
  workflows: string[];
  views: string[];
  pages: string[];
}

export interface OutlineSystem {
  name: string;
  contexts: OutlineContext[];
}

export interface Outline {
  systems: OutlineSystem[];
  /** Contexts declared at model top level (no enclosing `system`). */
  contexts: OutlineContext[];
}

// --- Envelopes (contract §2 / §4) ------------------------------------------

export interface JsonReportSummary {
  errors: number;
  warnings: number;
  infos: number;
}

/** `ddd parse --json` / `validate --json` (contract §2). */
export interface ValidateReport {
  loomVersion: string;
  model: string;
  /** true iff no diagnostic has severity "error". */
  ok: boolean;
  summary: JsonReportSummary;
  diagnostics: JsonDiagnostic[];
  /** Always present so the agent can address nodes even on a failing model. */
  outline: Outline;
}

export interface GenerateDeployable {
  name: string;
  platform: string;
  port?: number;
}

/** `ddd generate system --json` (contract §4).  Deferred to a follow-up
 *  slice; declared here so the shape is pinned. */
export interface GenerateReport {
  loomVersion: string;
  model: string;
  ok: boolean;
  summary: JsonReportSummary;
  diagnostics: JsonDiagnostic[];
  deployables: GenerateDeployable[];
}
