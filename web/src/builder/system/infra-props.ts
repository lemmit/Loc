import { AstUtils, type AstNode } from "langium";
import type { Deployable, Model, Storage } from "../../../../src/language/generated/ast.js";
import { printStructural } from "../../../../src/language/print/index.js";
import { parseDdd } from "../parse";
import { spliceNode } from "../edit-engine";

// ---------------------------------------------------------------------------
// Scalar property editing for the infra constructs (storage / deployable).
// Same parse → mutate → reprint → splice path as field editing — these are
// plain string / number slots on the node, so no `$container` or linking is
// needed for the structural printer.
// ---------------------------------------------------------------------------

export const STORAGE_TYPES = [
  "postgres", "mysql", "sqlite", "inMemory", "redis", "elastic", "meilisearch", "kafka", "clickhouse", "bigquery",
];
export const PLATFORMS = ["node", "dotnet", "react", "static", "elixir"];

function findByName(ast: Model, type: string, name: string): AstNode | null {
  for (const n of AstUtils.streamAst(ast)) {
    if (n.$type === type && (n as { name?: unknown }).name === name) return n;
  }
  return null;
}

function commit(source: string, type: string, name: string, mutate: (node: AstNode) => void): string | null {
  const fresh = parseDdd(source);
  if (fresh.parserErrors.length > 0) return null;
  const node = findByName(fresh.ast, type, name);
  if (!node) return null;
  mutate(node);
  const next = spliceNode(source, node, printStructural(node));
  return parseDdd(next).parserErrors.length === 0 ? next : null;
}

// --- storage ---------------------------------------------------------------

export function storageType(node: AstNode): string | undefined {
  return node.$type === "Storage" ? (node as Storage).type : undefined;
}

export function setStorageType(source: string, name: string, type: string): string | null {
  return commit(source, "Storage", name, (n) => { (n as Storage).type = type as Storage["type"]; });
}

// --- deployable ------------------------------------------------------------

export function deployablePlatform(node: AstNode): string | undefined {
  return node.$type === "Deployable" ? (node as Deployable).platform : undefined;
}

export function deployablePort(node: AstNode): number | undefined {
  return node.$type === "Deployable" ? (node as Deployable).port : undefined;
}

export function setDeployablePlatform(source: string, name: string, platform: string): string | null {
  return commit(source, "Deployable", name, (n) => { (n as Deployable).platform = platform; });
}

export function setDeployablePort(source: string, name: string, port: number | undefined): string | null {
  return commit(source, "Deployable", name, (n) => { (n as Deployable).port = port; });
}
