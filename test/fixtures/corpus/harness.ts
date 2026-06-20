import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";
import { type Backend, PLATFORM_CLAUSE } from "./backends.js";

const CORPUS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Read a corpus feature's canonical (platform-agnostic) `.ddd` source. */
export function corpusSource(featureId: string): string {
  return fs.readFileSync(path.join(CORPUS_DIR, `${featureId}.ddd`), "utf8");
}

/** Specialise a corpus feature for one backend by swapping the platform token. */
export function corpusSourceFor(featureId: string, backend: Backend): string {
  const src = corpusSource(featureId);
  if (!src.includes("__PLATFORM__")) {
    throw new Error(`corpus/${featureId}.ddd is missing the __PLATFORM__ token`);
  }
  return src.replaceAll("__PLATFORM__", PLATFORM_CLAUSE[backend]);
}

/** The deployable name every corpus fixture uses → its emitted project dir. */
export const CORPUS_DEPLOYABLE = "d";

/** Materialise a corpus feature specialised for one backend to a temp `.ddd`
 *  on disk, returning its path.  Lets the per-backend build gates generate the
 *  shared canonical fixture (one source of truth) instead of a per-backend
 *  duplicate `.ddd`.  The emitted project lands under `<out>/${CORPUS_DEPLOYABLE}`. */
export function materializeCorpusFixture(featureId: string, backend: Backend, destDir: string): string {
  const dest = path.join(destDir, `${featureId}.${backend}.ddd`);
  fs.writeFileSync(dest, corpusSourceFor(featureId, backend));
  return dest;
}

/** Generate a corpus feature for one backend, in-memory (no docker).
 *  Asserts the source parses + validates cleanly first — a fixture with a
 *  grammar or validation error must fail the gate, not silently emit a partial
 *  model from a broken AST. */
export async function generateCorpusCase(
  featureId: string,
  backend: Backend,
): Promise<Map<string, string>> {
  const source = corpusSourceFor(featureId, backend);
  const { model, errors } = await parseString(source);
  if (errors.length > 0) {
    throw new Error(`parse/validation errors:\n${errors.join("\n")}`);
  }
  return generateSystems(model).files;
}
