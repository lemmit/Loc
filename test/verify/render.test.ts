// ---------------------------------------------------------------------------
// The RENDER half of `ddd verify` — `src/verify/render.ts`.
//
// `test/cli/verification.test.ts` pins the ROLLUP (`computeVerification`:
// results → verdicts).  This file pins what the three artefact renderers do
// with that rollup, as PROPERTIES rather than golden strings:
//
//   • `GLYPH` / `MMD_CLASS` are TOTAL over `RequirementVerdict` — a verdict
//     added to the union but not to a map renders as the literal string
//     `undefined` in the Markdown / the `class` line, which is exactly the
//     silent-degradation shape a golden-file test would ratify.  The verdict
//     set is read out of the union's declaration in `loom-ir.ts`, so a fifth
//     verdict is covered the moment it is declared.
//   • `pct(n, 0)` is `"n/a"`, never `NaN%`.
//   • Every requirement appears exactly once in the Markdown tree and exactly
//     once as a graph node; every `childrenOf` edge appears as a graph edge
//     (no orphan node, no dropped edge).
//   • The JSON artefact round-trips through `JSON.parse`.
//   • The Markdown headline percentages agree with the rendered verdicts.
//   • A Mermaid-hostile requirement id / title cannot corrupt the graph.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  LoomModel,
  RequirementIR,
  RequirementVerdict,
  TestOutcome,
  VerificationIR,
} from "../../src/ir/types/loom-ir.js";
import {
  renderVerdictGraph,
  renderVerificationJson,
  renderVerificationMd,
} from "../../src/verify/render.js";
import { computeVerification } from "../../src/verify/verification.js";
import { buildLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Fixture: a two-level requirement hierarchy whose rollup exercises all four
// verdicts in ONE model — AC-001 FAILING, AC-002 VERIFIED, AC-003 UNVERIFIED
// (its test never ran), US-001 FAILING (child failure), US-002 UNTESTED.
// ---------------------------------------------------------------------------

const SOURCE = `
  requirement US-001 { type: UserStory  title: "Login" }
  requirement AC-001 parent US-001 { type: AcceptanceCriteria  title: "valid creds" }
  requirement AC-002 parent US-001 { type: AcceptanceCriteria  title: "session starts" }
  requirement AC-003 parent US-001 { type: AcceptanceCriteria  title: "session refreshes" }
  requirement US-002 { type: UserStory  title: "Uncovered" }

  system Shop {
    subdomain Identity {
      context Auth {
        aggregate LoginSession {
          operation start() {}
          test "valid credentials are accepted" verifies TC-001 {}
          test "session refresh runs" verifies TC-003 {}
        }
      }
    }
    deployable api { platform: node  contexts: [Auth] }
    test e2e "session can be started" against api verifies TC-002 {}
  }

  testCase TC-001 verifies AC-001 { covers [ Identity.Auth.LoginSession.start ] }
  testCase TC-002 verifies AC-002 { covers [ Identity.Auth.LoginSession.start ] }
  testCase TC-003 verifies AC-003 { covers [ Identity.Auth.LoginSession.start ] }
`;

const RESULTS: TestOutcome[] = [
  { name: "valid credentials are accepted", suite: "LoginSession", status: "fail" },
  { name: "session can be started", suite: "Shop e2e", status: "pass" },
  // "session refresh runs" never ran → TC-003 UNVERIFIED → AC-003 UNVERIFIED.
  { name: "a hand-written test", suite: "LoginSession", status: "pass" },
];

const rollup = (loom: LoomModel, results: readonly TestOutcome[] = RESULTS): VerificationIR =>
  computeVerification(
    loom.traceability!,
    loom.requirements.map((r) => r.id),
    results,
  );

async function fixture(): Promise<{ loom: LoomModel; v: VerificationIR }> {
  const loom = await buildLoomModel(SOURCE);
  return { loom, v: rollup(loom) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `RequirementVerdict` union's runtime values, read out of the type
 *  declaration itself — so a verdict added to the union is covered here
 *  without anyone remembering to extend a hand-written list. */
const VERDICTS: RequirementVerdict[] = (() => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/ir/types/loom-ir.ts", import.meta.url)),
    "utf8",
  );
  const decl = src.match(/export type RequirementVerdict =([^;]+);/);
  if (!decl) throw new Error("RequirementVerdict union not found in src/ir/types/loom-ir.ts");
  const values = [...decl[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as RequirementVerdict);
  if (values.length === 0) throw new Error(`no literals in RequirementVerdict union: ${decl[1]}`);
  return values;
})();

/** The label escaping `renderVerdictGraph` applies (`"` → `'`). */
const esc = (s: string): string => s.replace(/"/g, "'");

interface ParsedGraph {
  /** node id → label text (inside the quotes). */
  nodes: Map<string, string>;
  edges: [string, string][];
  /** node id → the mermaid class assigned by a `class` line. */
  classOf: Map<string, string>;
  /** class names given a `classDef`. */
  classDefs: Set<string>;
  header: string;
}

function parseGraph(mmd: string): ParsedGraph {
  const nodes = new Map<string, string>();
  const edges: [string, string][] = [];
  const classOf = new Map<string, string>();
  const classDefs = new Set<string>();
  const all = mmd.split("\n");
  for (const line of all.slice(1)) {
    if (line === "") continue;
    const node = line.match(/^ {2}(\w+)\["(.*)"\]$/);
    if (node) {
      expect(nodes.has(node[1]), `duplicate mermaid node id ${node[1]}`).toBe(false);
      nodes.set(node[1], node[2]);
      continue;
    }
    const edge = line.match(/^ {2}(\w+) --> (\w+)$/);
    if (edge) {
      edges.push([edge[1], edge[2]]);
      continue;
    }
    const cls = line.match(/^ {2}class ([\w,]+) (\w+)$/);
    if (cls) {
      for (const n of cls[1].split(",")) classOf.set(n, cls[2]);
      continue;
    }
    const def = line.match(/^ {2}classDef (\w+) /);
    if (def) {
      classDefs.add(def[1]);
      continue;
    }
    throw new Error(`unrecognised mermaid line (graph is corrupt): ${JSON.stringify(line)}`);
  }
  return { nodes, edges, classOf, classDefs, header: all[0] };
}

/** A minimal `LoomModel` carrying only what the renderers read: the
 *  requirement list and the traceability `childrenOf` index. */
function fakeLoom(requirements: RequirementIR[], childrenOf: Record<string, string[]>): LoomModel {
  return { requirements, traceability: { childrenOf } } as unknown as LoomModel;
}

/** A `VerificationIR` assigning `verdict` to every requirement of `loom`. */
function fakeVerification(loom: LoomModel, verdict: RequirementVerdict): VerificationIR {
  const requirements: VerificationIR["requirements"] = {};
  for (const r of loom.requirements) {
    requirements[r.id] = { verdict, testCaseIds: [], failingTestCaseIds: [] };
  }
  return {
    version: 1,
    testCases: {},
    requirements,
    summary: {
      verified: 0,
      failing: 0,
      untested: 0,
      unverified: 0,
      total: loom.requirements.length,
    },
    diagnostics: { unknownTests: [], unmappedTestCases: [] },
  };
}

const req = (id: string, title: string, parentId?: string): RequirementIR => ({
  id,
  type: "UserStory",
  title,
  ...(parentId ? { parentId } : {}),
});

// ---------------------------------------------------------------------------
// GLYPH / MMD_CLASS totality
// ---------------------------------------------------------------------------

describe("verdict maps are total over RequirementVerdict", () => {
  it("reads a non-trivial verdict set out of the union declaration", () => {
    expect(VERDICTS).toEqual(
      expect.arrayContaining(["VERIFIED", "FAILING", "UNTESTED", "UNVERIFIED"]),
    );
  });

  it("computeVerification only ever emits verdicts from that set", async () => {
    const { v } = await fixture();
    const emitted = new Set(Object.values(v.requirements).map((r) => r.verdict));
    // The fixture is built to exercise every verdict the rollup can produce.
    expect([...emitted].sort()).toEqual(["FAILING", "UNTESTED", "UNVERIFIED", "VERIFIED"]);
    for (const verdict of emitted) expect(VERDICTS).toContain(verdict);
  });

  it("GLYPH renders a distinct, defined glyph for every verdict", () => {
    const loom = fakeLoom([req("R1", "only")], {});
    const glyphs = new Map<string, RequirementVerdict>();
    for (const verdict of VERDICTS) {
      const md = renderVerificationMd(loom, fakeVerification(loom, verdict));
      const head = md.split("\n").find((l) => l.includes("**R1**"));
      expect(head, `no requirement row rendered for ${verdict}`).toBeDefined();
      const m = head!.match(/^- (\S+) \*\*R1\*\* \((\w+)\)/);
      expect(m, `unparsable requirement row for ${verdict}: ${head}`).not.toBeNull();
      const [, glyph, shown] = m!;
      expect(shown).toBe(verdict);
      // A verdict missing from GLYPH interpolates as the string "undefined".
      expect(glyph, `GLYPH has no entry for verdict ${verdict}`).not.toBe("undefined");
      expect(glyph.length).toBeGreaterThan(0);
      expect(glyphs.has(glyph), `glyph ${glyph} is shared by ${glyphs.get(glyph)}/${verdict}`).toBe(
        false,
      );
      glyphs.set(glyph, verdict);
    }
  });

  it("MMD_CLASS gives every verdict a distinct class that carries a classDef", () => {
    const loom = fakeLoom([req("R1", "only")], {});
    const classes = new Map<string, RequirementVerdict>();
    for (const verdict of VERDICTS) {
      const g = parseGraph(renderVerdictGraph(loom, fakeVerification(loom, verdict)));
      const [nodeId] = [...g.nodes.keys()];
      const cls = g.classOf.get(nodeId);
      expect(cls, `no class line for verdict ${verdict}`).toBeDefined();
      expect(cls, `MMD_CLASS has no entry for verdict ${verdict}`).not.toBe("undefined");
      // An unstyled class silently renders the node in the default colour.
      expect(g.classDefs, `no classDef for ${cls} (verdict ${verdict})`).toContain(cls!);
      expect(classes.has(cls!), `class ${cls} is shared by ${classes.get(cls!)}/${verdict}`).toBe(
        false,
      );
      classes.set(cls!, verdict);
    }
  });
});

// ---------------------------------------------------------------------------
// pct()
// ---------------------------------------------------------------------------

describe("pct", () => {
  it("renders n/a — not NaN% — when there are no requirements", () => {
    const loom = fakeLoom([], {});
    const v = computeVerification({ execTests: [], testsByRequirement: {} }, [], []);
    const md = renderVerificationMd(loom, v);
    expect(v.summary.total).toBe(0);
    expect(md).toContain("Verified **n/a** of requirements");
    expect(md).not.toMatch(/NaN/);
  });

  it("agrees with the rendered verdict counts", async () => {
    const { loom, v } = await fixture();
    const md = renderVerificationMd(loom, v);
    const m = md.match(
      /Verified \*\*(\S+)\*\* of requirements — (\d+) verified, (\d+) failing, (\d+) unverified, (\d+) untested \(of (\d+)\)\./,
    );
    expect(m, `summary sentence not found in:\n${md}`).not.toBeNull();
    const [, pct, verified, failing, unverified, untested, total] = m!;

    const counts: Record<string, number> = { VERIFIED: 0, FAILING: 0, UNVERIFIED: 0, UNTESTED: 0 };
    for (const r of Object.values(v.requirements)) counts[r.verdict]++;

    expect(Number(total)).toBe(loom.requirements.length);
    expect(Number(verified)).toBe(counts.VERIFIED);
    expect(Number(failing)).toBe(counts.FAILING);
    expect(Number(unverified)).toBe(counts.UNVERIFIED);
    expect(Number(untested)).toBe(counts.UNTESTED);
    expect(Number(verified) + Number(failing) + Number(unverified) + Number(untested)).toBe(
      Number(total),
    );
    expect(pct).toBe(`${Math.round((counts.VERIFIED / loom.requirements.length) * 100)}%`);
  });
});

// ---------------------------------------------------------------------------
// Markdown coverage
// ---------------------------------------------------------------------------

describe("renderVerificationMd", () => {
  it("renders every requirement exactly once, with its rolled-up verdict", async () => {
    const { loom, v } = await fixture();
    const md = renderVerificationMd(loom, v);
    expect(Object.keys(v.requirements).length).toBe(loom.requirements.length);
    for (const r of loom.requirements) {
      const rows = md
        .split("\n")
        .filter((l) => l.includes(`**${r.id}**`))
        .map((l) => l.trimStart());
      expect(rows.length, `${r.id} rendered ${rows.length}× in the Markdown`).toBe(1);
      expect(rows[0]).toContain(`(${v.requirements[r.id].verdict})`);
      expect(rows[0]).toContain(r.title);
    }
  });

  it("indents children under their parent and names the failing test cases", async () => {
    const { loom, v } = await fixture();
    const rows = renderVerificationMd(loom, v)
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- "));
    const rowFor = (id: string) => rows.find((l) => l.includes(`**${id}**`))!;
    expect(rowFor("US-001").startsWith("- ")).toBe(true);
    expect(rowFor("AC-001").startsWith("  - ")).toBe(true); // one level of nesting
    expect(rowFor("AC-001")).toContain("failing: `TC-001`");
    expect(rowFor("US-001")).toContain("failing: `TC-001`"); // rolled up to the parent
  });

  it("lists every test case, and the results that matched no declared test", async () => {
    const { loom, v } = await fixture();
    const md = renderVerificationMd(loom, v);
    for (const id of Object.keys(v.testCases)) {
      expect(md).toContain(`| \`${id}\` | ${v.testCases[id].status} |`);
    }
    expect(md).toContain("Results matching no declared test:");
    expect(md).toContain("a hand-written test");
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip
// ---------------------------------------------------------------------------

describe("renderVerificationJson", () => {
  it("round-trips through JSON.parse", async () => {
    const { v } = await fixture();
    const text = renderVerificationJson(v);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(v);
  });

  it("is deterministic", async () => {
    const { v } = await fixture();
    expect(renderVerificationJson(v)).toBe(renderVerificationJson(v));
  });
});

// ---------------------------------------------------------------------------
// Graph coverage
// ---------------------------------------------------------------------------

describe("renderVerdictGraph", () => {
  it("emits exactly one node per requirement and one edge per childrenOf link", async () => {
    const { loom, v } = await fixture();
    const g = parseGraph(renderVerdictGraph(loom, v));
    expect(g.header).toBe("flowchart LR");

    // One node per requirement — matched by label, so id/title escaping is
    // pinned at the same time.
    expect(g.nodes.size).toBe(loom.requirements.length);
    const nodeIdOf = new Map<string, string>();
    for (const r of loom.requirements) {
      const want = esc(`${r.id}: ${r.title}`);
      const hits = [...g.nodes].filter(([, label]) => label === want);
      expect(hits.length, `${r.id} rendered ${hits.length}× as a mermaid node`).toBe(1);
      nodeIdOf.set(r.id, hits[0][0]);
    }

    // One edge per childrenOf link, in both directions of the check: no
    // missing edge, and no edge that childrenOf does not license.
    const children = loom.traceability!.childrenOf;
    const want = new Set<string>();
    for (const r of loom.requirements) {
      for (const c of children[r.id] ?? []) {
        if (nodeIdOf.has(c)) want.add(`${nodeIdOf.get(r.id)}->${nodeIdOf.get(c)}`);
      }
    }
    expect(want.size).toBeGreaterThan(0); // the fixture has a real hierarchy
    expect(new Set(g.edges.map(([a, b]) => `${a}->${b}`))).toEqual(want);

    // Every node is classed by its verdict — no node left unstyled.
    for (const r of loom.requirements) {
      expect(g.classOf.get(nodeIdOf.get(r.id)!)).toBeDefined();
    }
  });

  it("drops an edge to a child that is not a requirement (no orphan node)", () => {
    const loom = fakeLoom([req("R1", "root")], { R1: ["GHOST"] });
    const g = parseGraph(renderVerdictGraph(loom, fakeVerification(loom, "UNTESTED")));
    expect(g.nodes.size).toBe(1);
    expect(g.edges).toEqual([]);
  });

  it("a Mermaid-hostile id or title cannot corrupt the graph", () => {
    // Titles come from a STRING literal, so `"` / `[` / `]` / `(` / `)` /
    // `-->` are all reachable from real `.ddd` source; ids are fabricated
    // here because TRACE_ID can't spell them — `renderVerdictGraph` is an
    // exported function over LoomModel, so it must not depend on that.
    const parent = 'R"1[x](y)-->z';
    const child = 'R"2[a](b)-->c';
    const loom = fakeLoom(
      [
        req(parent, 'a "quoted" [label] (with) --> arrows'),
        req(child, 'another "]" --> label', parent),
      ],
      { [parent]: [child] },
    );
    const g = parseGraph(renderVerdictGraph(loom, fakeVerification(loom, "FAILING")));

    // Node ids are synthesised, never derived from the requirement id.
    expect([...g.nodes.keys()].every((n) => /^r\d+$/.test(n))).toBe(true);
    expect(g.nodes.size).toBe(2);
    // Labels carry no raw `"` — an unescaped quote would close the label
    // early and turn the rest of the title into mermaid syntax.
    for (const label of g.nodes.values()) expect(label).not.toContain('"');
    expect([...g.nodes.values()]).toEqual([
      esc(`${parent}: a "quoted" [label] (with) --> arrows`),
      esc(`${child}: another "]" --> label`),
    ]);
    // The `-->` inside the labels does not read as an extra edge.
    expect(g.edges.length).toBe(1);
    const [from, to] = g.edges[0];
    expect(g.nodes.get(from)).toContain(esc(parent));
    expect(g.nodes.get(to)).toContain(esc(child));
  });
});
