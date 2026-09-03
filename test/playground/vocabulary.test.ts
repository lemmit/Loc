import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTO_RUN,
  BLOCKER,
  nextStep,
  PANE,
  RUN,
  STAGE,
  STAGE_ORDER,
  STREAM,
} from "../../web/src/layout/vocabulary.js";

// The playground's one vocabulary (M-T8.16 slice 2, audit M7).  Two halves:
//
//   1. The module itself — the stage / pane / stream names and the ONE
//      precondition phrasing every panel composes from.
//   2. A ratchet over `web/src/**/*.tsx`: the literals the vocabulary
//      retired must not come back.  Like the walker-stdlib pin, a hit fails
//      CI with the file named; extend `RETIRED` when a further rename lands.

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..", "..", "web", "src");

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "examples") continue;
      out.push(...walkTsx(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Retired literal → the vocabulary entry that replaced it. */
const RETIRED: { pattern: RegExp; replacedBy: string }[] = [
  { pattern: /Backend logs/, replacedBy: "STREAM.runtimeLogs" },
  { pattern: /\bReqs\b/, replacedBy: "PANE.requirements" },
  { pattern: /spin up PGlite/, replacedBy: "STAGE_HINT.boot" },
  { pattern: /Generate and Bundle first/, replacedBy: 'nextStep("boot", isDesktop)' },
  { pattern: /Bundle \+ Boot first/, replacedBy: 'nextStep("boot", isDesktop)' },
  { pattern: /Boot the backend to run/, replacedBy: 'nextStep("boot", isDesktop)' },
  { pattern: /"Live mode"|label="Live"/, replacedBy: "AUTO_RUN" },
  { pattern: />Migrate</, replacedBy: "PANE.migrations" },
];

describe("vocabulary — the names", () => {
  it("names the four stages in pipeline order, and Run for mobile", () => {
    expect(STAGE_ORDER).toEqual(["validate", "generate", "bundle", "boot"]);
    expect(STAGE_ORDER.map((id) => STAGE[id])).toEqual(["Validate", "Generate", "Bundle", "Boot"]);
    expect(RUN).toBe("Run");
    expect(AUTO_RUN).toBe("Auto-run on edit");
  });

  it("one name per pane and stream — Runtime, Requirements, Migrations, Runtime logs", () => {
    expect(PANE.runtime).toBe("Runtime");
    expect(PANE.requirements).toBe("Requirements");
    expect(PANE.migrations).toBe("Migrations");
    expect(STREAM.runtimeLogs).toBe("Runtime logs");
    // No two panes share a label.
    const labels = Object.values(PANE);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("one precondition phrasing per stage: the button chain on desktop, Tap Run on mobile", () => {
    expect(nextStep("generate", true)).toBe("Click Generate");
    expect(nextStep("bundle", true)).toBe("Generate, then Bundle");
    expect(nextStep("boot", true)).toBe("Generate, then Bundle, then Boot");
    for (const stage of ["generate", "bundle", "boot"] as const) {
      expect(nextStep(stage, false)).toBe("Tap Run");
    }
    expect(BLOCKER.generate(1)).toBe("Fix the 1 error in your source first (Output → Problems).");
    expect(BLOCKER.boot).toContain("Generate, then Bundle, then Boot");
  });
});

describe("vocabulary — the ratchet over web/src/**/*.tsx", () => {
  const files = walkTsx(webSrc);

  it("scans a real tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { pattern, replacedBy } of RETIRED) {
    it(`no .tsx carries the retired literal ${pattern} (use ${replacedBy})`, () => {
      const hits = files
        .filter((f) => pattern.test(fs.readFileSync(f, "utf-8")))
        .map((f) => path.relative(webSrc, f));
      expect(
        hits,
        `retired literal ${pattern} — import ${replacedBy} from layout/vocabulary.ts`,
      ).toEqual([]);
    });
  }
});
