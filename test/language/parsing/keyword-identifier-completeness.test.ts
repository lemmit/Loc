// Keyword-as-identifier completeness gate (M-T5.18 Track B).
//
// Loom's house rule is "never steal a domain word": every keyword the grammar
// mints for its own structural syntax must stay usable as an ordinary
// identifier wherever a user would naturally write a domain name (a field, a
// parameter, a member read, …).  Langium tokenizes each keyword literal as its
// own token, so that admissibility is re-established BY HAND at six identifier
// positions — `LooseName` / `NameRefIdent` / `MemberName` / `Property.name` /
// `StateFieldName` / `LValueIdent`.  Miss one when adding a keyword and user
// code that named a field that word silently stops parsing, with NO test
// catching it (how `money`/#498, `state { kind }`, and BUG-004 all shipped).
//
// This gate closes that hole the same way `print-completeness.test.ts` closes
// the printer hole: enumerate every keyword from the grammar via reflection,
// probe-parse it as an identifier in each position, and assert against a
// committed reality.  Two assertions:
//
//   1. DOMAIN-WORD FLOOR — a curated set of common domain identifiers MUST
//      parse as a field name, a parameter name, and a bare name-ref.  This is
//      the non-negotiable semantic guarantee (you can always declare a field
//      named `state` / `kind` / `money` / `error`), independent of the snapshot.
//
//   2. COVERAGE SNAPSHOT — the full keyword x position matrix is frozen in
//      `keyword-identifier-coverage.snapshot.json`.  Any drift (a NEW keyword,
//      a removed one, or a keyword whose admissibility changed) fails with a
//      diff, forcing a deliberate, reviewed snapshot update — that review IS
//      the checkpoint where "should this new keyword also be soft in position
//      X?" gets asked.  Update with `LOOM_UPDATE_KW_SNAPSHOT=1 npx vitest run
//      test/language/parsing/keyword-identifier-completeness.test.ts`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AstUtils } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import { DddGrammar } from "../../../src/language/generated/grammar.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(here, "keyword-identifier-coverage.snapshot.json");

/** Every identifier-shaped keyword literal the grammar declares, from the
 *  generated grammar AST (the same reflection source `print-completeness`
 *  reads).  Punctuation keywords (`:=`, `->`, `{`, …) are filtered out. */
function grammarKeywords(): string[] {
  const kws = new Set<string>();
  for (const node of AstUtils.streamAllContents(DddGrammar())) {
    if (node.$type === "Keyword") {
      const v = (node as { value: string }).value;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) kws.add(v);
    }
  }
  return [...kws].sort();
}

/** One probe per identifier position: the candidate keyword `k` is spliced
 *  into a minimal source at that position, and we assert it PARSES (lexer +
 *  parser only — no linking/validation; we care that the surface admits the
 *  token as an identifier, not that the reference resolves). */
const POSITIONS: Record<string, (k: string) => string> = {
  // aggregate/VO/event field name — `Property.name`
  fieldName: (k) => `context C { aggregate A { ${k}: string } }`,
  // operation parameter name — `Parameter` -> `LooseName`
  paramName: (k) => `context C { aggregate A { name: string\n operation op(${k}: string) { } } }`,
  // member read after a dot — `MemberName`
  memberAccess: (k) => `context C { aggregate A { name: string\n derived d: string = this.${k} } }`,
  // bare identifier in expression position — `NameRefIdent`
  nameRef: (k) => `context C { aggregate A { name: string\n derived d: string = ${k} } }`,
  // assignment / call statement target — `LValueIdent`
  lValue: (k) => `context C { aggregate A { name: string\n operation op() { ${k} := 1 } } }`,
  // page/component reactive state field name — `StateFieldName`
  stateField: (k) => `system S { ui U { page P { state { ${k}: string } } } }`,
};
const POSITION_KEYS = Object.keys(POSITIONS).sort();

// Common DDD field names that HAPPEN to be Loom keywords — these must always
// be declarable/usable as domain identifiers.  Only keywords appear here (a
// non-keyword like `status` never needed protecting); the test guards against
// typos by asserting each is a live grammar keyword.
const DOMAIN_WORD_FLOOR = [
  "action",
  "body",
  "command",
  "config",
  "connection",
  "description",
  "env",
  "error",
  "filter",
  "handle",
  "immutable",
  "instance",
  "internal",
  "kind",
  "literal",
  "managed",
  "money",
  "parent",
  "query",
  "response",
  "schema",
  "secret",
  "service",
  "stamp",
  "state",
  "store",
  "tenancy",
  "title",
  "token",
  "use",
].sort();
// The floor positions: the "declare or read a domain value" surface, where all
// floor words are (and must stay) admissible.  member-access / l-value / state
// coverage is looser across the six lists and is governed by the snapshot only.
const FLOOR_POSITIONS = ["fieldName", "paramName", "nameRef"] as const;

describe("keyword-as-identifier completeness (M-T5.18 Track B)", () => {
  let parse: ReturnType<typeof parseHelper>;
  let coverage: Record<string, string[]>;

  const parsesClean = async (src: string): Promise<boolean> => {
    const doc = await parse(src);
    return doc.parseResult.lexerErrors.length === 0 && doc.parseResult.parserErrors.length === 0;
  };

  beforeAll(async () => {
    parse = parseHelper(createDddServices(NodeFileSystem).Ddd);
    coverage = {};
    for (const k of grammarKeywords()) {
      const soft: string[] = [];
      for (const pos of POSITION_KEYS) {
        if (await parsesClean(POSITIONS[pos](k))) soft.push(pos);
      }
      coverage[k] = soft;
    }
  }, 120_000);

  it("every DOMAIN_WORD_FLOOR term is a live grammar keyword", () => {
    const keywords = new Set(grammarKeywords());
    const missing = DOMAIN_WORD_FLOOR.filter((w) => !keywords.has(w));
    expect(
      missing,
      `floor words no longer keywords (drop them from the floor): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("common domain words stay usable as field / param / name-ref identifiers", () => {
    const breaks: string[] = [];
    for (const w of DOMAIN_WORD_FLOOR) {
      const soft = coverage[w] ?? [];
      const missing = FLOOR_POSITIONS.filter((p) => !soft.includes(p));
      if (missing.length > 0) breaks.push(`${w} → not admitted at: ${missing.join(", ")}`);
    }
    expect(
      breaks,
      `A keyword stole a common domain identifier. Re-admit it as a soft keyword in the failing position's rule (LooseName / NameRefIdent / Property.name):\n  ${breaks.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keyword identifier-coverage matches the committed snapshot", () => {
    if (process.env.LOOM_UPDATE_KW_SNAPSHOT === "1" || !existsSync(SNAPSHOT)) {
      writeFileSync(SNAPSHOT, `${JSON.stringify(coverage, null, 2)}\n`);
    }
    const expected: Record<string, string[]> = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

    const liveKeys = Object.keys(coverage);
    const snapKeys = Object.keys(expected);
    const added = liveKeys.filter((k) => !(k in expected)).sort();
    const removed = snapKeys.filter((k) => !(k in coverage)).sort();
    const changed = liveKeys
      .filter((k) => k in expected)
      .filter(
        (k) =>
          JSON.stringify(coverage[k].slice().sort()) !== JSON.stringify(expected[k].slice().sort()),
      )
      .map((k) => `${k}: snapshot [${expected[k].join(", ")}] → live [${coverage[k].join(", ")}]`);

    const drift = [
      ...added.map(
        (k) =>
          `+ NEW keyword '${k}' [${coverage[k].join(", ")}] — confirm it's admissible in every identifier position it should be, then update the snapshot`,
      ),
      ...removed.map((k) => `- keyword '${k}' gone from the grammar`),
      ...changed.map((c) => `~ ${c}`),
    ];
    expect(
      drift,
      `Keyword identifier-coverage drifted from the snapshot. If intended, refresh with LOOM_UPDATE_KW_SNAPSHOT=1:\n  ${drift.join("\n  ")}`,
    ).toEqual([]);
  });
});
