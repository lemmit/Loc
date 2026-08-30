// Every `npm run <script>` a workflow can invoke must EXIST in package.json.
//
// The gap this closes: `local-run-mapping.test.ts` already pins that every
// workflow has a local-run row in docs/testing.md, but a doc row describes what
// a HUMAN should type — nothing checked what the workflow itself actually runs.
// So schemathesis.yml spent five consecutive nightlies (2026-08-25 … 08-29)
// invoking a script that has never existed:
//
//     npm error Missing script: "test:schemathesis-node"
//
// The node leg exited 1 in under a second, every night, having fuzzed nothing —
// and the doc row was correct the whole time, so the existing gate was green.
//
// ── Why the computed form is BANNED, not just checked ──────────────────────
// The script name had been derived with the `A && B || C` ternary idiom:
//
//     npm run test:schemathesis${{ matrix.backend == 'node' && ''
//                                  || format('-{0}', matrix.backend) }}
//
// A GitHub Actions expression returns the last operand it evaluated as truthy,
// and the EMPTY STRING IS FALSY.  So for the one cell whose "true" branch is
// `''`, `true && ''` yields `''`, the `||` arm runs anyway, and the node cell
// gets the suffix the condition existed to suppress.  The idiom is correct for
// every non-empty branch, which is exactly why it survives review: it is only
// wrong for the single cell that needs no suffix.
//
// Checking such an expression means evaluating it, and an evaluator here would
// be a second implementation of GitHub's semantics — the same semantics that
// just got this wrong.  So the rule is structural instead: a script name is
// either a LITERAL or a bare `${{ matrix.<key> }}` carrying a literal from the
// matrix.  Both are statically readable; neither has truthiness to get wrong.
// Four workflows (channels / email / migration-evolution / tenancy) already
// carried `matrix.script` this way — schemathesis.yml was the lone holdout.
//
// (Shell `&&`/`||` associativity bit this repo once already, in the opposite
// direction: see the brace-grouping note in `test/e2e/support/mix-retry.ts`.)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workflowDir = path.join(repoRoot, ".github/workflows");

/** A workflow step's `npm run` resolves against the package.json of its
 *  `working-directory`, not the repo root: `web/` and `test/behavioral/` are
 *  their own packages with their own scripts. Checking everything against the
 *  root manifest reports nine false failures. */
function scriptsOf(dir: string): Record<string, string> | null {
  const manifest = path.join(repoRoot, dir, "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
}

const rootScripts = scriptsOf(".") as Record<string, string>;

const workflows = readdirSync(workflowDir)
  .filter((f) => f.endsWith(".yml"))
  .sort();

/** Lines that are wholly a YAML comment. A `#` mid-line can be part of a real
 *  command, so only a leading one counts — this file's own doc block quotes the
 *  broken expression verbatim, and must not be read as an invocation. */
const isComment = (line: string): boolean => line.trimStart().startsWith("#");

const codeLines = (src: string): string[] => src.split("\n").filter((l) => !isComment(l));

/** `npm run X` / `npm run -s X`. X is captured WHOLE — a script name can mix
 *  literal text and `${{ … }}` blocks (`test:schemathesis${{ … }}` was the real
 *  broken form), so the token is a sequence of either, not one or the other.
 *  The inner pattern allows `}` so `format('-{0}', …)` does not terminate it
 *  early. */
const NPM_RUN = /npm run\s+(?:-\w+\s+)*((?:\$\{\{[\s\S]*?\}\}|[^\s;&|"'`])+)/g;

/** Start of a workflow STEP. Steps are read as whole blocks rather than by
 *  scanning backwards from the `run:` line, because YAML keys have no required
 *  order — schemathesis.yml already puts `working-directory:` *after* `run:`
 *  in one step, and a backward scan would silently mis-resolve the next one
 *  written that way. */
const STEP_BULLET =
  /^\s*-\s+(name|uses|run|id|if|shell|working-directory|env|with|continue-on-error|timeout-minutes):/;

/** Values a `<key>:` takes across a workflow's matrix — the literal RHS only. */
function matrixValues(lines: string[], key: string): string[] {
  const re = new RegExp(`^\\s*${key}:\\s*([^\\s#]+)\\s*$`);
  return lines.flatMap((l) => {
    const m = re.exec(l);
    return m ? [m[1].replace(/^["']|["']$/g, "")] : [];
  });
}

type Invocation = { workflow: string; dir: string; raw: string; names: string[] | null };

const invocations: Invocation[] = [];
/** Steps whose `working-directory` is itself an expression (generated project
 *  trees). Nothing there is a repo script, so they are skipped — counted so the
 *  skip can never quietly grow to swallow the whole scan. */
let skippedDynamicDir = 0;

for (const wf of workflows) {
  const lines = codeLines(readFileSync(path.join(workflowDir, wf), "utf8"));

  const steps: string[][] = [];
  for (const line of lines) {
    if (STEP_BULLET.test(line) || steps.length === 0) steps.push([]);
    steps[steps.length - 1].push(line);
  }

  for (const step of steps) {
    const wdLine = step.find((l) => /^\s*working-directory:/.test(l));
    const dir = wdLine ? wdLine.split(":").slice(1).join(":").trim() : ".";
    for (const m of step.join("\n").matchAll(NPM_RUN)) {
      if (dir.includes("${{")) {
        skippedDynamicDir += 1;
        continue;
      }
      const raw = m[1];
      if (!raw.includes("${{")) {
        invocations.push({ workflow: wf, dir, raw, names: [raw] });
        continue;
      }
      // Anything but a name that IS, in full, one matrix reference is computed —
      // including a literal prefix glued to an expression, which is the exact
      // shape that broke (`test:schemathesis` + a suffix expression).
      const bare = /^\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}$/.exec(raw);
      // A computed name (`&&`, `||`, `format(`, …) is refused outright — see the
      // header. `names: null` marks it so the ban test can name the offender.
      invocations.push({
        workflow: wf,
        dir,
        raw,
        names: bare ? matrixValues(lines, bare[1]) : null,
      });
    }
  }
}

describe("every npm script a workflow invokes exists", () => {
  it("the scan found the real invocation population", () => {
    // Guard against a rename or regex drift making every test below vacuous —
    // a green run over zero invocations is the failure mode this file exists
    // to prevent elsewhere.
    expect(invocations.length).toBeGreaterThan(30);
    expect(Object.keys(rootScripts).length).toBeGreaterThan(50);
  });

  it("no workflow COMPUTES a script name from an expression", () => {
    const computed = invocations
      .filter((i) => i.names === null)
      .map((i) => `${i.workflow}: npm run ${i.raw}`);
    expect(
      computed,
      "a script name must be a literal, or a bare `${{ matrix.<key> }}` carrying " +
        "a literal from the matrix — never an expression.\n  " +
        computed.join("\n  ") +
        "\nAdd a `script:` to each matrix cell and run `npm run ${{ matrix.script }}`. " +
        "See this file's header for the empty-string-is-falsy failure it prevents.",
    ).toEqual([]);
  });

  it("a `${{ matrix.<key> }}` script name resolves to at least one value", () => {
    // An unresolvable reference would otherwise pass by checking nothing.
    const empty = invocations
      .filter((i) => i.names !== null && i.raw.includes("${{") && i.names.length === 0)
      .map((i) => `${i.workflow}: npm run ${i.raw} — no literal values found in its matrix`);
    expect(empty).toEqual([]);
  });

  it("every scanned working-directory is a real package", () => {
    const missing = [
      ...new Set(invocations.filter((i) => scriptsOf(i.dir) === null).map((i) => i.dir)),
    ];
    expect(missing, `no package.json under: ${missing.join(", ")}`).toEqual([]);
    expect(skippedDynamicDir, "dynamic-dir skips should stay at zero here").toBe(0);
  });

  for (const inv of invocations.filter((i) => i.names !== null)) {
    for (const name of inv.names as string[]) {
      const where = inv.dir === "." ? "" : ` (in ${inv.dir}/)`;
      it(`${inv.workflow} → npm run ${name}${where}`, () => {
        const available = scriptsOf(inv.dir) ?? rootScripts;
        expect(
          Object.hasOwn(available, name),
          `${inv.workflow} invokes \`npm run ${name}\`${where} (from \`${inv.raw}\`), but ` +
            `${inv.dir === "." ? "package.json" : `${inv.dir}/package.json`} has no such ` +
            "script. CI would fail in under a second with `npm error Missing script`, " +
            "having run nothing.",
        ).toBe(true);
      });
    }
  }
});
