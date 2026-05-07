/// <reference lib="webworker" />
import { EmptyFileSystem, type LangiumDocument } from "langium";
import { URI } from "langium";
import type {
  CompletionParams,
  DefinitionParams,
  HoverParams,
  Position as LspPosition,
  MarkupContent,
} from "vscode-languageserver";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type {
  CompletionItem,
  DefinitionLocation,
  Diagnostic,
  HoverResult,
  Range,
  RpcRequest,
  RpcResponse,
  WorkerOutbound,
} from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

// One in-memory document drives the playground.  When we expand to
// multi-file projects this becomes a map keyed by URI, but for Phase 1
// the editor and the worker agree on a single virtual URI.
const DOC_URI = URI.parse("inmemory:///main.ddd");

const services = createDddServices(EmptyFileSystem);
const documents = services.shared.workspace.LangiumDocuments;
const builder = services.shared.workspace.DocumentBuilder;
const hover = services.Ddd.lsp.HoverProvider;
const completion = services.Ddd.lsp.CompletionProvider;
const definition = services.Ddd.lsp.DefinitionProvider;

let currentVersion = 0;

async function ensureDocument(text: string, version: number): Promise<LangiumDocument> {
  // Recreate the document on every update.  Langium's
  // DocumentBuilder.update API exists but is geared toward
  // incremental edits via TextDocument changes; for a single
  // editor-driven document, dropping and re-adding is simpler and
  // not measurably slower for Loom-sized inputs.
  const existing = documents.all.find((d) => d.uri.toString() === DOC_URI.toString());
  if (existing) documents.deleteDocument(existing.uri);
  const doc = documents.createDocument(DOC_URI, text);
  await builder.build([doc], { validation: true });
  currentVersion = version;
  return doc;
}

function getDocument(): LangiumDocument | undefined {
  return documents.all.find((d) => d.uri.toString() === DOC_URI.toString());
}

function toRange(r: { start: LspPosition; end: LspPosition }): Range {
  return {
    start: { line: r.start.line, character: r.start.character },
    end: { line: r.end.line, character: r.end.character },
  };
}

function severityFromLsp(s: number | undefined): Diagnostic["severity"] {
  switch (s) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "info";
  }
}

async function pushDiagnostics(doc: LangiumDocument, version: number): Promise<void> {
  const items: Diagnostic[] = (doc.diagnostics ?? []).map((d) => ({
    range: toRange(d.range),
    severity: severityFromLsp(d.severity),
    message: d.message,
    source: typeof d.source === "string" ? d.source : "loom",
  }));
  const note: WorkerOutbound = {
    method: "diagnostics",
    params: { version, items },
  };
  self.postMessage(note);
}

function flattenHoverContents(
  c: string | MarkupContent | { language: string; value: string } | unknown[],
): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(flattenHoverContents as (x: unknown) => string).join("\n\n");
  if (c && typeof c === "object" && "value" in (c as Record<string, unknown>)) {
    return String((c as { value: unknown }).value);
  }
  return "";
}

async function handleHover(position: LspPosition): Promise<HoverResult> {
  const doc = getDocument();
  if (!doc || !hover) return {};
  const params: HoverParams = {
    textDocument: { uri: doc.uri.toString() },
    position,
  };
  const result = await hover.getHoverContent(doc, params);
  if (!result) return {};
  return {
    contents: flattenHoverContents(result.contents as never),
    range: result.range ? toRange(result.range) : undefined,
  };
}

async function handleCompletion(position: LspPosition): Promise<{ items: CompletionItem[] }> {
  const doc = getDocument();
  if (!doc || !completion) return { items: [] };
  const params: CompletionParams = {
    textDocument: { uri: doc.uri.toString() },
    position,
  };
  const list = await completion.getCompletion(doc, params);
  if (!list) return { items: [] };
  const items: CompletionItem[] = list.items.map((it) => {
    const insert =
      typeof it.insertText === "string"
        ? it.insertText
        : it.textEdit && "newText" in it.textEdit
          ? it.textEdit.newText
          : it.label;
    return {
      label: it.label,
      kind: it.kind,
      detail: it.detail,
      documentation:
        typeof it.documentation === "string"
          ? it.documentation
          : it.documentation?.value,
      insertText: insert,
    };
  });
  return { items };
}

async function handleDefinition(position: LspPosition): Promise<DefinitionLocation[]> {
  const doc = getDocument();
  if (!doc || !definition) return [];
  const params: DefinitionParams = {
    textDocument: { uri: doc.uri.toString() },
    position,
  };
  const links = await definition.getDefinition(doc, params);
  if (!links) return [];
  return links.map((l) => ({
    range: toRange(l.targetSelectionRange ?? l.targetRange),
  }));
}

self.onmessage = async (ev: MessageEvent<RpcRequest>) => {
  const req = ev.data;
  const response: RpcResponse = { id: req.id };
  try {
    switch (req.method) {
      case "update": {
        const params = req.params as { text: string; version: number };
        const doc = await ensureDocument(params.text, params.version);
        await pushDiagnostics(doc, params.version);
        response.result = null;
        break;
      }
      case "hover": {
        const params = req.params as { position: LspPosition };
        response.result = await handleHover(params.position);
        break;
      }
      case "completion": {
        const params = req.params as { position: LspPosition };
        response.result = await handleCompletion(params.position);
        break;
      }
      case "definition": {
        const params = req.params as { position: LspPosition };
        response.result = await handleDefinition(params.position);
        break;
      }
      default:
        response.error = { message: `Unknown method: ${(req as { method: string }).method}` };
    }
  } catch (err) {
    response.error = { message: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};

// Surface the initial version so the main thread can correlate the
// first diagnostics push.
void currentVersion;
