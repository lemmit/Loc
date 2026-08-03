import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Feature-doc coverage gate (Phase 2 of docs/old/plans/global-test-coverage-plan.md).
//
// `corpus-coverage.test.ts` already enforces the FORWARD direction: every
// manifest row's `doc:` citation resolves to a real `docs/<doc>.md`.  This gate
// closes the INVERSE — a *documented* domain/language feature with no corpus
// fixture proving it generates.  Without it, someone can write `docs/foo.md`
// describing a shippable feature and never add a `foo.ddd`, and no gate notices
// the coverage hole (the plan: "a documented feature with no corpus fixture
// fails — keeps docs and tests honest with each other").
//
// The curated input is FEATURE_DOCS: the docs that describe a corpus-eligible
// domain/language feature — one a canonical `.ddd` fixture should prove
// generatable across the backends.  (Meta/reference docs — architecture,
// generators, tools, platforms, … — describe the toolchain, not an authorable
// feature, and are deliberately NOT in the set.)  From it the gate derives two
// partitions against the live manifest:
//
//   COVERED — cited by >=1 manifest row (a fixture proves it).
//   GAP     — documented but no fixture yet; must appear in KNOWN_GAPS.
//
// So a NEW feature doc added without a fixture fails (its name lands in GAP but
// not KNOWN_GAPS), and DROPPING a covered feature's only fixture fails the same
// way — you can't silently regress corpus coverage.  KNOWN_GAPS is a ratcheted
// escape valve (allowlist-ratchet.test.ts pins its count): draining a gap means
// adding the fixture + deleting the entry here, and the exact-match assertion
// forces that bookkeeping.
// ---------------------------------------------------------------------------

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");

/** Docs that describe a corpus-eligible domain/language feature.  Each must
 *  either be cited by a manifest row (COVERED) or listed in KNOWN_GAPS. */
const FEATURE_DOCS: readonly string[] = [
  // Covered today — each cited by >=1 corpus manifest row.  Listed here so
  // dropping a feature's last fixture (un-citing its doc) fails the gate rather
  // than silently regressing coverage.
  "audit",
  "auth",
  "capabilities",
  "channels",
  "criterion",
  "domain-services",
  "extern",
  "inheritance",
  "language",
  "payloads",
  "provenance",
  "resources",
  "scaffold-macros",
  "tenancy",
  "workflow",
];

/** FEATURE_DOCS not yet cited by any manifest row — the honest coverage gaps.
 *  Ratcheted in test/platform/allowlist-ratchet.test.ts (can only shrink).
 *  Drain one by adding a `<feature>.ddd` + a manifest row citing the doc, then
 *  delete its entry here (and lower the ratchet max in the same PR). */
const KNOWN_GAPS: readonly string[] = [
  // Empty — every documented feature has a corpus fixture.  A new feature doc
  // with no fixture fails the gate; acknowledge it here (with an open tracker)
  // only if the fixture is a genuine follow-up, and raise the allowlist-ratchet
  // max in the same reviewed diff.
];

/** Docs cited by >=1 manifest row. */
const citedDocs = new Set(CORPUS.map((f) => f.doc).filter((d): d is string => Boolean(d)));

describe("feature-doc coverage — documented features have a corpus fixture (Phase 2)", () => {
  it("every FEATURE_DOC names a real docs/<doc>.md", () => {
    const missing = FEATURE_DOCS.filter((d) => !fs.existsSync(path.join(docsDir, `${d}.md`)));
    expect(missing, `FEATURE_DOCS entries with no docs/*.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("KNOWN_GAPS is a subset of FEATURE_DOCS", () => {
    const stray = KNOWN_GAPS.filter((d) => !FEATURE_DOCS.includes(d));
    expect(stray, `KNOWN_GAPS entries not registered as FEATURE_DOCS: ${stray.join(", ")}`).toEqual(
      [],
    );
  });

  it("every doc a manifest row cites is a registered FEATURE_DOC", () => {
    // A fixture that cites docs/X.md has made X a covered feature — X must be in
    // FEATURE_DOCS so the coverage claim is tracked (and protected from regress).
    const unregistered = [...citedDocs].filter((d) => !FEATURE_DOCS.includes(d)).sort();
    expect(
      unregistered,
      `manifest cites these docs but they aren't in FEATURE_DOCS — add them ` +
        `(they're now covered): ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("a documented feature with no corpus fixture is an acknowledged KNOWN_GAP", () => {
    // The gate: FEATURE_DOCS minus the covered ones must EXACTLY equal KNOWN_GAPS.
    // An extra means a documented feature lost/never-had a fixture (add one, or
    // acknowledge it here).  A missing means a gap got a fixture — drain it from
    // KNOWN_GAPS (and lower the ratchet max).
    const gaps = FEATURE_DOCS.filter((d) => !citedDocs.has(d)).sort();
    expect(
      gaps,
      "documented-feature corpus coverage drifted from KNOWN_GAPS. Extra entries: " +
        "a feature doc has no corpus fixture — add a `<feature>.ddd` + manifest row, " +
        "or acknowledge it in KNOWN_GAPS. Missing entries: a gap now has a fixture — " +
        "delete it from KNOWN_GAPS and lower the allowlist-ratchet max.",
    ).toEqual([...KNOWN_GAPS].sort());
  });
});
