// ---------------------------------------------------------------------------
// Structured-diagnostics wire contract — the machine-readable interface the
// AI authoring loop consumes (docs/old/proposals/ai-diagnostics-contract.md).
//
// Pure types, NO imports: this module is the shared shape spoken by the CLI
// `--json` mode and (later) the in-browser `validate` tool (web/ imports
// ../src), so neither side can drift from the other.  The compile-time
// analogue of the runtime RFC 7807 `errors[]` format
// (docs/old/proposals/validation-error-extension.md).
// ---------------------------------------------------------------------------

/** LSP-compatible severities (design goal §7 — feeds VS Code + playground). */
export type JsonSeverity = "error" | "warning" | "info";

/**
 * A single node-addressed model edit (ai-authoring-loop.md §4).  The agent
 * edits *named model nodes*, not byte ranges, so patches survive canonical
 * re-printing.  `target` uses the same address space as the diagnostic `node`
 * and the outline (`<keyword> <Context>.<Decl>[.<member>]`).
 *
 * - `add`     — `target` is a free-body container (context / aggregate / value
 *               object / deployable); `source` is appended as a new member.
 * - `replace` — `target` is the node to replace; `source` is its new text.
 * - `remove`  — `target` is the node to delete; `source` is ignored.
 * - `insert`  — position-aware insert of `source` relative to `target`
 *               (`position`): `before` / `after` a sibling node, or
 *               `header-end` (just before the target declaration's opening
 *               `{` — for header clauses, e.g. `inheritanceUsing(...)`).
 * - `rename`  — `target` is the declaration to rename; `source` is the new
 *               name.  The declaration AND every use site (computed by the
 *               rename provider — cross-references included) are rewritten in
 *               one patch, so `X id` refs and expression uses stay resolved.
 */
export interface ModelPatch {
  op: "add" | "replace" | "remove" | "insert" | "rename";
  target: string;
  source?: string;
  /** Only for `op: "insert"`.  Defaults to `"after"`. */
  position?: "before" | "after" | "header-end";
}

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
  /** A model patch the agent can hand straight to `apply_patch`. */
  patch?: ModelPatch;
  options?: { summary: string; patch?: ModelPatch }[];
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

/** A declaration that has addressable members (aggregate / value object). */
export interface OutlineDecl {
  node: string;
  members: string[];
}

/** @deprecated alias of {@link OutlineDecl} kept for back-compat. */
export type OutlineAggregate = OutlineDecl;

export interface OutlineContext {
  name: string;
  aggregates: OutlineDecl[];
  valueObjects: OutlineDecl[];
  workflows: string[];
  pages: string[];
  enums: string[];
  events: string[];
  repositories: string[];
}

export interface OutlineSystem {
  name: string;
  contexts: OutlineContext[];
  deployables: string[];
}

export interface Outline {
  systems: OutlineSystem[];
  /** Contexts declared at model top level (no enclosing `system`). */
  contexts: OutlineContext[];
}

// --- Model view (loom_read_model) ------------------------------------------
// A resolved, semantic projection of the ENRICHED IR — the wire contract an
// agent needs to reason about what it's building, which the AST-level
// `Outline` (an address book of names) deliberately omits.  The canonical
// `wireShape` (id → properties → containments → derived, the exact ordered
// field list every backend's DTO emitter consumes) is surfaced per aggregate
// with each field's resolved type / optionality / provenance.

/** One field on an aggregate's wire DTO — a `WireField` flattened to
 *  serialisable primitives (the IR `TypeIR` rendered via `typeLabel`). */
export interface ModelWireField {
  name: string;
  /** `.ddd`-flavoured type label (`Order id`, `Money`, `string?`, `Line[]`). */
  type: string;
  optional: boolean;
  /** Where the field came from: `id` | `property` | `containment` | `derived`. */
  source: string;
}

/** An aggregate projected to its resolved wire shape. */
export interface ModelAggregate {
  name: string;
  /** Owning bounded context. */
  context: string;
  wire: ModelWireField[];
}

/** A deployable's manifest triple (mirrors the `generate` report). */
export interface ModelDeployable {
  name: string;
  platform: string;
  port: number;
}

/** One system: its deployable manifest plus every aggregate's wire shape. */
export interface ModelSystem {
  name: string;
  deployables: ModelDeployable[];
  aggregates: ModelAggregate[];
}

/** The resolved model — systems (with deployables) plus any top-level loose
 *  contexts' aggregates.  Empty `systems`/`contexts` when the source doesn't
 *  parse or lower. */
export interface ModelView {
  systems: ModelSystem[];
  /** Aggregates in contexts declared at model top level (no enclosing
   *  `system`) — the single-deployable legacy shape. */
  contexts: { name: string; aggregates: ModelAggregate[] }[];
}

// --- Primitive catalog (loom_list_primitives) ------------------------------

/** The closed page-body primitive vocabulary the UI walker admits — the set
 *  an agent may use in `page`/component bodies without declaring a type.
 *  Sourced from the walker registry's admissibility sets. */
export interface PrimitiveCatalog {
  /** Layout / content primitives (`List`, `Detail`, `Form`, `Stack`, …). */
  layout: string[];
  /** Sub-primitives valid only inside a parent (`Tab`, `Column`). */
  sub: string[];
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

// ---------------------------------------------------------------------------
// Navigational results (agent-tools-and-mcp.md §4b) — the read family over the
// LSP providers, addressed by symbol name (not line/character).  Every range is
// the canonical 0-based `JsonRange`; locations are single-source so the `uri` is
// implicit.  An unresolved or ambiguous `symbol` returns `NavError` with the
// candidate addresses — never a silent pick.
// ---------------------------------------------------------------------------

/** Why a symbol lookup did not resolve to exactly one node. */
export interface NavError {
  error: "not-found" | "ambiguous";
  /** Candidate canonical addresses (for `ambiguous`) — empty for `not-found`. */
  candidates: string[];
}

/** A located symbol — its canonical address, keyword kind, name-token range,
 *  and the address of its enclosing declaration (absent for a top-level node). */
export interface NavSymbol {
  address: string;
  kind: string;
  range: JsonRange;
  parent?: string;
}

/** A single usage site within the source (uri implicit — single-document). */
export interface NavLocation {
  range: JsonRange;
}

export type FindSymbolResult = NavSymbol | NavError;
export type ReferencesResult = { locations: NavLocation[] } | NavError;
export type HoverResult = { markdown: string } | NavError;

// ---------------------------------------------------------------------------
// Rewrite results (agent-tools-and-mcp.md §4b, rewrite trio) — rename /
// quickfix / unfold_macro RETURN edits, they never apply them (contract §3,
// tools are pure).  A single-source `WorkspaceEdit`: text edits the host
// applies to the buffer (uri implicit).  `EditError` covers the failure modes
// beyond symbol resolution — no fix for a code, an un-unfoldable macro, etc.
// ---------------------------------------------------------------------------

/** A single text edit — `range` to replace with `newText` (structurally an LSP
 *  `TextEdit`).  Insertions use an empty range; deletions an empty `newText`. */
export interface NavTextEdit {
  range: JsonRange;
  newText: string;
}

/** Edits to apply to the single source document, plus an optional human label
 *  (the refactor/quick-fix title). */
export interface EditResult {
  edits: NavTextEdit[];
  title?: string;
}

/** A rewrite that couldn't be produced.  `error` is the reason
 *  (`not-found` / `ambiguous` / `no-fix` / `cannot-unfold`); `candidates`
 *  lists the disambiguating options when `ambiguous`. */
export interface EditError {
  error: string;
  candidates?: string[];
  message?: string;
}

export type RenameResult = EditResult | EditError;
export type QuickfixResult = EditResult | EditError;
export type UnfoldMacroResult = EditResult | EditError;
