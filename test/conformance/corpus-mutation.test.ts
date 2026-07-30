import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/parse.js";
import { BACKEND_LABEL, type Backend, PLATFORM_CLAUSE } from "../fixtures/corpus/backends.js";
import { corpusSource } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import { mutationsFor } from "../fixtures/corpus/mutations.js";

// ---------------------------------------------------------------------------
// Corpus mutation gate — the honest-gate invariant, asserted on programs nobody
// wrote by hand.
//
// `corpus-coverage` proves the 32 authored fixtures generate on every declared
// backend.  `generated-output-sentinels` proves none of that output carries a
// `// TODO`.  Both are strong, and both are blind to any program not in the 32
// — which is exactly how G1 and G2 (#2316) shipped: accepted models that
// produced an application unable to start.
//
// This gate closes the INPUT half.  For each fixture x mutation it asserts the
// one invariant the toolchain owes a caller:
//
//     REJECT with a `loom.*` diagnostic,  OR  emit cleanly on every declared
//     backend.
//
// "Accepted, emitted, and broken" is the failure.  A mutation that finds no
// site in a fixture returns null and is skipped — not every seam exists in
// every feature.
//
// SCOPE.  The full product (32 fixtures x ~30 mutations x 5 backends) is ~5k
// in-memory generations, too slow for the fast suite.  Per-PR runs the
// representative slice below — fixtures chosen to cover the three declaration
// kinds plus the capability-carrying features, where the M1 seam actually
// bites.  The full cross-product runs nightly (LOOM_MUTATION_FULL=1).
// ---------------------------------------------------------------------------

/** Fixtures the fast tier mutates.  `core-domain` alone carries an aggregate, an
 *  entity part and a value object; the rest are the features that actually
 *  apply a capability, which is what M1 collides with. */
const FAST_SLICE = [
  "core-domain",
  "field-defaults",
  "stamps",
  "tenancy-owned",
  "tenancy-hierarchy",
  "provenance",
  "event-sourcing",
];

const FULL = process.env.LOOM_MUTATION_FULL === "1";
const FEATURES = FULL ? CORPUS : CORPUS.filter((f) => FAST_SLICE.includes(f.id));

/** The `loom.*` codes carried by a parse's error diagnostics.  The code lives on
 *  `Diagnostic.code` (or `data.code` for the IR phase) — NOT in the rendered
 *  message, which is what `parseString`'s `errors` gives back. */
function loomCodes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics
    .filter((d) => d.severity === 1)
    .map((d) => {
      if (typeof d.code === "string") return d.code;
      return (d.data as { code?: string } | undefined)?.code ?? "";
    })
    .filter((c) => c.startsWith("loom."));
}

/** Validate a mutated source once, on `node` — a rejection is model-level, so
 *  it does not depend on which backend the deployable targets. */
async function validateOnce(
  source: string,
): Promise<{ ok: true } | { ok: false; codes: string[]; errors: string[] }> {
  const { diagnostics, errors } = await parseString(source.replaceAll("__PLATFORM__", "node"));
  if (errors.length === 0) return { ok: true };
  return { ok: false, codes: loomCodes(diagnostics), errors };
}

/** Emit an already-validated mutated source on one backend, in-memory. */
async function emitOn(source: string, backend: Backend): Promise<Map<string, string>> {
  const specialised = source.replaceAll("__PLATFORM__", PLATFORM_CLAUSE[backend]);
  const { model } = await parseString(specialised, { validate: false });
  return generateSystems(model).files;
}

describe("corpus mutation — reject with a loom.* code, or emit on every declared backend", () => {
  for (const feature of FEATURES) {
    const source = corpusSource(feature.id);

    for (const mutation of mutationsFor()) {
      it(`${feature.id} x ${mutation.id}`, async () => {
        // The mutation needs the fixture's AST to pick its site; parse the
        // canonical source on `node` (the platform token is irrelevant to the
        // domain shape the mutation edits).
        const { model } = await parseString(source.replaceAll("__PLATFORM__", "node"), {
          validate: false,
        });
        const mutated = mutation.apply(source, model);
        if (mutated === null) return; // seam absent from this fixture

        // Arm 1 — rejected.  Honest, PROVIDED a `loom.*` rule owns the refusal:
        // a bare parser error or an unresolved-reference cascade would mean the
        // mutation broke the program by accident, not that the seam was caught.
        const verdict = await validateOnce(mutated);
        if (!verdict.ok) {
          expect(
            verdict.codes,
            `${feature.id} x ${mutation.id} was rejected, but by no loom.* rule ` +
              `(seam: ${mutation.seam})\n${verdict.errors.join("\n")}`,
          ).not.toHaveLength(0);
          return;
        }

        // Arm 2 — accepted, so it must emit on every backend the feature
        // declares.  This is where an accepted-but-broken model surfaces.
        for (const backend of feature.backends) {
          const files = await emitOn(mutated, backend);
          expect(
            files.size,
            `${feature.id} x ${mutation.id} accepted but emitted no files on ` +
              `${BACKEND_LABEL[backend]} (seam: ${mutation.seam})`,
          ).toBeGreaterThan(0);
        }
      });
    }
  }
});
