// One `authUserImport(...)` call per python repository builder.
//
// `authUserImport(needsUser, needsAccessor, needsGetter)` owns BOTH the module
// path and the sorted name list, and returns one whole `from app.auth.user
// import …` line.  So every reason a builder needs a principal symbol has to
// flow into a SINGLE call: two calls emit two import lines from the same
// module, and ruff fails the generated project on the redefinition.
//
// WHY A SOURCE SCAN, not an output assertion.  The defect is structural — a
// second call site appearing beside an existing one — and it is invisible to
// every other check in the repo: it typechecks cleanly, and reproducing it
// through emitted output needs an aggregate that simultaneously carries a read
// mask AND a narrowed write scope, which in turn needs the whole `tenancy by` +
// `tenantOwned` + `policy { allow deep }` scaffold.  A grep over the four
// builders states the invariant directly, at the layer where it breaks.  Same
// pattern as pipeline-layering / diagnostic-catalog / walker-stdlib-completeness.
//
// This ran red for real.  Merging #2694 (in-app write guard, wants
// `require_current_user`) into the branch adding pairwise F6's read-mask
// projection (wants `current_user`) put both calls in the event-sourced
// builder — each side had added one next to where the other's would land, and
// git kept both.  `tsc` only objected to an unrelated stale import two lines
// away; without that coincidence the duplicate ships and surfaces as a ruff
// error inside a generated project, three layers from the cause.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const BUILDERS = [
  "repository-builder.ts",
  "repository-document-builder.ts",
  "repository-embedded-builder.ts",
  "repository-eventsourced-builder.ts",
] as const;

const dir = path.resolve(__dirname, "../../../src/generator/python");

describe("each python repository builder calls authUserImport at most once", () => {
  for (const file of BUILDERS) {
    it(file, () => {
      const src = readFileSync(path.join(dir, file), "utf8");
      // Call sites only — the `export function authUserImport(` definition and
      // any doc-comment mention are excluded by requiring a non-word char that
      // is not part of a declaration before the name.
      const calls = [...src.matchAll(/(?<!function\s)\bauthUserImport\(/g)];
      expect(
        calls.length,
        `${file} has ${calls.length} authUserImport call sites; fold every reason ` +
          `into ONE call (the helper sorts and joins the names itself).`,
      ).toBeLessThanOrEqual(1);
    });
  }
});
