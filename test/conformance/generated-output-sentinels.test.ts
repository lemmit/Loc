import { describe, expect, it } from "vitest";
import { BACKEND_LABEL, BACKENDS } from "../fixtures/corpus/backends.js";
import { generateCorpusCase } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// No-sentinel gate (M-T9.8, hollow-work audit, graduated CI check #2).
//
// An emitter that hits a case it can't handle sometimes papers over the gap by
// writing a marker comment into otherwise-compiling output — a `// TODO`, a
// `# unsupported <kind>`, an `(* unsupported *)`.  The output compiles, the
// per-backend tsc/compile gate stays green, and the silent gap ships.  (Two
// real instances the 2026-07-13 audit found and fixed: the Feliz update-path
// `// TODO feliz update: <kind>` that dropped control flow, and the Phoenix
// applier `# unsupported applier statement` fallthroughs.)
//
// This gate makes that failure mode loud: it generates the whole shared corpus
// (`fixtures/corpus/*.ddd`) across every backend IN-MEMORY (no docker), and
// fails if any emitted file contains an unfinished-work marker.  The corpus is
// the same single-source-of-truth matrix the coverage/compile tiers ride on,
// so a new feature that lands a placeholder on any backend trips here per-PR.
//
// What is NOT a sentinel — deliberately excluded so the gate has zero false
// positives (verified against fresh `main`, all cells clean):
//   - Honest fail-fast throws.  `extern` stubs emit
//     `throw new Error("... is not implemented — write its body ...")`
//     (and .NET `NotImplementedException` / Java `UnsupportedOperationException`).
//     These are the escape hatch working as designed: they fail LOUDLY at
//     runtime, they are not a silent gap.  So "not implemented" and the two
//     exception *type names* are not in the sentinel set.
//   - The English word "placeholder" in prose comments / HTML `placeholder=`
//     attributes — too noisy to be a reliable signal.
//
// The set below is the unambiguous unfinished-work vocabulary, matched
// case-insensitively on word boundaries.  It is clean at zero today; keep it
// that way by FIXING the emitter (implement the kind, or convert the silent
// paper-over to an honest `loom.*` validator gate / fail-fast throw), never by
// adding an entry here.  If a legitimate emitted string ever collides, pin it
// in ALLOW below with the file it lands in and the reason.
// ---------------------------------------------------------------------------

/** Unfinished-work markers.  `\b…\b` so `UnsupportedOperationException` (one
 *  token, no trailing boundary after "Unsupported") is NOT matched — only a
 *  standalone `unsupported` comment is. */
const SENTINEL = /\b(?:TODO|FIXME|XXX|HACK|unsupported|unimplemented)\b/i;

/** Legitimate emitted collisions, pinned so the surface can't grow silently.
 *  Keyed by emitted file suffix; value is the reason.  EMPTY — the corpus is
 *  clean; an entry here is a documented, reviewed exception, not a TODO. */
const ALLOW: { fileSuffix: string; why: string }[] = [];

function isAllowed(rel: string): boolean {
  return ALLOW.some((a) => rel.endsWith(a.fileSuffix));
}

describe("generated output carries no unfinished-work sentinels (M-T9.8)", () => {
  const cells = CORPUS.flatMap((f) =>
    BACKENDS.filter((b) => f.backends.includes(b)).map((b) => ({ id: f.id, backend: b })),
  );

  it("scans a non-trivial number of (feature, backend) cells", () => {
    expect(cells.length).toBeGreaterThan(100);
  });

  it.each(cells)("$id / $backend — emits no TODO/unsupported markers", async ({ id, backend }) => {
    const files = await generateCorpusCase(id, backend);
    const offenders: string[] = [];
    for (const [rel, content] of files) {
      if (isAllowed(rel)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (SENTINEL.test(lines[i])) {
          offenders.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 100)}`);
        }
      }
    }
    expect(
      offenders,
      `${BACKEND_LABEL[backend]} emitted an unfinished-work marker for '${id}'. ` +
        "An emitter must not paper over a gap with a TODO/unsupported comment — " +
        "implement the kind, or fail loudly (an honest `loom.*` validator gate or a " +
        "fail-fast throw). See M-T9.8.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
