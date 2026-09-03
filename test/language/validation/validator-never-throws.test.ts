import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { AstNode, ValidationAcceptor } from "langium";
import { EmptyFileSystem, OperationCancelled, URI } from "langium";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import { runChecked } from "../../../src/language/ddd-validator.js";
import { repoRoot } from "../../_helpers/examples.js";
import { parseString } from "../../_helpers/parse.js";

// ---------------------------------------------------------------------------
// A4 — Validator fault isolation (remediation finding 21).
//
// The dispatcher wraps every themed `check*` family in `runChecked`, so a
// throw in one family costs a single diagnostic, not every diagnostic for
// the document.  Two gates guard that invariant:
//
//   (a) a fuzz gate — full validation over every shipped example + a corpus
//       of deliberately hostile inputs never lets an unhandled throw escape
//       `validate`, and an unrelated known error still surfaces alongside a
//       crash-bait construct; and
//   (b) a unit test for the guard itself — a check that throws yields exactly
//       one guard diagnostic, the remaining checks still run, and Langium's
//       own cancellation signal is re-thrown untouched.
// ---------------------------------------------------------------------------

/**
 * Validate a source with the stop-after-parse policy DISABLED.
 *
 * M-FT.4 made "a document that does not parse is not validated" the DEFAULT
 * (`src/language/ddd-document-validator.ts`): every diagnostic over a
 * recovered tree is a guess about code the author did not write, and on the
 * field-test model one syntax error produced eleven such guesses.  The
 * crash-isolation guards below are about what happens WHEN a check does run
 * over a half-built node — a caller that opts back in (Langium's options are
 * still honoured), and any future construction path that can produce one — so
 * they ask for that explicitly rather than leaning on a default that has since
 * changed.  The default itself is asserted once, at the end of the block.
 */
async function errorsOverBrokenParse(source: string): Promise<string[]> {
  const services = createDddServices(EmptyFileSystem);
  const doc = services.shared.workspace.LangiumDocumentFactory.fromString(
    source,
    URI.parse(`memory:///broken-${Math.random().toString(36).slice(2)}.ddd`),
  );
  services.shared.workspace.LangiumDocuments.addDocument(doc);
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: false });
  const diagnostics = await services.Ddd.validation.DocumentValidator.validateDocument(doc, {
    stopAfterLexingErrors: false,
    stopAfterParsingErrors: false,
  });
  return diagnostics.filter((d) => d.severity === 1).map((d) => d.message);
}

/** Every shipped `.ddd` example (both example roots). */
function exampleFiles(): string[] {
  const roots = ["examples", path.join("web", "src", "examples")];
  const out: string[] = [];
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    for (const entry of readdirSync(abs)) {
      if (entry.endsWith(".ddd")) out.push(path.join(abs, entry));
    }
  }
  return out;
}

// A corpus of deliberately hostile inputs.  The first three are the
// historically-crashing shapes (unknown quoted platform, quote-leading
// `matches()` pattern, bogus design pack) — kept as regression probes so a
// future regression to the throwing behaviour is caught by the guard rather
// than wiping the document's diagnostics.
const HOSTILE_INPUTS: Record<string, string> = {
  "empty file": "",
  "just the keyword": "system",
  "unknown quoted platform": `
    system S {
      subdomain M { context C { aggregate A { x: int } } }
      deployable api { platform: "totally-bogus-platform", contexts: [C], port: 3000 }
    }
  `,
  "quote-leading matches() pattern": `
    system S {
      subdomain M {
        context C {
          aggregate A {
            code: string
            invariant code.matches("\\"leading-quote")
            derived display: string = code
          }
          repository As for A { }
        }
      }
    }
  `,
  "bogus design pack": `
    system S {
      subdomain M {
        context C {
          aggregate A { name: string  derived display: string = name }
          repository As for A { }
        }
      }
      ui W with scaffold(subdomains: [M]) { }
      deployable api { platform: node, contexts: [C], port: 3000 }
      deployable web { platform: react, targets: api, ui: W, design: "no-such-pack", port: 3001 }
    }
  `,
  "deeply broken half-typed declarations": `
    system S {
      subdomain
      context {
        aggregate {
          : int
          derived =
        }
      }
      deployable { platform: , contexts: [ }
    }
  `,
};

describe("validator fault isolation — the fuzz gate never lets a throw escape", () => {
  for (const file of exampleFiles()) {
    it(`validates ${path.relative(repoRoot, file)} without an unhandled throw`, async () => {
      const source = readFileSync(file, "utf8");
      await expect(parseString(source)).resolves.toBeDefined();
    });
  }

  for (const [name, source] of Object.entries(HOSTILE_INPUTS)) {
    it(`survives hostile input: ${name}`, async () => {
      await expect(parseString(source)).resolves.toBeDefined();
    });
  }

  it("surfaces an unrelated known error even next to crash-bait constructs", async () => {
    // The file mixes every crash-bait shape (unknown quoted platform,
    // quote-leading `matches()`, bogus design pack) with an UNRELATED,
    // well-understood error: a theme colour that is not a hex value.  The
    // theme diagnostic must still appear — isolation means one family's
    // fault never suppresses another family's diagnostics.
    const { errors } = await parseString(`
      system S {
        theme { primary: "not-a-hex-color" }
        subdomain M {
          context C {
            aggregate A {
              code: string
              invariant code.matches("\\"leading-quote")
              derived display: string = code
            }
            repository As for A { }
          }
        }
        ui W with scaffold(subdomains: [M]) { }
        deployable api { platform: "bogus-platform", contexts: [C], port: 3000 }
        deployable web { platform: react, targets: api, ui: W, design: "no-such-pack", port: 3001 }
      }
    `);
    expect(
      errors.some((e) => /hex color/.test(e) && /primary/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("keeps a context's other diagnostics when a `derived` initializer failed to parse", async () => {
    // A `derived` whose NAME is a soft keyword (`page`) fails the `ID` token,
    // and parse recovery completes the rule with `expr` undefined.  Streaming
    // that undefined node threw inside `checkDerived`, which aborted the whole
    // enclosing `context` family — so the author saw one parse error plus a
    // crash notice INSTEAD of the real diagnostics for the same file.
    const errors = await errorsOverBrokenParse(`
      context Shop {
        aggregate Order {
          qty: int
          derived page: int[] = [1, 2]
          label: string = 42
        }
      }
    `);
    // The guard diagnostic must NOT appear — the check no longer crashes.
    expect(
      errors.filter((e) => /crashed and was skipped/.test(e)),
      errors.join("\n"),
    ).toEqual([]);
    // …and the unrelated sibling diagnostic, declared AFTER the broken
    // `derived` in the same aggregate, still surfaces.
    expect(
      errors.some((e) => /Default for 'label'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("keeps the other `criteria` diagnostics when a criterion body failed to parse", async () => {
    // The `derived` twin of the same bug class, at the sibling site the
    // original fix missed: `Criterion.body` is non-optional in the AST types,
    // but parse recovery completes the rule with it undefined, and streaming
    // that threw inside `checkOneCriterion` — aborting the whole `criteria`
    // family, which also owns `checkCriterionUseSites`.  So a half-typed
    // criterion silently swallowed every criterion arity error in the file.
    const errors = await errorsOverBrokenParse(`
      context Shop {
        criterion InRegion(region: string) of Order = this.region == region
        criterion Broken of Order =
        aggregate Order {
          region: string
          filter InRegion()
        }
      }
    `);
    // The load-bearing assertion: the use-site arity diagnostic — reported by
    // the SAME `criteria` family, after the per-criterion loop — still
    // surfaces.  "No crash" alone would pass even if the guard swallowed it.
    expect(
      errors.some((e) => /criterion 'InRegion' expects 1 argument/.test(e)),
      errors.join("\n"),
    ).toBe(true);
    expect(
      errors.filter((e) => /crashed and was skipped/.test(e)),
      errors.join("\n"),
    ).toEqual([]);
  });

  // The counterpart of the two tests above: with the DEFAULT policy neither of
  // those documents is validated at all.  Both halves matter — the guards
  // above say a check that DOES run over a recovered tree stays contained;
  // this says the toolchain does not run them there in the first place
  // (M-FT.4 / field finding F4).
  it("says only the syntax error under the DEFAULT policy", async () => {
    const { errors } = await parseString(`
      context Shop {
        aggregate Order {
          qty: int
          derived page: int[] = [1, 2]
          label: string = 42
        }
      }
    `);
    expect(errors, errors.join("\n")).toHaveLength(1);
    expect(errors[0]).toMatch(/Expecting|Unexpected/);
  });
});

describe("runChecked — the per-theme guard", () => {
  let diagnostics: Array<{ severity: string; message: string; code?: string; node: unknown }>;
  let accept: ValidationAcceptor;
  const fakeNode = { $type: "Model" } as unknown as AstNode;

  beforeEach(() => {
    diagnostics = [];
    accept = ((severity: string, message: string, info: { node: unknown; code?: string }) => {
      diagnostics.push({ severity, message, code: info?.code, node: info?.node });
    }) as unknown as ValidationAcceptor;
    // The guard logs the full stack; silence it so the suite stays quiet.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts a throw into exactly one guard diagnostic and continues", () => {
    let secondRan = false;

    runChecked("boom", fakeNode, accept, () => {
      throw new Error("kaboom\nwith a second line");
    });
    // A later family still runs after the crash.
    runChecked("healthy", fakeNode, accept, () => {
      secondRan = true;
      accept("warning", "a real diagnostic", { node: fakeNode });
    });

    const guardDiags = diagnostics.filter((d) => d.code === "loom.validator-check-crashed");
    expect(guardDiags).toHaveLength(1);
    expect(guardDiags[0].severity).toBe("error");
    expect(guardDiags[0].message).toContain("'boom'");
    expect(guardDiags[0].message).toContain("kaboom");
    // Message stays one line even though the error spanned two.
    expect(guardDiags[0].message).not.toContain("\n");
    // The crash did not suppress the next family.
    expect(secondRan).toBe(true);
    expect(diagnostics.some((d) => d.message === "a real diagnostic")).toBe(true);
  });

  it("logs the full error to console.error (browser-safe, bare console)", () => {
    const spy = console.error as unknown as ReturnType<typeof vi.fn>;
    runChecked("boom", fakeNode, accept, () => {
      throw new Error("kaboom");
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-throws Langium's OperationCancelled control-flow signal untouched", () => {
    expect(() =>
      runChecked("cancellable", fakeNode, accept, () => {
        throw OperationCancelled;
      }),
    ).toThrow();
    // No diagnostic is emitted for a cancellation — it is control flow,
    // not a check fault.
    expect(diagnostics).toHaveLength(0);
  });

  it("stringifies a non-Error throw value without crashing", () => {
    runChecked("weird", fakeNode, accept, () => {
      throw "a bare string, not an Error";
    });
    const guardDiags = diagnostics.filter((d) => d.code === "loom.validator-check-crashed");
    expect(guardDiags).toHaveLength(1);
    expect(guardDiags[0].message).toContain("a bare string");
  });
});
