// Build-worker protocol — request/response shapes for kicking off a
// generate run from the main thread.  Kept separate from the LSP
// worker so editor latency doesn't compete with potentially heavier
// generator + (later) bundler work.

export interface BuildDiagnostic {
  severity: "error" | "warning";
  message: string;
  line?: number;
  column?: number;
  source?: string;
}

export interface VirtualFile {
  path: string;
  content: string;
  size: number;
}

export type GenerateMode = "system" | "ts" | "none";

export interface GenerateOk {
  ok: true;
  mode: GenerateMode;
  files: VirtualFile[];
  diagnostics: BuildDiagnostic[];
}

export interface GenerateFail {
  ok: false;
  diagnostics: BuildDiagnostic[];
}

export type GenerateResult = GenerateOk | GenerateFail;

export interface BuildRpcRequest {
  id: number;
  method: "generate";
  params: { text: string };
}

export interface BuildRpcResponse {
  id: number;
  result?: GenerateResult;
  error?: { message: string };
}
