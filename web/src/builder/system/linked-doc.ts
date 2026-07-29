import { EmptyFileSystem, URI, type LangiumDocument } from "langium";
import { createDddServices } from "../../../../src/language/ddd-module.js";
import type { Model } from "../../../../src/language/generated/ast.js";

// Build a fully-linked Langium document on the main thread.
//
// The playground's normal parse (web/src/builder/parse.ts) runs only the
// Langium parser — no linking — so `.ref` targets stay unresolved.  Anything
// that needs cross-reference resolution (rename's `findReferences`, the
// expression editor's type-directed member completion) *builds* the source,
// which parses + links + computes scopes.  Async by nature; callers run it off
// the render path and cache.
//
// The Langium services instance is REUSED across calls (it used to be
// constructed per call — a full DI graph + parser + macro registration on every
// rename / coverage / wire-shape / expression-hint call, which is one of the
// main-thread allocation storms that pushes a mobile tab into an OOM kill).
//
// Reuse is keyed by URI rather than global, and that is deliberate:
//
//   * A services instance owns a `LangiumDocuments` workspace and a global
//     symbol index.  If two callers with different URIs shared one instance,
//     both documents would sit in the same workspace and the same global
//     scope — a declaration in `loom-scratch.ddd` could win the scope lookup
//     for a reference in `loom-rename.ddd`, so `findReferences` on the rename
//     document's own declaration would silently come back empty and the rename
//     would rewrite the declaration without its references.
//   * Keyed by URI, every instance holds AT MOST ONE document — exactly the
//     isolation the old throwaway-per-call code had — while consecutive calls
//     on the same URI (the hot paths: expression hints, coverage overlay,
//     wire shape) pay for the DI graph once.
//
// Re-entry on the same URI evicts the previous document through
// `DocumentBuilder.update([], [uri])` rather than `LangiumDocuments.delete-
// Document`, because only the former runs `cleanUpDeleted` (drops the index
// entry + build state) and emits the update event the `DocumentCache` /
// `WorkspaceCache` layers evict on.  With a throwaway instance the difference
// never mattered; with reuse, skipping it would leave stale symbols behind.

type DddServices = ReturnType<typeof createDddServices>["Ddd"];

export interface LinkedDoc {
  model: Model;
  services: DddServices;
  uri: URI;
  doc: LangiumDocument;
}

const servicesByUri = new Map<string, DddServices>();
let servicesCreated = 0;

function servicesFor(uriStr: string): DddServices {
  const existing = servicesByUri.get(uriStr);
  if (existing) return existing;
  const created = createDddServices(EmptyFileSystem).Ddd;
  servicesCreated++;
  servicesByUri.set(uriStr, created);
  return created;
}

/** Test seam — how many Langium services instances have been constructed.
 *  Reuse is invisible from the outside (same output either way), so this is
 *  the only thing a unit test can assert on. */
export function linkedDocServicesCreated(): number {
  return servicesCreated;
}

/** Test seam — drop every cached services instance (and the counter). */
export function resetLinkedDocServices(): void {
  servicesByUri.clear();
  servicesCreated = 0;
}

export async function buildLinkedDocument(
  source: string,
  uriStr = "memory:///loom-scratch.ddd",
): Promise<LinkedDoc | null> {
  const services = servicesFor(uriStr);
  const shared = services.shared;
  const uri = URI.parse(uriStr);

  const docs = shared.workspace.LangiumDocuments;
  // Full eviction (index + build state + caches), not just a map delete.
  if (docs.hasDocument(uri)) await shared.workspace.DocumentBuilder.update([], [uri]);
  const doc = shared.workspace.LangiumDocumentFactory.fromString(source, uri);
  docs.addDocument(doc);
  await shared.workspace.DocumentBuilder.build([doc], { validation: false });

  const model = doc.parseResult?.value as Model | undefined;
  return model ? { model, services, uri, doc } : null;
}

/** Convenience for callers that only need the linked AST. */
export async function buildLinkedModel(source: string): Promise<Model | null> {
  return (await buildLinkedDocument(source))?.model ?? null;
}
