// Diagnostic shape consumed by the playground's Problems panel.  Produced in
// LoomEditor from Monaco markers (which the language client populates over
// LSP).  The former hand-rolled postMessage RPC envelopes were retired when
// the playground moved to monaco-languageclient.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  range: Range;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  /** The stable `loom.*` code (M-T8.18) — what the Problems row's code chip,
   *  docs link and Fix action key on.  Absent for a diagnostic that carries
   *  none (a bare parser error). */
  code?: string;
}
