// ---------------------------------------------------------------------------
// Phase ① parse-error reporting — M-FT.4 (field-test findings F3, F4, F6).
//
// The measurement this suite freezes: one unsupported operator in a page body
// used to produce FIFTEEN errors, none of which named the cause, the first of
// which pointed at a line seventeen above it.  Every assertion below is a
// count or a position, because those are the two things that were wrong.
//
//   F4  a broken parse must not be spoken over — no linking errors, no AST
//       validator diagnostics, and only the FIRST parse error.
//   F3  a builder-call whose BODY fails must report inside the body, not at
//       the builder's own `{` (chevrotain's ALL(*) lookahead rejects the whole
//       alternative, so the failure surfaces at the outer brace).
//   F6  an alternation failure names the nearest legal spelling, not a
//       numbered dump of every lookahead path.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it, vi } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import { loadProject } from "../../../src/language/project-loader.js";
import { parseString } from "../../_helpers/parse.js";

/** A page body with `${body}` spliced in as the `Stack`'s middle child.  The
 *  surrounding declarations are all valid, so every diagnostic a test sees is
 *  attributable to the splice. */
const pageWith = (body: string) => `system S {
  subdomain Sub { context C {
    aggregate Task with crudish { title: string }
    repository Tasks for Task { }
  } }
  ui WebApp {
    page Board {
      route: "/board"
      body: Stack {
        Heading { "Open", level: 2 },
        ${body},
        Text { "footer" }
      }
    }
  }
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  deployable api { platform: node, contexts: [C], dataSources: [st], port: 3000 }
  deployable web { platform: react, targets: api, ui: WebApp, port: 3001, design: mantine }
}`;

/** 1-based line of the first `needle` occurrence — the position a human would
 *  point at when asked "where is the mistake". */
const lineOf = (source: string, needle: string): number =>
  source.slice(0, source.indexOf(needle)).split("\n").length;

describe("F4 — a broken parse is not spoken over", () => {
  it("reports exactly one error for one syntax error", async () => {
    const { errors } = await parseString(pageWith(`Text { 1 1 }`));
    expect(errors).toHaveLength(1);
  });

  it("raises no linking error for a declaration the broken parse dropped", async () => {
    // `ui WebApp` is declared and referenced by the react deployable, but a
    // parse error inside the page truncates the `ui` subtree — so the
    // reference the author DID write reads as unresolved.  That diagnostic is
    // fiction and must not be emitted.
    const { errors } = await parseString(pageWith(`Text { 1 1 }`));
    expect(errors.join("\n")).not.toMatch(/Could not resolve reference/);
  });

  it("raises no AST-validator diagnostic over the recovered subtree", async () => {
    // A syntax error in the AGGREGATE, and a genuinely bogus builder further
    // down in the `ui` — reachable only through chevrotain's recovery.  With
    // validation running over the recovered tree, `loom.unknown-builder-type`
    // fires alongside the parse error; the author is asked to fix two things
    // when one of them is a consequence of the other and the tree is a guess.
    const { diagnostics } = await parseString(`system S {
      subdomain Sub { context C {
        aggregate Task with crudish { title: string = = }
        repository Tasks for Task { }
      } }
      ui WebApp {
        page Board { route: "/board"  body: Stack { Fooo { "x" } } }
      }
    }`);
    const loomCodes = diagnostics
      .map((d) => (typeof d.code === "string" ? d.code : ""))
      .filter((c) => c.startsWith("loom."));
    expect(loomCodes).toEqual([]);
  });

  it("a clean source still gets its validator diagnostics", async () => {
    // The guard is "stop after a PARSE error", not "stop validating".  A file
    // that parses must still be fully checked, or F4's fix would be a mute
    // button.
    const { errors } = await parseString(`
      context X {
        aggregate Foo { name: string  age: int  derived bad: bool = name == age }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare 'string' with 'int'/);
  });
});

describe("F3 — a builder-call body reports inside the body", () => {
  it("points at the offending token, not the enclosing builder's brace", async () => {
    const source = pageWith(`Text { 1 1 }`);
    const { errors } = await parseString(source);
    // The splice sits three lines below the `Stack {` that used to absorb the
    // blame.
    expect(errors[0]).toMatch(new RegExp(`^${lineOf(source, "Text { 1 1 }")}:`));
  });

  it("descends through nesting to the innermost failure", async () => {
    // Two builder levels between the reported position and the outermost one:
    // `Stack { … Card { … Text { 1 1 } … } … }`.
    const source = pageWith(`Card { Text { 1 1 } }`);
    const { errors } = await parseString(source);
    const [, line, column] = /^(\d+):(\d+) /.exec(errors[0] ?? "") ?? [];
    const spliceLine = lineOf(source, "Card {");
    expect(Number(line)).toBe(spliceLine);
    // Column of the SECOND `1` — the token the parser actually choked on,
    // inside the innermost builder, not the `{` of `Card` or of `Text`.
    const text = source.split("\n")[spliceLine - 1] ?? "";
    expect(Number(column)).toBe(text.indexOf("1 }") + 1);
  });

  it("leaves a non-builder-call parse error where chevrotain put it", async () => {
    // The walk-back only fires on the `name {` signature.  A mistake that is
    // not one must keep its own position rather than being dragged into some
    // unrelated block.
    const source = `
      context X {
        aggregate Foo { name: string = = }
        repository Foos for Foo { }
      }`;
    const { errors } = await parseString(source);
    expect(errors[0]).toMatch(new RegExp(`^${lineOf(source, "= = }")}:`));
  });
});

describe("F6 — an alternation names what was meant, not every path", () => {
  it("suggests the nearest design pack for a typo", async () => {
    const { errors } = await parseString(
      pageWith(`Text { "x" }`).replace("design: mantine", "design: mantinee"),
    );
    expect(errors[0]).toMatch(/Unexpected 'mantinee'\. Did you mean 'mantine'\?/);
  });

  it("suggests the nearest platform for a swapped-letter typo", async () => {
    // A swap, the commonest typo in a word the author already knows.  (The
    // metric's transposition arm is what keeps a swap suggestible in SHORT
    // names, where the distance budget is one edit — see
    // `test/util/edit-distance.test.ts`.)
    const { errors } = await parseString(
      pageWith(`Text { "x" }`).replace("platform: react", "platform: reakt"),
    );
    expect(errors[0]).toMatch(/Did you mean 'react'\?/);
  });

  it("does not dump every lookahead path", async () => {
    const { errors } = await parseString(
      pageWith(`Text { "x" }`).replace("design: mantine", "design: mantinee"),
    );
    expect(errors[0]).not.toMatch(/possible Token sequences/);
    // One line, and a bounded sample of the closed set rather than all 14.
    expect(errors[0]).not.toContain("\n");
    expect(errors[0]).toMatch(/\(\+9 more\)/);
  });

  it("offers no did-you-mean for a punctuation token", async () => {
    // `?` is one character from `!`, `-`, `{` and a dozen other operators.
    // "Did you mean '!'?" is noise, so the suggestion is word-shaped only.
    const source = pageWith(`Text { (1 ?? 2) }`);
    const { errors } = await parseString(source);
    expect(errors[0]).toMatch(/Unexpected '\?'\./);
    expect(errors[0]).not.toMatch(/Did you mean/);
    // …and it is still reported at the operator, not at `Stack {`.
    expect(errors[0]).toMatch(new RegExp(`^${lineOf(source, "??")}:`));
  });
});

// ---------------------------------------------------------------------------
// F10 — the "before ComputedScopes" warning.
//
// Langium's `DefaultLinker` warns on stderr whenever a reference is resolved
// before its document reaches `ComputedScopes`.  Loom's macro expander runs as
// a `DocumentState.IndexedContent` hook — deliberately before scope
// computation — so any `.ddd` whose macro arguments do not all resolve prints
// the warning once per probe, ahead of the one real diagnostic.  On the
// field-test corpus a single mistyped type printed it three times.
// ---------------------------------------------------------------------------
describe("F10 — no ComputedScopes warning on an unresolved reference", () => {
  it("stays silent on stderr while still reporting the linking error", async () => {
    // Must go through `loadProject` — the CLI's entry point, and the one that
    // reaches the macro pass with a document still below `ComputedScopes`.
    // The in-memory `parseString` helper does not provoke the warning, so a
    // gate written against it would pass with the fix reverted.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-f10-"));
    const file = path.join(dir, "main.ddd");
    // `str` is not a type.  The `scaffold` macro's ref-list argument
    // (`subdomains: [Sub]`) is resolved by the expander at
    // `DocumentState.IndexedContent` — before scope computation — so a
    // document carrying ANY unresolved reference makes the linker warn, once
    // per probe.
    fs.writeFileSync(
      file,
      `system S {
         subdomain Sub { context C {
           aggregate Task with crudish { title: str }
           repository Tasks for Task { }
         } }
         ui WebApp with scaffold(subdomains: [Sub]) { }
         storage pg { type: postgres }
         resource st { for: C, kind: state, use: pg }
         deployable api { platform: node, contexts: [C], dataSources: [st], port: 3000 }
         deployable web { platform: react, targets: api, ui: WebApp, port: 3001, design: mantine }
       }`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const services = createDddServices(NodeFileSystem);
      const { entry } = await loadProject(URI.file(file), services.shared);
      const messages = (entry.diagnostics ?? []).map((d) => d.message).join("\n");
      expect(messages).toMatch(/Could not resolve reference to .* named 'str'/);
      const noise = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("ComputedScopes"));
      expect(noise).toEqual([]);
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
