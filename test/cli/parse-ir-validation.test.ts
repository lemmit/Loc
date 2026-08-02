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
