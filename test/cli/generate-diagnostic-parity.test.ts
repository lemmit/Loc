// `ddd parse` and `ddd generate system` must report the SAME diagnostics for
// the same file.  They did not, in two independent ways:
//
//   * every AST-layer (phase ④) warning was printed only on the FAILING runs —
//     the print lived inside an `errorCount > 0` branch — so a successful
//     `generate system` silently dropped all 20 warnings `parse` prints for
//     `web/src/examples/erp/main.ddd`.  A user who only runs `generate` never
//     saw a real diagnostic the toolchain had already computed.
//
//   * `generate` had its own copy of the phase-⑦ printer that lumped the
//     advisory `loom.index-suggestion` hints in with the real warnings under
//     one count.  `parse` prints those under a separate `Suggestions (N):`
//     heading and deliberately does not count them as warnings, so for one
//     ERP run `parse` said `20 warning(s).` + `3 warning(s).` +
//     `Suggestions (12):` while `generate` said `15 warning(s).` — the two
//     commands' own footers didn't agree about how many things were wrong.
//
// This is the same class of defect `parse-ir-validation.test.ts` guards from
// the other side: the pre-flight command disagreeing with the command it
// pre-flights.  Comparing the two stderr streams verbatim is the assertion
// that cannot drift — it fails on a wording change, a count change, an
// ordering change, or a dropped diagnostic, without this test having to
// re-encode what any of them should say.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

function run(args: string[]): { stderr: string; status: number } {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8" });
  return { stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/** A model that generates CLEANLY but is not diagnostic-free — the exact case
 *  the defect hid.  `find open(): Order[]` raises the AST-layer (phase ④)
 *  wire-shaped-list-query warning, and filtering on `status` with no `index:`
 *  raises the advisory phase-⑦ `loom.index-suggestion`. */
const WARNED = `
system Shop {
  subdomain D {
    context Orders {
      enum OrderStatus { Open Closed }
      aggregate Order with crudish {
        code: string
        status: OrderStatus
      }
      repository Orders for Order {
        find open(): Order[] where this.status == OrderStatus.Open
      }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable api {
    platform: node
    contexts: [Orders]
    dataSources: [st]
    port: 3000
  }
}
`;

describe("generate system / parse diagnostic parity", () => {
  it("prints the identical diagnostic set on a clean-but-warned model", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-diag-parity-"));
    const file = path.join(dir, "main.ddd");
    fs.writeFileSync(file, WARNED);

    const parsed = run(["parse", file]);
    const generated = run(["generate", "system", file, "-o", path.join(dir, "out")]);

    // Both succeed — this is about the SUCCESS path, where the diagnostics
    // used to be dropped.
    expect(parsed.status).toBe(0);
    expect(generated.status).toBe(0);

    // The warnings are actually there to be dropped (a vacuous pass would
    // otherwise compare two empty strings).
    expect(parsed.stderr).toContain("wire-shaped list query");
    expect(parsed.stderr).toContain("Suggestions (");

    // …and `generate` reports exactly what `parse` reports.
    expect(generated.stderr).toBe(parsed.stderr);

    // An advisory suggestion is never re-labelled a warning by either command.
    for (const stream of [parsed.stderr, generated.stderr]) {
      const suggestions = stream.slice(stream.indexOf("Suggestions ("));
      expect(suggestions).not.toContain("warning:");
    }
  });
});
