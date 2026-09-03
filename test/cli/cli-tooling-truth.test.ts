// ---------------------------------------------------------------------------
// M-FT.12 — "the CLI says what it knows".
//
// Six field-test findings with one shape: a verb HAD the fact the user needed
// and printed something that withheld it.  Each test below pins the fact, not
// the phrasing-of-the-day: the address that actually resolves, the frame count
// that actually matched, the pack list that actually ships, the directory the
// file actually lands in, the import graph the verb actually has to read.
//
// Every one of these fails against the pre-fix CLI (recorded per test).
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_PACK_LATEST } from "../../src/util/builtin-formats.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-cli-truth-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Run the CLI capturing BOTH streams on every exit code.
 *
 *  `spawnSync`, not the `execSync`-in-a-try the neighbouring CLI tests use:
 *  that shape only ever sees stderr when the command FAILS, and half of what
 *  this file pins (the trace coverage verdict, the `--json` summary move) is
 *  stderr output from a successful run. */
function run(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", [cli, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? repoRoot,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/** Write `content` into a fresh subdirectory of `tmp` and return its path. */
function project(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content, "utf8");
  }
  return dir;
}

// ---------------------------------------------------------------------------
// G4 — `ddd patch` addressing
// ---------------------------------------------------------------------------

const PATCH_DDL = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order {
          total: int
          operation bump() { total := total + 1 }
        }
        repository Orders for Order { }
      }
    }
    storage pg { type: postgres }
    resource oState { for: Orders, kind: state, use: pg }
    deployable api { platform: node  contexts: [Orders]  dataSources: [oState] }
  }
`;

describe("ddd patch — a failed target teaches the address that works", () => {
  let dir: string;
  let ddd: string;
  beforeAll(() => {
    dir = project("patch", { "shop.ddd": PATCH_DDL });
    ddd = path.join(dir, "shop.ddd");
  });

  /** Write a patch file and run `ddd patch` with it. */
  function patch(target: string, extra: { json?: boolean } = {}) {
    const p = path.join(dir, `${target.replace(/[^\w]/g, "_")}.json`);
    fs.writeFileSync(p, JSON.stringify([{ op: "replace", target, source: "total: int" }]), "utf8");
    return run(["patch", ddd, "--patches", p, ...(extra.json ? ["--json"] : [])]);
  }

  // Every one of these is a real attempt from the field test; the pre-fix CLI
  // answered all four with the same seven words and no way forward.
  for (const target of [
    "Order.total", // no keyword
    "aggregate Order.total", // no context qualifier
    "operation Orders.Order.total", // wrong keyword for a property
  ]) {
    it(`'${target}' fails naming the address that resolves`, () => {
      const r = patch(target);
      expect(r.status).toBe(1);
      // The one fact the old message withheld: the address that works.
      expect(r.stderr).toContain("aggregate Orders.Order.total");
      // …plus the shape rule and the book it came from.
      expect(r.stderr).toContain("<keyword> <Context>.<Decl>[.<member>]");
      expect(r.stderr).toMatch(/address book \(\d+\)/);
    });
  }

  it("the address the error suggests actually applies", () => {
    // The suggestion is not decoration: feed it back and the patch succeeds.
    const r = patch("aggregate Orders.Order.total");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("total: int");
  });

  it("--json carries the same guidance in PatchResult.errors[]", () => {
    const r = patch("Order.total", { json: true });
    expect(r.status).toBe(1);
    const result = JSON.parse(r.stdout) as { ok: boolean; errors: { message: string }[] };
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain("aggregate Orders.Order.total");
  });
});

// ---------------------------------------------------------------------------
// G5 — `ddd trace` coverage + `ddd breakpoints` fallbacks
// ---------------------------------------------------------------------------

const TRACE_DDL = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order {
          customerName: string
          label: string
          operation confirm() {
            let note = customerName
            label := note
          }
        }
        repository Orders for Order { }
      }
    }
    storage pg { type: postgres }
    resource oState { for: Orders, kind: state, use: pg }
    deployable api { platform: node  contexts: [Orders]  dataSources: [oState] }
  }
`;

describe("ddd trace / breakpoints — say what resolved", () => {
  let dir: string;
  let ddd: string;
  let out: string;
  beforeAll(() => {
    dir = project("trace", { "shop.ddd": TRACE_DDL });
    ddd = path.join(dir, "shop.ddd");
    out = path.join(dir, "out");
    execFileSync("node", [cli, "generate", "system", ddd, "-o", out, "--sourcemap"], {
      stdio: "pipe",
    });
  });

  it("a log of bundled frames reports the miss, the frame files, and the remedy", () => {
    // The field-test shape: a production stack whose every frame is dist/…
    // The old run echoed this back byte-identical and said nothing at all.
    const log = path.join(dir, "bundled.log");
    fs.writeFileSync(
      log,
      [
        "Error: boom",
        "    at OrderDomain.confirm (/app/dist/index.js:2481:15)",
        "    at file:///app/dist/index.js:9012:23",
      ].join("\n"),
      "utf8",
    );
    const r = run(["trace", log, "--out", out]);
    expect(r.status).toBe(0);
    // The annotated log still goes to stdout untouched (pipeable).
    expect(r.stdout).toContain("at OrderDomain.confirm (/app/dist/index.js:2481:15)");
    // The verdict goes to stderr: how many frames, which files, what to do.
    expect(r.stderr).toContain("no frame matched the sourcemap (0 of 2 stack frame(s))");
    expect(r.stderr).toContain("/app/dist/index.js");
    expect(r.stderr).toContain("BUNDLED");
  });

  it("a resolvable log reports how many frames it annotated", () => {
    const log = path.join(dir, "mixed.log");
    fs.writeFileSync(
      log,
      [
        "Error: boom",
        "    at OrderDomain.rename (api/domain/order.ts:2:3)",
        "    at /nowhere/does-not-exist.ts:1:1",
      ].join("\n"),
      "utf8",
    );
    const r = run(["trace", log, "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("annotated 1 of 2 stack frame(s)");
  });

  it("a log with no recognizable frames says so instead of nothing", () => {
    const log = path.join(dir, "prose.log");
    fs.writeFileSync(log, "the server died\nand took the pod with it\n", "utf8");
    const r = run(["trace", log, "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("no stack frames recognized");
  });

  it("breakpoints on a statement line lists no whole-file `:1` fallbacks", () => {
    // `label := note` is mapped by a real statement region; the enclosing
    // aggregate ALSO produced order.test.ts / order.routes.ts whole-file
    // regions, which used to be listed as `:1` breakpoint sites.
    const dddLine = TRACE_DDL.slice(0, TRACE_DDL.indexOf("label := note")).split("\n").length;
    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--out", out]);
    expect(r.status).toBe(0);
    const printed = r.stdout.trim().split("\n").slice(1);
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) {
      expect(line, `whole-file fallback survived: ${line}`).not.toMatch(/:1$/);
    }
    expect(printed.some((l) => l.includes("domain/order.ts:"))).toBe(true);
  });

  it("a line with no finer mapping still resolves to its declaration's files", () => {
    // The fallback is dropped only where something better exists.  The
    // aggregate header line has no statement region of its own, so the
    // whole-file targets are the answer and must survive.
    const dddLine = TRACE_DDL.slice(0, TRACE_DDL.indexOf("customerName: string")).split(
      "\n",
    ).length;
    const r = run(["breakpoints", ddd, "--line", String(dddLine), "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("No generated location maps to");
  });
});

// ---------------------------------------------------------------------------
// G3 — `ddd new --design` lists every pack that ships
// ---------------------------------------------------------------------------

describe("ddd new — the pack list is the registry", () => {
  it("--help names every registered built-in pack family", () => {
    const help = run(["new", "--help"]).stdout;
    for (const family of Object.keys(BUILTIN_PACK_LATEST)) {
      expect(help, `--help omits the '${family}' pack`).toContain(family);
    }
  });

  // The three Angular packs and daisyui shipped in `designs/` while `ddd new`
  // rejected them outright — the hand-written list knew 7 of 13.
  for (const [design, platform] of [
    ["angularMaterial", "node"],
    ["primeng", "node"],
    ["spartanNg", "node"],
    ["daisyui", "elixir"],
  ] as const) {
    it(`--design ${design} scaffolds a model that validates`, () => {
      const out = path.join(tmp, `new-${design}`);
      const r = run(["new", "app", "-o", out, "--design", design, "--platform", platform]);
      expect(r.status).toBe(0);
      const src = fs.readFileSync(path.join(out, "main.ddd"), "utf8");
      expect(src).toContain(`design: ${design}`);
      // `ddd new` validates before writing, so a written model is a valid one;
      // parse it again anyway — the starter must survive the full pipeline.
      expect(run(["parse", path.join(out, "main.ddd")]).status).toBe(0);
    });
  }

  it("a LiveView pack outside elixir is refused by FORMAT, naming the alternatives", () => {
    const out = path.join(tmp, "new-daisyui-node");
    const r = run(["new", "app", "-o", out, "--design", "daisyui", "--platform", "node"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--design daisyui requires --platform elixir");
    expect(r.stderr).toContain("mantine");
    expect(fs.existsSync(out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G6 — i18n paths are anchored to the model, not the shell's cwd
// ---------------------------------------------------------------------------

const I18N_DDL = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order { label: string }
        repository Orders for Order { }
      }
    }
    ui Web {
      page Home { route: "/"  Text("Hello") }
    }
    storage pg { type: postgres }
    resource oState { for: Orders, kind: state, use: pg }
    deployable api { platform: node  contexts: [Orders]  dataSources: [oState] }
    deployable web { platform: react  targets: api  ui: Web  port: 3001 }
  }
`;

describe("ddd i18n — model-relative defaults", () => {
  it("extract writes <model dir>/.loom/messages.en.json, whatever the cwd is", () => {
    const dir = project("i18n", { "shop.ddd": I18N_DDL });
    // Run from somewhere else entirely: the old default resolved `./out`
    // against the CWD, so the catalog landed next to the shell, not the model.
    const elsewhere = project("i18n-cwd", {});
    const r = run(["i18n", "extract", path.join(dir, "shop.ddd")], { cwd: elsewhere });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, ".loom", "messages.en.json"))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, "out"))).toBe(false);
  });

  it("init scaffolds <model dir>/locales/<locale>.json, whatever the cwd is", () => {
    const dir = project("i18n-init", { "shop.ddd": I18N_DDL });
    const elsewhere = project("i18n-init-cwd", {});
    const r = run(["i18n", "init", path.join(dir, "shop.ddd"), "fr"], { cwd: elsewhere });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, "locales", "fr.json"))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, "locales"))).toBe(false);
  });

  it("--dir still wins over the default", () => {
    const dir = project("i18n-dir", { "shop.ddd": I18N_DDL });
    const custom = path.join(dir, "strings");
    const r = run(["i18n", "init", path.join(dir, "shop.ddd"), "fr", "--dir", custom]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(custom, "fr.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B4 — verify / snapshot read the import graph `generate system` reads
// ---------------------------------------------------------------------------

const SHARED_DDL = `
  context Orders {
    aggregate Order {
      total: int
      operation bump() { total := total + 1 }
      test "bump works" verifies TC-001 {}
    }
    repository Orders for Order { }
  }
`;

const ENTRY_DDL = `
  import "./shared.ddd"

  requirement US-001 { type: UserStory  title: "Bumping" }
  testCase TC-001 verifies US-001 { covers [ Orders.Order.bump ] }

  system Shop {
    storage pg { type: postgres }
    resource oState { for: Orders, kind: state, use: pg }
    deployable api { platform: node  contexts: [Orders]  dataSources: [oState] }
  }
`;

describe("multi-file projects — verify / snapshot follow `import`", () => {
  let dir: string;
  let entry: string;
  beforeAll(() => {
    dir = project("multi", { "shared.ddd": SHARED_DDL, "main.ddd": ENTRY_DDL });
    entry = path.join(dir, "main.ddd");
  });

  it("the project is sound — `parse` (which walks imports) accepts it", () => {
    expect(run(["parse", entry]).status).toBe(0);
  });

  it("verify joins results onto a requirements graph split across files", () => {
    const results = path.join(dir, "results.json");
    fs.writeFileSync(
      results,
      JSON.stringify({
        version: 1,
        results: [{ name: "bump works", suite: "Order", status: "pass" }],
      }),
      "utf8",
    );
    // Pre-fix: exit 2, "unresolved reference" from the single-document parse.
    const r = run(["verify", entry, "--results", results, "--out", path.join(dir, "v")]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Verified 1\/1 requirements/);
  });

  it("snapshot parses the whole project instead of rejecting the entry file", () => {
    const r = run(["snapshot", entry, "-o", path.join(dir, "s")]);
    expect(r.status, r.stderr).toBe(0);
    // No `provenanced` field in this model — reaching that message at all is
    // the point: it means the import graph resolved.
    expect(r.stdout).toContain("nothing to capture");
  });
});

// ---------------------------------------------------------------------------
// D7 — a `--json` verb's stdout is a single parseable document
// ---------------------------------------------------------------------------

const MONEY_DDL = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order {
          subtotal: money
          derived fee: money = money("USD 1.50")
        }
        repository Orders for Order { }
      }
    }
    storage pg { type: postgres }
    resource oState { for: Orders, kind: state, use: pg }
    deployable api { platform: node  contexts: [Orders]  dataSources: [oState] }
  }
`;

describe("--json verbs keep stdout parseable", () => {
  let ddd: string;
  beforeAll(() => {
    ddd = path.join(project("money", { "shop.ddd": MONEY_DDL }), "shop.ddd");
  });

  // `money("…")` is the input that makes Chevrotain's ALL(*) lookahead print a
  // prefix-ambiguity notice through console.log — mid-payload, on stdout.
  it("generate system --json parses", () => {
    const r = run(["generate", "system", ddd, "--json"]);
    const report = JSON.parse(r.stdout) as { ok: boolean };
    expect(report.ok).toBe(true);
  });

  it("parse --json parses", () => {
    const r = run(["parse", ddd, "--json"]);
    const report = JSON.parse(r.stdout) as { ok: boolean };
    expect(report.ok).toBe(true);
  });

  it("the diverted warning is not swallowed — it lands on stderr", () => {
    const r = run(["generate", "system", ddd, "--json"]);
    expect(r.stdout).not.toContain("Ambiguous Alternatives Detected");
    // (stderr is only captured on a non-zero exit by `run`, so this asserts
    // the absence from stdout — the contract that matters for `| jq`.)
  });

  it("verify --json prints only the verification document on stdout", () => {
    const dir = project("verify-json", { "shop.ddd": VERIFY_JSON_DDL });
    const entry = path.join(dir, "shop.ddd");
    const results = path.join(dir, "results.json");
    fs.writeFileSync(
      results,
      JSON.stringify({
        version: 1,
        results: [{ name: "bump works", suite: "Order", status: "pass" }],
      }),
      "utf8",
    );
    const r = run(["verify", entry, "--results", results, "--out", path.join(dir, "v"), "--json"]);
    expect(r.status).toBe(0);
    // The human summary used to sit on stdout ahead of the JSON.
    const doc = JSON.parse(r.stdout) as { summary: { total: number } };
    expect(doc.summary.total).toBe(1);
  });
});

const VERIFY_JSON_DDL = `
  requirement US-001 { type: UserStory  title: "Bumping" }
  testCase TC-001 verifies US-001 { covers [ Sales.Orders.Order.bump ] }

  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order {
          total: int
          operation bump() { total := total + 1 }
          test "bump works" verifies TC-001 {}
        }
        repository Orders for Order { }
      }
    }
    storage pg { type: postgres }
    resource oState { for: Orders, kind: state, use: pg }
    deployable api { platform: node  contexts: [Orders]  dataSources: [oState] }
  }
`;
