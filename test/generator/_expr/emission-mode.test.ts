import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_EXPR_KINDS,
  QUERY_EMISSION_MODES,
  QUERY_EMISSION_VOCABULARY,
  type QueryEmissionMode,
  QueryEmissionRefusal,
  refuseOutOfVocabulary,
} from "../../../src/generator/_expr/target.js";
import { whereToSql } from "../../../src/generator/dotnet/emit/dapper.js";
import { renderJpqlWhere } from "../../../src/generator/java/render-jpql.js";
import { requireLowered } from "../../../src/generator/python/find-predicate.js";
import { renderSqlScalarExpr } from "../../../src/generator/sql-pg-expr.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Emission mode (§F2, Wave 2 packet 2.4) — the contract test for
// `QUERY_EMISSION_MODES` / `QUERY_EMISSION_VOCABULARY` / `refuseOutOfVocabulary`
// declared in `src/generator/_expr/target.ts`.
//
// Three suites:
//
//   1. CENSUS — every query-language renderer this packet named
//      (`RENDERERS` below) actually declares its mode in source: either a
//      real `refuseOutOfVocabulary("<mode>"` call site (the renderers with a
//      genuinely narrower vocabulary than the full domain-logic surface), or
//      — for the two renderers that reuse the FULL `ExprTarget` for query
//      positions (dotnet LINQ, Elixir Ecto) — a documented reference to
//      `QUERY_EMISSION_VOCABULARY["<mode>"]`.  An undeclared renderer fails
//      naming file:line.
//
//   2. VOCABULARY — pins each mode's declared `kinds` set (a change here is a
//      reviewed decision, not an accident) and asserts a `refuseOutOfVocabulary`
//      call for that mode always throws a `QueryEmissionRefusal` carrying the
//      mode back out and the `loom.query-emission-invalid` code.
//
//   3. COMPLETENESS — `QUERY_EMISSION_MODES` and `QUERY_EMISSION_VOCABULARY`
//      stay in lockstep (every declared mode has a vocabulary entry and vice
//      versa), and every mode's vocabulary is a real subset of `ExprIR.kind`.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RendererDecl {
  /** Repo-relative file the renderer's mode declaration lives in. */
  file: string;
  mode: QueryEmissionMode;
  /** A regex marking the renderer's entry point — used only to report a
   *  helpful line number when the mode declaration is missing. */
  anchor: RegExp;
  /** The exact substring that proves this file declares `mode`: a real
   *  `refuseOutOfVocabulary("<mode>"` call site for the renderers with a
   *  narrower-than-full vocabulary, or a `QUERY_EMISSION_VOCABULARY["<mode>"]`
   *  documentation reference for the two that reuse the full domain-logic
   *  target (their narrowing happens at the IR-validate phase, not here). */
  declares: string;
}

const RENDERERS: RendererDecl[] = [
  {
    file: "src/generator/java/render-jpql.ts",
    mode: "jpql-spring-data",
    anchor: /function unsupported\(/,
    declares: 'refuseOutOfVocabulary(ctx.mode ?? "jpql-spring-data"',
  },
  {
    file: "src/generator/java/emit/query-projection-reads.ts",
    mode: "jpql-entity-manager",
    anchor: /function aggregationScope\(/,
    declares: 'mode: "jpql-entity-manager"',
  },
  {
    file: "src/generator/sql-pg-expr.ts",
    mode: "sql-postgres-migration",
    anchor: /export function renderSqlScalarExpr\(/,
    declares: "refuseOutOfVocabulary(MODE,",
  },
  {
    file: "src/generator/dotnet/emit/dapper.ts",
    mode: "sql-dapper",
    anchor: /export function whereToSql\(/,
    declares: 'refuseOutOfVocabulary("sql-dapper"',
  },
  {
    file: "src/generator/dotnet/render-expr.ts",
    mode: "linq-efcore",
    anchor: /export function renderCsExpr\(/,
    declares: '["linq-efcore"]',
  },
  {
    file: "src/generator/python/find-predicate.ts",
    mode: "sqlalchemy-filter",
    anchor: /export function requireLowered\(/,
    declares: 'refuseOutOfVocabulary("sqlalchemy-filter"',
  },
  {
    file: "src/generator/typescript/repository-find-predicate.ts",
    mode: "drizzle-predicate",
    anchor: /export function lowerToDrizzle\(/,
    declares: 'refuseOutOfVocabulary("drizzle-predicate"',
  },
  {
    file: "src/generator/elixir/render-expr.ts",
    mode: "ecto-fragment",
    anchor: /export function renderExpr\(/,
    declares: '["ecto-fragment"]',
  },
];

/** `<file>:<line>` of the first match of `pattern` in `content`, or `<file>`
 *  (no line) when `pattern` doesn't match — used to report where a missing
 *  declaration should have been. */
function where(file: string, content: string, pattern: RegExp): string {
  const idx = content.search(pattern);
  if (idx === -1) return file;
  const line = content.slice(0, idx).split("\n").length;
  return `${file}:${line}`;
}

describe("emission mode — census (§F2, Wave 2 packet 2.4)", () => {
  it("scans a non-trivial number of renderers (guard against a vacuous pass)", () => {
    expect(RENDERERS.length).toBeGreaterThanOrEqual(8);
  });

  for (const r of RENDERERS) {
    it(`${r.file} declares its emission mode ('${r.mode}')`, () => {
      const full = path.join(repoRoot, r.file);
      expect(fs.existsSync(full), `${r.file} does not exist`).toBe(true);
      const content = fs.readFileSync(full, "utf8");
      const anchorLoc = where(r.file, content, r.anchor);
      expect(
        content.includes(r.declares),
        `${anchorLoc}: renderer declares no emission mode — expected to find ` +
          `${JSON.stringify(r.declares)} in ${r.file} (see QUERY_EMISSION_MODES ` +
          `in src/generator/_expr/target.ts)`,
      ).toBe(true);
    });
  }

  it("every declared QUERY_EMISSION_MODE has at least one renderer in the census", () => {
    const covered = new Set(RENDERERS.map((r) => r.mode));
    const missing = QUERY_EMISSION_MODES.filter((m) => !covered.has(m));
    expect(missing, "a mode with no renderer declaring it is dead vocabulary").toEqual([]);
  });
});

describe("emission mode — vocabulary", () => {
  // Pinned literally (not derived from QUERY_EMISSION_VOCABULARY) so a
  // future accidental widening/narrowing of a mode's accepted `ExprIR.kind`
  // set fails here, reviewably.
  const EXPECTED: Record<QueryEmissionMode, readonly ExprIR["kind"][]> = {
    "jpql-spring-data": [
      "literal",
      "this",
      "id",
      "ref",
      "member",
      "paren",
      "unary",
      "binary",
      "authz-filter",
      "method-call",
    ],
    "jpql-entity-manager": [
      "literal",
      "this",
      "id",
      "ref",
      "member",
      "paren",
      "unary",
      "binary",
      "authz-filter",
      "method-call",
    ],
    "sql-postgres-migration": ["literal", "ref", "paren", "unary", "binary", "ternary"],
    "sql-dapper": [
      "paren",
      "unary",
      "binary",
      "method-call",
      "member",
      "ref",
      "authz-filter",
      "literal",
    ],
    "linq-efcore": [...ALL_EXPR_KINDS],
    "sqlalchemy-filter": [
      "literal",
      "this",
      "id",
      "ref",
      "member",
      "paren",
      "unary",
      "binary",
      "authz-filter",
      "method-call",
    ],
    "drizzle-predicate": [
      "literal",
      "this",
      "id",
      "ref",
      "member",
      "paren",
      "unary",
      "binary",
      "authz-filter",
      "method-call",
    ],
    "ecto-fragment": [...ALL_EXPR_KINDS],
  };

  for (const mode of QUERY_EMISSION_MODES) {
    it(`'${mode}' vocabulary is pinned`, () => {
      const actual = [...QUERY_EMISSION_VOCABULARY[mode].kinds].sort();
      const expected = [...EXPECTED[mode]].sort();
      expect(actual).toEqual(expected);
    });
  }

  // Every ExprIR.kind that reaches a NARROW-vocabulary mode (i.e. every kind
  // NOT in that mode's declared `kinds`) must be refused, not silently
  // accepted — the whole point of declaring a vocabulary at all.
  const NARROW_MODES = QUERY_EMISSION_MODES.filter(
    (m) => QUERY_EMISSION_VOCABULARY[m].kinds.size < ALL_EXPR_KINDS.size,
  );

  it("at least one mode is genuinely narrower than the full domain-logic surface", () => {
    // Guards the suite below against vacuous passing — if every mode widened
    // to ALL_EXPR_KINDS, "every kind outside it is refused" would check
    // nothing.
    expect(NARROW_MODES.length).toBeGreaterThan(0);
  });

  for (const mode of NARROW_MODES) {
    it(`'${mode}' refuses every ExprIR.kind outside its declared vocabulary`, () => {
      const vocab = QUERY_EMISSION_VOCABULARY[mode].kinds;
      const outside = [...ALL_EXPR_KINDS].filter((k) => !vocab.has(k));
      expect(outside.length).toBeGreaterThan(0);
      for (const kind of outside) {
        let threw: unknown;
        try {
          refuseOutOfVocabulary(mode, `expression kind '${kind}'`);
        } catch (e) {
          threw = e;
        }
        expect(threw, `${mode} did not refuse out-of-vocabulary kind '${kind}'`).toBeInstanceOf(
          QueryEmissionRefusal,
        );
        const refusal = threw as QueryEmissionRefusal;
        expect(refusal.mode).toBe(mode);
        expect(refusal.code).toBe("loom.query-emission-invalid");
      }
    });
  }

  it("refuseOutOfVocabulary always throws QueryEmissionRefusal, never returns", () => {
    expect(() => refuseOutOfVocabulary("jpql-spring-data", "probe")).toThrow(QueryEmissionRefusal);
  });
});

describe("emission mode — reachability through the REAL renderer entry points", () => {
  // An out-of-vocabulary construct in every narrow mode's declared table: a
  // bare `call` (a free function call).  None of the five renderers below
  // implement a `call` arm — this is what "the diagnostic fires" means in the
  // hard-gate sense: not the standalone `refuseOutOfVocabulary` helper called
  // directly (the vocabulary suite above already proves that), but the ACTUAL
  // renderer a `.ddd` program's filter reaches, called exactly as codegen
  // calls it, with no CLI/`.ddd` parse pipeline involved (these renderers
  // operate on already-lowered `ExprIR`, so this is the right altitude —
  // `firstNonQueryableNode` and its projection twin
  // `loom.projection-where-not-queryable` already gate this same vocabulary
  // boundary at validate-phase (Wave 1 residue), so no VALID `.ddd` program
  // can reach these renderers with this shape — that unreachability is the
  // point of defense-in-depth, not a gap in this proof).
  const outOfVocab: ExprIR = { kind: "call", callKind: "free", name: "mystery", args: [] };

  it("JPQL (jpql-spring-data) refuses a bare call", () => {
    expect(() => renderJpqlWhere(outOfVocab, { alias: "e", enumsPkg: "com.acme" })).toThrow(
      QueryEmissionRefusal,
    );
  });

  it("JPQL (jpql-entity-manager) refuses a bare call", () => {
    expect(() =>
      renderJpqlWhere(outOfVocab, {
        alias: "e",
        enumsPkg: "com.acme",
        mode: "jpql-entity-manager",
        principalAccessors: new Set(),
      }),
    ).toThrow(QueryEmissionRefusal);
  });

  it("Postgres migration-backfill SQL refuses a bare call", () => {
    expect(() => renderSqlScalarExpr(outOfVocab, { columnFor: () => "col" })).toThrow(
      QueryEmissionRefusal,
    );
  });

  it("dapper raw SQL refuses a bare call", () => {
    expect(() => whereToSql(outOfVocab)).toThrow(QueryEmissionRefusal);
  });

  // python's `lowerToSqlAlchemy` / node's `lowerToDrizzle` return `null` (not
  // a throw) for a shape they can't lower — the low-level signal every
  // caller with a DECLARED filter in hand must route through a refusal
  // (`requireLowered` / `refuseOutOfVocabulary("drizzle-predicate", …)`)
  // rather than treating as "no filter".  `requireLowered` IS that refusal
  // wrapper for python — the real function `relationalFindMethod` /
  // `viewFindMethod` / the retrieval path call, not a reimplementation:
  it("python's requireLowered refuses a null (unlowerable) predicate", () => {
    expect(() => requireLowered("find 'x' on 'Y'", null)).toThrow(QueryEmissionRefusal);
  });

  it("every reachability throw carries the loom.query-emission-invalid code", () => {
    let caught: unknown;
    try {
      renderJpqlWhere(outOfVocab, { alias: "e", enumsPkg: "com.acme" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueryEmissionRefusal);
    expect((caught as QueryEmissionRefusal).code).toBe("loom.query-emission-invalid");
  });
});

describe("emission mode — completeness", () => {
  it("QUERY_EMISSION_MODES and QUERY_EMISSION_VOCABULARY stay in lockstep", () => {
    const modeSet = new Set<string>(QUERY_EMISSION_MODES);
    const vocabKeys = new Set(Object.keys(QUERY_EMISSION_VOCABULARY));
    expect([...modeSet].sort()).toEqual([...vocabKeys].sort());
  });

  it("every mode's vocabulary is non-empty and a subset of ALL_EXPR_KINDS", () => {
    for (const mode of QUERY_EMISSION_MODES) {
      const kinds = QUERY_EMISSION_VOCABULARY[mode].kinds;
      expect(kinds.size, `${mode} declares an empty vocabulary`).toBeGreaterThan(0);
      for (const k of kinds) {
        expect(ALL_EXPR_KINDS.has(k), `${mode} declares unknown kind '${k}'`).toBe(true);
      }
    }
  });

  it("ALL_EXPR_KINDS excludes the UI-only 'action-ref' marker", () => {
    expect(ALL_EXPR_KINDS.has("action-ref" as ExprIR["kind"])).toBe(false);
  });
});
