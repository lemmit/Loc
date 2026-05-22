import { EmptyFileSystem, URI, type LangiumDocument } from "langium";
import { createDddServices } from "../../../../src/language/ddd-module.js";
import type { Model } from "../../../../src/language/generated/ast.js";

// Build a fully-linked Langium document on the main thread.
//
// The playground's normal parse (web/src/builder/parse.ts) runs only the
// Langium parser — no linking — so `.ref` targets stay unresolved.  Anything
// that needs cross-reference resolution (rename's `findReferences`, the
// expression editor's type-directed member completion) spins up a throwaway
// Langium instance and *builds* the source, which parses + links + computes
// scopes.  Async by nature; callers run it off the render path and cache.

type DddServices = ReturnType<typeof createDddServices>["Ddd"];

export interface LinkedDoc {
  model: Model;
  services: DddServices;
  uri: URI;
  doc: LangiumDocument;
}

export async function buildLinkedDocument(
  source: string,
  uriStr = "memory:///loom-scratch.ddd",
): Promise<LinkedDoc | null> {
  const services = createDddServices(EmptyFileSystem).Ddd;
  const shared = services.shared;
  const uri = URI.parse(uriStr);

  const docs = shared.workspace.LangiumDocuments;
  if (docs.hasDocument(uri)) await docs.deleteDocument(uri);
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
