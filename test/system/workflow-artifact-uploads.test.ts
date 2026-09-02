// An artifact upload from a DOT-directory must opt in to hidden files.
//
// `actions/upload-artifact@v4` defaults `include-hidden-files: false` and skips
// anything under a path segment beginning with `.` — so a step whose glob is
// perfectly correct uploads NOTHING, and says so only in a `##[warning]` that
// nobody reads on a green run:
//
//     ##[warning]No files were found with the provided path:
//       test/behavioral/.work-schemathesis*/*/schemathesis.log …
//
// Measured on the 2026-08-30 dispatch: every schemathesis leg emitted that
// warning. The reports, app-error logs and ndjson findings a red leg is
// diagnosed from had never once shipped — so the only evidence available was
// the console tail, which is truncated by the postgres container dump. The
// HEEx UI leg had the same hole for its Playwright traces.
//
// This is the diagnostic-aid twin of the failure `workflow-npm-scripts.test.ts`
// covers: a mechanism that reads as working and silently produces nothing. Both
// stayed invisible because their absence looks exactly like their success.
//
// `test.yml` already sets the flag for `.vitest-reports/*`, so the repo knew —
// it just wasn't enforced anywhere.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");

const workflows = readdirSync(workflowDir)
  .filter((f) => f.endsWith(".yml"))
  .sort();

/** A new step begins at a `- <key>:` bullet; everything until the next one
 *  belongs to the current step (`with:` block included). */
const STEP_BULLET = /^\s*-\s+(name|uses|run|id|if|shell|with|env|working-directory):/;

/** A path segment starting with `.` — `./x` and `../x` are relative prefixes,
 *  not hidden directories, so they must not count. */
const HIDDEN_SEGMENT = /(^|\/)\.(?!\/|\.\/|\.$|$)[A-Za-z0-9_-]/;

type Upload = { workflow: string; line: number; hidden: string[]; optsIn: boolean };

const uploads: Upload[] = [];

for (const wf of workflows) {
  const lines = readFileSync(path.join(workflowDir, wf), "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("uses: actions/upload-artifact")) continue;

    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length && !STEP_BULLET.test(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }
    const body = block.filter((l) => !l.trimStart().startsWith("#"));

    // Both shapes: `path: <one>` and a `path: |` block of bare glob lines.
    const candidates = body.flatMap((l) => {
      const inline = /^\s*path:\s*(\S.*)$/.exec(l);
      if (inline) return inline[1] === "|" ? [] : [inline[1].trim()];
      return /^\s*[A-Za-z-]+:/.test(l) ? [] : [l.trim()];
    });

    uploads.push({
      workflow: wf,
      line: i + 1,
      hidden: candidates.filter((p) => p.length > 0 && HIDDEN_SEGMENT.test(p)),
      optsIn: body.some((l) => /include-hidden-files:\s*true/.test(l)),
    });
  }
}

describe("upload-artifact steps ship the files they name", () => {
  it("the scan found every upload step", () => {
    // Cross-checked against a plain text count rather than a magic number: the
    // block parser must reach exactly as many steps as there are `uses:` lines,
    // so adding a workflow never silently shrinks this file's reach and the
    // guard needs no maintenance. (My first draft asserted `> 10` on a guess;
    // the real population is 7, which is precisely why the number is derived.)
    const declared =
      workflows
        .map((wf) => readFileSync(path.join(workflowDir, wf), "utf8"))
        .join("\n")
        .split("uses: actions/upload-artifact").length - 1;
    expect(uploads.length).toBe(declared);
    expect(declared).toBeGreaterThan(0);
    // At least one upload must be from a dot-path, or every case below is moot.
    expect(uploads.some((u) => u.hidden.length > 0)).toBe(true);
  });

  for (const u of uploads.filter((x) => x.hidden.length > 0)) {
    it(`${u.workflow}:${u.line} uploads a dot-path and opts into hidden files`, () => {
      expect(
        u.optsIn,
        `${u.workflow}:${u.line} uploads from a hidden directory:\n  ${u.hidden.join("\n  ")}\n` +
          "but does not set `include-hidden-files: true`, so upload-artifact@v4 " +
          "skips every one of them and the step succeeds having shipped nothing. " +
          "Add the flag (test.yml does, for `.vitest-reports/*`).",
      ).toBe(true);
    });
  }
});
