// The schemathesis waiver file and its findings register must describe the
// same set of bugs (M-T9.21).
//
// A waiver is only better than a silent skip while it stays ATTACHED to an
// explanation.  The failure mode is drift, and it is not hypothetical — the two
// files were written minutes apart in the PR that added them and already
// disagreed on which number the UTF-16 length bug carried, so a reader
// following `W6 → F6` landed on the wrong finding.  Nothing at runtime notices:
// the `findings` array is documentation, so a wrong id fails no gate and simply
// misroutes whoever picks the follow-up up.
//
// So: every id a waiver rule cites must exist as a heading in the register, and
// every finding in the register must be cited by at least one rule (an entry no
// rule covers is a finding the gate is not actually holding the line on).

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

interface Waiver {
  id: string;
  findings: string[];
  check: string;
  operations: string;
  kind: "bug" | "by-design";
  reason: string;
  intermittent?: boolean;
  intermittentReason?: string;
}

const waiverDoc = JSON.parse(
  readFileSync(path.join(repoRoot, "test/behavioral/schemathesis-waivers.json"), "utf8"),
) as { waivers: Waiver[] };
const register = readFileSync(
  path.join(repoRoot, "docs/audits/schemathesis-findings-2026-08.md"),
  "utf8",
);

/** `### F3 — the query-parameter twin …` → `F3`. */
const registerFindings = new Set(
  [...register.matchAll(/^### (F\d+)\b/gm)].map((m) => m[1] as string),
);

/** The findings the register marks `**Status: FIXED`.  A fixed entry KEEPS its
 *  heading — the register is an audit record, and deleting the repro erases
 *  exactly the history that makes it worth having — but it must no longer be
 *  waived: the runner fails a rule that stops reproducing, so a rule still
 *  claiming a fixed finding is a stale rule waiting to break the nightly.
 *  The two halves below check that in both directions. */
const fixedFindings = new Set(
  [...register.matchAll(/^### (F\d+)\b[\s\S]*?(?=^### |Z)/gm)]
    .filter((m) => /\*\*Status: FIXED/.test(m[0]))
    .map((m) => m[1] as string),
);

describe("schemathesis waivers ↔ findings register", () => {
  it("the register was actually read", () => {
    // Guards the whole file against a rename silently emptying every set below.
    // The register only GROWS (a fixed finding keeps its heading), so a floor on
    // it is safe.  The WAIVER list is the opposite: it shrinks every time a root
    // cause is fixed, so a count floor there is a countdown that has to be
    // edited down by each fix — it would have blocked F6+F8's own PR, which is
    // how it was found.  What that half actually needs to prove is that the file
    // parsed into rules at all, so that is what it asserts.
    expect(registerFindings.size).toBeGreaterThan(5);
    expect(Array.isArray(waiverDoc.waivers)).toBe(true);
    expect(
      waiverDoc.waivers.length,
      "the waiver file parsed to an empty rule list — a rename or a bad edit, " +
        "not a drained register (an ACTUALLY drained register is fine here and " +
        "is covered by the OPEN-finding check below)",
    ).toBeGreaterThan(0);
  });

  for (const w of waiverDoc.waivers) {
    it(`${w.id} cites findings that exist in the register`, () => {
      expect(w.findings.length, `${w.id} cites no finding`).toBeGreaterThan(0);
      for (const f of w.findings) {
        expect(
          registerFindings.has(f),
          `waiver ${w.id} cites ${f}, which has no "### ${f}" heading in ` +
            "docs/audits/schemathesis-findings-2026-08.md",
        ).toBe(true);
      }
    });

    it(`${w.id} explains itself`, () => {
      // A waiver without a reason is a skip wearing a reason's clothes.
      expect(w.reason.length, `${w.id} has no reason`).toBeGreaterThan(40);
      expect(["bug", "by-design"]).toContain(w.kind);
      // `operations` is compiled with `new RegExp` by the runner; a bad pattern
      // would only surface at 2am in the nightly.
      expect(() => new RegExp(w.operations)).not.toThrow();
      if (w.intermittent) {
        expect(
          (w.intermittentReason ?? "").length,
          `${w.id} opts out of the staleness ratchet without saying why`,
        ).toBeGreaterThan(40);
      }
    });
  }

  it("every OPEN finding in the register is covered by a waiver rule", () => {
    const cited = new Set(waiverDoc.waivers.flatMap((w) => w.findings));
    const uncovered = [...registerFindings].filter((f) => !cited.has(f) && !fixedFindings.has(f));
    expect(
      uncovered,
      "these findings are documented but no waiver rule claims them, so the gate " +
        "would report them as unwaived (mark the entry `**Status: FIXED` if it " +
        "was actually fixed): " +
        uncovered.join(", "),
    ).toEqual([]);
  });

  it("no waiver rule still claims a finding the register marks FIXED", () => {
    // The other half of the ratchet.  Leaving the rule behind does not fail the
    // nightly loudly — it fails it as a STALE waiver, which reads like a flake
    // rather than "someone forgot to delete this".  Catch it here instead.
    const stale = waiverDoc.waivers
      .filter((w) => w.findings.some((f) => fixedFindings.has(f)))
      .map((w) => `${w.id} → ${w.findings.filter((f) => fixedFindings.has(f)).join("/")}`);
    expect(
      stale,
      "these rules waive a finding the register marks FIXED; delete (or narrow) " +
        "them in the PR that fixed it: " +
        stale.join(", "),
    ).toEqual([]);
  });

  it("the register still records at least one fixed finding", () => {
    // Guards the `**Status: FIXED` regex above: if the marker is ever reworded,
    // `fixedFindings` silently empties and the exemption above turns back into
    // the old unconditional check without anyone noticing.
    expect(fixedFindings.size).toBeGreaterThan(0);
  });
});
