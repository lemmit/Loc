import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKEND_LABEL, type Backend } from "../fixtures/corpus/backends.js";
import { corpusProjectDirs, generateCorpusCase } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Corpus coverage gate (Phase 0/1 of docs/old/plans/global-test-coverage-plan.md).
//
// The shared fixture corpus declares, per feature, which backends it generates
// on (`manifest.ts`).  This gate enforces that matrix WITHOUT docker: every
// declared (feature, backend) cell must run the full lower → enrich → validate
// → system-compose pipeline and emit a non-trivial file map.  It catches the
// high-frequency failure mode — a feature that crashes lowering/enrichment on
// some backend — across all six backends in seconds, per-PR.
//
// This is a GENERATION gate, not a compile gate: the per-backend compile/runtime
// tiers (docker, nightly) consume the same corpus on top of this floor.
//
// Two invariants:
//   1. Completeness — every `.ddd` in the corpus has a manifest row, and every
//      row points at a real `.ddd`.  No silent, untested fixtures.
//   2. Coverage — every declared cell generates cleanly.
// ---------------------------------------------------------------------------

const CORPUS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/corpus");

const fixtureFiles = fs
  .readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith(".ddd"))
  .map((f) => f.replace(/\.ddd$/, ""))
  .sort();

describe("corpus coverage — completeness", () => {
  it("every corpus .ddd has a manifest row", () => {
    const declared = new Set(CORPUS.map((f) => f.id));
    const orphans = fixtureFiles.filter((id) => !declared.has(id));
    expect(orphans, `corpus .ddd files with no manifest row: ${orphans.join(", ")}`).toEqual([]);
  });

  it("every manifest row points at a real .ddd", () => {
    const present = new Set(fixtureFiles);
    const missing = CORPUS.filter((f) => !present.has(f.id)).map((f) => f.id);
    expect(missing, `manifest rows with no .ddd: ${missing.join(", ")}`).toEqual([]);
  });

  it("every manifest row declares at least one backend", () => {
    const empty = CORPUS.filter((f) => f.backends.length === 0).map((f) => f.id);
    expect(empty, `manifest rows with no backends: ${empty.join(", ")}`).toEqual([]);
  });

  it("every referenced reference doc exists under docs/", () => {
    const docsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../docs");
    const dangling = CORPUS.filter(
      (f) => f.doc && !fs.existsSync(path.join(docsDir, `${f.doc}.md`)),
    ).map((f) => `${f.id} → docs/${f.doc}.md`);
    expect(dangling, `manifest rows referencing a missing doc: ${dangling.join(", ")}`).toEqual([]);
  });
});

// The file each backend drops at the ROOT of a generated project — how a
// top-level dir in the emitted map is recognised as something a compile tier
// would build.
const PROJECT_MARKER: Record<Backend, (basename: string) => boolean> = {
  node: (f) => f === "package.json",
  dotnet: (f) => f.endsWith(".csproj"),
  java: (f) => f === "build.gradle" || f === "build.gradle.kts",
  python: (f) => f === "pyproject.toml",
  vanilla: (f) => f === "mix.exs",
};

/** Top-level dirs in an emitted file map that hold a DEPLOYABLE's project.
 *
 *  The backend marker alone is not enough: the emitted `e2e/` harness is also a
 *  node package.  A deployable is what compose BUILDS, so it is the pairing of
 *  the marker with a root `Dockerfile` that identifies one. */
function emittedProjectDirs(files: Map<string, string>, backend: Backend): string[] {
  const marked = new Set<string>();
  const dockerised = new Set<string>();
  for (const rel of files.keys()) {
    const [dir, ...rest] = rel.split("/");
    if (!dir || rest.length !== 1) continue; // only the project ROOT
    const base = rest[0] ?? "";
    if (PROJECT_MARKER[backend](base)) marked.add(dir);
    if (base === "Dockerfile") dockerised.add(dir);
  }
  return [...marked].filter((d) => dockerised.has(d)).sort();
}

describe("corpus coverage — generation matrix", () => {
  for (const feature of CORPUS) {
    for (const backend of feature.backends) {
      it(`${feature.id} generates on ${BACKEND_LABEL[backend]}`, async () => {
        const files = await generateCorpusCase(feature.id, backend);
        expect(
          files.size,
          `${feature.id} on ${BACKEND_LABEL[backend]} emitted no files`,
        ).toBeGreaterThan(0);

        // The compile tiers can't discover what to build — they read the
        // manifest's `deployables` (defaulting to the single `d`) BEFORE
        // generating.  A fixture that renames or adds a deployable without
        // saying so turns those docker gates into silent no-ops, or fails them
        // hours later with a bare "project emitted: expected false to be true".
        // Catch the drift here, per-PR, in milliseconds.
        expect(
          emittedProjectDirs(files, backend),
          `${feature.id} on ${BACKEND_LABEL[backend]}: emitted project dirs disagree with the manifest's \`deployables\` — update test/fixtures/corpus/manifest.ts`,
        ).toEqual([...corpusProjectDirs(feature.id)].sort());
      });
    }
  }
});
