import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystemFilesFromProject } from "../_helpers/generate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// `generate system` is a PURE FUNCTION of its input.
//
// It was not: `src/platform/elixir.ts` minted `SECRET_KEY_BASE` with
// `crypto.getRandomValues()` inside `composeService`, so ONE line of
// `docker-compose.yml` (and the matching k8s Secret) re-randomised on every
// run.  Codegen is otherwise byte-identical across runs, which is what made a
// single drifting byte so expensive:
//
//   * regenerating in place — the documented workflow that `--dry-run`,
//     `.loomignore` and scaffold-once exist to make safe — always rewrote
//     `docker-compose.yml`, so every regen produced a spurious VCS diff;
//   * and it ROTATED the session-signing key of a running dev stack, logging
//     every user out of a `docker compose up` that was only meant to pick up
//     a model change.
//
// This gate is deliberately shaped as "generate twice from two INDEPENDENT
// loads of the same source, compare every emitted path and byte" rather than
// "assert SECRET_KEY_BASE is stable": it catches the next generate-time
// `Date.now()` / `Math.random()` / `crypto.getRandomValues()` / iteration-order
// wobble anywhere in the pipeline, on any backend, not just this one.
//
// Corpus: `showcase.ddd` covers all five backends (node, dotnet, python, java,
// elixir) plus static frontend hosts in one system; `acme.ddd` covers the
// react frontend; the ERP is the biggest multi-file model in the tree (six
// imported files, 25 aggregates).
// ---------------------------------------------------------------------------

const CASES = ["examples/showcase.ddd", "examples/acme.ddd", "web/src/examples/erp/main.ddd"];

/** Load + generate through the gated helper (phases ①/④/⑦ asserted), from a
 *  FRESH Langium service instance, so run 2 shares no parser or document state
 *  with run 1 and the comparison is between two genuinely independent
 *  generations. */
const generateOnce = (file: string): Promise<Map<string, string>> =>
  generateSystemFilesFromProject(path.join(repoRoot, file), { emitKubernetes: true });

describe("generate system is deterministic", () => {
  it.each(CASES)("%s generates byte-identical output twice", async (file) => {
    const first = await generateOnce(file);
    const second = await generateOnce(file);

    // Same file set, in the same order.
    expect([...second.keys()]).toEqual([...first.keys()]);

    // Same bytes.  Report the DIFFERING PATHS (not a 400k-line diff) so a
    // failure names the emitter that drifted.
    const drifted = [...first.keys()].filter((p) => first.get(p) !== second.get(p));
    expect(drifted).toEqual([]);
  }, 120_000);
});
