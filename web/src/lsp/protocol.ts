// Lite LSP protocol over postMessage.  The worker hosts Langium
// services for the `ddd` language and answers requests one document
// at a time.  We don't speak full LSP — Monaco's provider APIs map
// onto a much smaller subset, and avoiding monaco-languageclient
// keeps us off the @codingame/monaco-vscode-api shim path.

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
}

export interface HoverResult {
  contents?: string;
  range?: Range;
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  range?: Range;
}

export interface DefinitionLocation {
  range: Range;
}

// Request envelope: { id, method, params }
// Response envelope: { id, result } or { id, error }
// Notification envelope: { method, params } (no id)

export type ClientRequest =
  | { method: "update"; params: { text: string; version: number } }
  | { method: "hover"; params: { position: Position } }
  | { method: "completion"; params: { position: Position } }
  | { method: "definition"; params: { position: Position } };

export type ServerNotification = {
  method: "diagnostics";
  params: { version: number; items: Diagnostic[] };
};

export interface RpcRequest {
  id: number;
  method: ClientRequest["method"];
  params: ClientRequest["params"];
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
}

export interface RpcNotification {
  method: ServerNotification["method"];
  params: ServerNotification["params"];
}

export type WorkerOutbound = RpcResponse | RpcNotification;
