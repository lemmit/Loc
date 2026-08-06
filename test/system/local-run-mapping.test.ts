// Every CI gate must have a local-run recipe — pinned.
//
// docs/testing.md → "Running any CI gate locally — the reverse index" exists
// because agents were pushing commits just to see whether a gate passes: the
// forward docs ("here are the suites") never answered the backward question
// ("gate X is red / about to run — what's the local command?").  A mapping
// table only stays useful while it is COMPLETE: the first workflow added
// without a row re-teaches "this one can only run in CI", and the table decays
// back into the scattered prose it replaced.
//
// So: every workflow file under .github/workflows/ must be named inside that
// section (CI-only housekeeping rows count — they must SAY they are CI-only
// rather than be absent).  Deleting the section or adding an unmapped workflow
// fails the fast suite.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const SECTION_HEADING = "## Running any CI gate locally";

const doc = readFileSync(path.join(repoRoot, "docs/testing.md"), "utf8");
const start = doc.indexOf(SECTION_HEADING);
const rest = doc.slice(start + SECTION_HEADING.length);
const nextHeading = rest.search(/^## /m);
const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

const workflows = readdirSync(path.join(repoRoot, ".github/workflows"))
  .filter((f) => f.endsWith(".yml"))
  .sort();

describe("docs/testing.md maps every CI gate to a local command", () => {
  it("the reverse-index section exists", () => {
    expect(start, `docs/testing.md lost its "${SECTION_HEADING}" section`).toBeGreaterThan(-1);
  });

  it("the reader found the real workflow population", () => {
    // If the workflows dir moved, everything below would pass over nothing.
    expect(workflows.length).toBeGreaterThan(40);
  });

  for (const wf of workflows) {
    it(`${wf} has a row in the mapping table`, () => {
      expect(
        section.includes(`\`${wf}\``),
        `${wf} has no row in docs/testing.md's "${SECTION_HEADING}" table.\n` +
          "Add one: the local command that runs the same check (or an explicit " +
          "CI-only row with the reason). A gate without a local recipe teaches " +
          "agents to use CI as their compiler.",
      ).toBe(true);
    });
  }
});
