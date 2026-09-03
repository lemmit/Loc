// `ddd parse` is documented as "parse + validate, exit non-zero on errors".
// It used to be neither half, and both failures were silent:
//
//   * it ran phase ④ (the Langium AST validator) only.  `validateLoomModel`
//     WAS called, then filtered to `loom.index-suggestion` — so every phase-⑦
//     error it had just computed was discarded and the command printed `OK`.
//     A model `generate system` rejects with six errors parsed clean.  That is
//     worse than not checking: it is the checking tool asserting the file is
//     fine.  `web/src/examples/acme.ddd` shipped that way.
//
//   * it used the SINGLE-document `parseFile`, so a multi-file entry reported
//     its siblings' declarations as unresolved references — errors that
//     `generate system`, which walks the import graph, does not have.
//
// Both directions are pinned here, because a check that under-reports and a
// check that over-reports are the same defect wearing different clothes: the
// pre-flight command disagreeing with the command it pre-flights.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

/** Both streams, on BOTH paths.  `execFileSync` hands back only stdout on
 *  success, and every diagnostic this command prints — errors, the index-
 *  suggestion footer — goes to stderr, so a success-path assertion on stderr
 *  would silently compare against an empty string. */
function parse(file: string): { out: string; status: number } {
  const r = spawnSync("node", [cli, "parse", file], { encoding: "utf8" });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status ?? 1 };
}

function write(name: string, source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-parse-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

/** A deployable hosting a state-persisted aggregate with no `dataSources:` —
 *  an IR-level (phase ⑦) error the AST validator cannot see. */
const IR_BROKEN = `
system Shop {
  subdomain D {
    context Orders {
      aggregate Order with crudish { code: string }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: node
    contexts: [Orders]
    port: 3000
  }
}
`;

const IR_CLEAN = IR_BROKEN.replace(
  "    contexts: [Orders]",
  "    contexts: [Orders]\n    dataSources: [st]",
);

describe("ddd parse — IR-level validation", () => {
  it("fails on a phase-⑦ error the AST validator cannot see", () => {
    const { out, status } = parse(write("broken.ddd", IR_BROKEN));
    expect(status).toBe(1);
    expect(out).toContain("loom.persistence-mode-unsupported");
    // The remedy has to reach the user — this is the whole point of surfacing
    // the diagnostic rather than exiting 1 with a bare count.
    expect(out).toContain("dataSources:");
    expect(out).not.toContain("OK:");
  });

  it("passes the same model once the binding is declared", () => {
    const { out, status } = parse(write("clean.ddd", IR_CLEAN));
    expect(status).toBe(0);
    expect(out).toContain("OK:");
    expect(out).not.toContain("loom.persistence-mode-unsupported");
  });

  it("agrees with `generate system` on a multi-file entry", () => {
    // Under the single-document `parseFile` this reported the imported file's
    // declarations as unresolved; `generate system` resolved them fine.
    const entry = path.join(repoRoot, "web/src/examples/multifile-main.ddd");
    const { out, status } = parse(entry);
    expect(status).toBe(0);
    expect(out).toContain("OK:");
    expect(out).not.toMatch(/Could not resolve reference/);
  });

  it("keeps index suggestions advisory — they never fail the parse", () => {
    const { out, status } = parse(path.join(repoRoot, "examples/acme.ddd"));
    expect(status).toBe(0);
    expect(out).toContain("Suggestions");
    expect(out).toContain("OK:");
  });
});

// ---------------------------------------------------------------------------
// The WARNING half of the same defect.
//
// Phase ⑦ computes 18 warning codes.  `parse` filtered them down to the one
// allow-listed `loom.index-suggestion`, and `generate system` printed its
// diagnostics only inside the `if (loomErrors.length > 0)` branch — so a
// clean-but-warned model printed NOTHING on either command while `--json`
// reported the warnings faithfully.  A warning the tool computes and then
// discards is the same "the checking tool asserts the file is fine" failure
// the error half above fixed.
// ---------------------------------------------------------------------------

/** A model with no errors and three phase-⑦ warnings: an `eventLog` resource
 *  nothing is persisted as (`loom.datasource-unused`) whose `every:` /
 *  `retain:` snapshot knobs no emitter reads (`loom.datasource-knob-unwired`
 *  ×2). */
const IR_WARNED = `
system WarnSystem {
  subdomain D {
    context Orders {
      aggregate Order with crudish { code: string }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  resource evtLog { for: Orders, kind: eventLog, use: pg, every: 100, retain: 3 }
  deployable d {
    platform: node
    contexts: [Orders]
    dataSources: [st, evtLog]
    port: 3000
  }
}
`;

function generateSystem(file: string): { out: string; status: number } {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gen-"));
  const r = spawnSync("node", [cli, "generate", "system", file, "-o", outDir, "--dry-run"], {
    encoding: "utf8",
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status ?? 1 };
}

describe("IR warnings are visible, not discarded", () => {
  it("`ddd parse` prints every IR warning, with a severity label, and still exits 0", () => {
    const { out, status } = parse(write("warned.ddd", IR_WARNED));
    expect(status).toBe(0);
    // Both warning codes reach the user…
    expect(out).toContain("loom.datasource-knob-unwired");
    expect(out).toContain("loom.datasource-unused");
    // …labelled as warnings, not passed off as errors…
    expect(out).toMatch(/loom\.datasource-knob-unwired \S+ warning: /);
    // …and the run still succeeds.
    expect(out).toContain("OK:");
    // …with a footer that counts them (the AST-layer footer above it reports
    // 0/0 — these are phase-⑦ warnings, and used to be counted nowhere).
    expect(out).toMatch(/^3 warning\(s\)\.$/m);
  });

  it("`ddd generate system` prints IR warnings on the SUCCESS path", () => {
    const { out, status } = generateSystem(write("warned-gen.ddd", IR_WARNED));
    expect(status).toBe(0);
    // The generate path prints `<source> <severity>: <message>` — same shape
    // it already used on the error path, now reached when there are no errors.
    expect(out).toMatch(/warning: resource 'evtLog' sets 'every'/);
    expect(out).toMatch(/warning: Deployable 'd' lists resource 'evtLog'/);
    expect(out).toContain("warning(s).");
  });

  // ------------------------------------------------------------------------
  // The residue.  FOUR commands run `validateLoomModel`; the fix above reached
  // two of them, because the print was four copies of the same three lines
  // rather than one function.  `snapshot` kept its copy inside the
  // `if (loomErrors.length > 0)` branch, and `verify` filtered the diagnostics
  // down to errors AT THE CALL SITE — discarding the warnings before anything
  // could print them.  Both are commands whose whole job is to make a claim
  // about the model (this is the provenance baseline / these requirements are
  // met), which is the worst place to drop "validation accepts this but it is
  // a no-op".  They share `printLoomWarnings` now.
  // ------------------------------------------------------------------------

  it("`ddd snapshot` prints IR warnings on the SUCCESS path", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-snap-"));
    const r = spawnSync(
      "node",
      [cli, "snapshot", write("warned-snap.ddd", IR_WARNED), "-o", outDir, "--dry-run"],
      { encoding: "utf8" },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(r.status ?? 1).toBe(0);
    expect(out).toMatch(/warning: resource 'evtLog' sets 'every'/);
    expect(out).toContain("warning(s).");
  });

  it("`ddd verify` prints IR warnings instead of filtering them away", () => {
    // Same warned model, plus the requirement graph `verify` needs to reach a
    // verdict at all — the warnings must survive to the author either way.
    const source =
      IR_WARNED.replace(
        "system WarnSystem {",
        'requirement US-001 { type: UserStory  title: "Ship it" }\n' +
          'requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "code sticks" }\n' +
          "system WarnSystem {",
      ).replace(
        "aggregate Order with crudish { code: string }",
        "aggregate Order with crudish { code: string  operation touch() {}  " +
          'test "code round-trips" verifies TC-001 {} }',
      ) + "testCase TC-001 verifies AC-001 { covers [ D.Orders.Order.touch ] }\n";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-verify-"));
    const results = path.join(dir, "results.json");
    fs.writeFileSync(
      results,
      JSON.stringify({
        version: 1,
        results: [{ name: "code round-trips", suite: "Order", status: "pass" }],
      }),
    );
    const r = spawnSync(
      "node",
      [
        cli,
        "verify",
        write("warned-verify.ddd", source),
        "--results",
        results,
        "--out",
        path.join(dir, "out"),
      ],
      { encoding: "utf8" },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out, out).toMatch(/warning: resource 'evtLog' sets 'every'/);
    expect(out).toContain("warning(s).");
  });
});
