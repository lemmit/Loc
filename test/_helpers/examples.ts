import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, independent of where this helper file lives in test/. */
export const repoRoot = path.resolve(here, "..", "..");

/** Read a repo-relative file (e.g. "examples/sales.ddd") as UTF-8 text. */
export const loadExample = (relPath: string): string =>
  readFileSync(path.join(repoRoot, relPath), "utf8");

/**
 * File-backed parse of a repo-relative `.ddd` file, using the full document
 * builder (needed for cross-file linking that `parseHelper` does not do).
 */
export async function loadExampleModel(
  relPath: string,
  { validate = true }: { validate?: boolean } = {},
): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, relPath)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: validate });
  return doc.parseResult.value as Model;
}
