import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";
import { type Backend, PLATFORM_CLAUSE } from "./backends.js";
import { CORPUS } from "./manifest.js";

const CORPUS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Read a corpus feature's canonical (platform-agnostic) `.ddd` source. */
export function corpusSource(featureId: string): string {
  return fs.readFileSync(path.join(CORPUS_DIR, `${featureId}.ddd`), "utf8");
}

/** Specialise a corpus feature for one backend by swapping the platform token.
 *
 *  `persistence` selects a non-default persistence adapter on backends that have
 *  one (`dotnet` → `efcore` | `dapper`, `node` → `drizzle` | `mikroorm`).  It is
 *  a PLATFORM-CLAUSE override rather than a new `Backend` key on purpose: the
 *  manifest's `backends:` lists describe which backends a feature targets, and
 *  an adapter is a second axis over those, not a sixth backend. */
export function corpusSourceFor(
  featureId: string,
  backend: Backend,
  persistence?: string,
): string {
  const src = corpusSource(featureId);
  if (!src.includes("__PLATFORM__")) {
    throw new Error(`corpus/${featureId}.ddd is missing the __PLATFORM__ token`);
  }
  const clause = persistence
    ? `${PLATFORM_CLAUSE[backend]} { persistence: ${persistence} }`
    : PLATFORM_CLAUSE[backend];
  return src.replaceAll("__PLATFORM__", clause);
}

/** The deployable name every SINGLE-service corpus fixture uses → its emitted
 *  project dir. */
export const CORPUS_DEPLOYABLE = "d";

/**
 * The emitted project dirs a corpus feature's compile tier must build.
 *
 * Ordinary fixtures declare one deployable named `d`; a feature whose subject
 * IS the interaction between services (a typed in-system api call, say) needs
 * two, and both halves have to compile — the caller's client is derived from
 * the callee, so building only one of them tests half the feature.  The list
 * lives in the manifest so all five compile harnesses read one source.
 */
export function corpusProjectDirs(featureId: string): readonly string[] {
  return CORPUS.find((f) => f.id === featureId)?.deployables ?? [CORPUS_DEPLOYABLE];
}

/** Materialise a corpus feature specialised for one backend to a temp `.ddd`
 *  on disk, returning its path.  Lets the per-backend build gates generate the
 *  shared canonical fixture (one source of truth) instead of a per-backend
 *  duplicate `.ddd`.  The emitted project lands under `<out>/${CORPUS_DEPLOYABLE}`. */
export function materializeCorpusFixture(
  featureId: string,
  backend: Backend,
  destDir: string,
  persistence?: string,
): string {
  const suffix = persistence ? `${backend}-${persistence}` : backend;
  const dest = path.join(destDir, `${featureId}.${suffix}.ddd`);
  fs.writeFileSync(dest, corpusSourceFor(featureId, backend, persistence));
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
