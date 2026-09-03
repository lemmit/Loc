// API-operation CALLER CENSUS (quality-audit R5).
//
// `api-surface.test.ts` + `api-surface-parity.test.ts` gate that every derived
// api operation is MOUNTED — the route exists on all five backends and answers
// the declared success shape.  Nothing gated that any of them is ever CALLED.
//
// That gap is not hypothetical.  #2342 found the canonical `update` route
// carrying two contract bugs at once (a `PATCH` its own OpenAPI never
// advertised, and a `200` + body against a declared `204`), on the one route
// NO test in the repo called.  Both were invisible to every compile and
// spec-parity gate, because a spec-vs-spec comparison cannot see a route
// nothing drives.  `experience_gathered.md` §59 ("write-path client methods
// emitted but never driven") and §62 ("zero callers in any test") are the same
// class.
//
// So this censuses, per `.ddd` system, the two sets:
//
//   DERIVED  — `deriveContextOperations` (the SAME derivation #2342 gated the
//              backends against; never re-invented here), restricted to the
//              contexts a BACKEND deployable actually serves.
//   CALLED   — the operations invoked from that system's own `test e2e` blocks,
//              read off the LOWERED IR via `collectApiCallShapes`, the exact
//              matcher `src/system/e2e-render.ts` uses to emit the suite.  A
//              second copy of the match would let this credit a caller the
//              emitter never emits.
//
// Pure parse → lower → enrich.  No boot, no docker: it belongs in the fast
// suite, and it answers a question no booted gate asks.
//
// RATCHET, not big-bang.  The uncovered set today is 13 operations (216 at
// #2380 → 210 once `destroy`/`all` became reachable in #2429 → 126 once the
// `crudish` `update` class was drained → 13 once `destroy` + `all` and their
// tails were); each is an explicit entry in `UNCALLED_PINS`
// (`api-caller-census-pins.ts`) with a reason, and NONE of the 13 is an
// un-authored test any more — every one names a route the `test e2e` surface
// cannot reach as it stands, so the file has become a findings list.
// The gate compares the two sets EXACTLY, so it fails when
//   (1) a NEW derived operation has no caller and no pin, and
//   (2) a pin goes STALE — the op gained a caller, or was renamed/removed —
//       which forces a drain to delete its pin in the same PR.
//
// Mutation-proven (CLAUDE.md → "Mutation-prove a new gate"): the last describe
// block seeds an inline `.ddd` whose `rename` operation has no caller, asserts
// the gate names it, then adds the caller and asserts it goes green.  A second
// proof runs against real data — the wire GOLDENS, which record what each
// booted backend actually requested, must attribute to exactly the same called
// set this census computes from the IR.  (That cross-check earned its place
// during authoring: it caught this file crediting `getOrderById` as called in
// `corpus/state-gate`, where the golden shows only two routes were ever hit.)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LoomModel } from "../../src/ir/types/loom-ir.js";
import { aggregateSegment, deriveContextOperations } from "../../src/ir/util/api-surface.js";
import {
  camelId,
  opCreate,
  opFind,
  opGetById,
  opOperation,
} from "../../src/ir/util/openapi-ids.js";
import { platformFor } from "../../src/platform/registry.js";
import { collectApiCallShapes } from "../../src/system/e2e-render.js";
import { lowerFirst, plural, snake } from "../../src/util/naming.js";
import { requiredGoldenCaseNames } from "../_helpers/golden-coverage.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { corpusSource } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";
import {
  E2E_LESS_CORPUS_FIXTURES,
  PIN_CLASS_CENSUS,
  R,
  UNATTRIBUTED_CALLS,
  UNCALLED_PINS,
} from "./api-caller-census-pins.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// Population — every `.ddd` a per-PR behavioural leg BOOTS and whose e2e suite
// it runs.  Three sources, all already single-sourced elsewhere:
//   systems/  — the shared behavioural systems (one wire golden each)
//   broad/    — the api-tier entries of test/behavioral/corpus.json
//   corpus/   — the typed corpus manifest, minus fixtures with no `test e2e`
// ---------------------------------------------------------------------------

interface CensusCase {
  /** Stable key, also the `UNCALLED_PINS` key. */
  readonly key: string;
  /** Repo-relative `.ddd` path, quoted in the failure remedy. */
  readonly file: string;
  readonly source: string;
}

/** A fixture carries an api behavioural block iff its source has a `test e2e`.
 *  Same detection as `behavioural-coverage.test.ts` / `cases.mjs`. */
const hasE2EBlock = (src: string): boolean => /(^|\n)\s*test\s+e2e\s+"/.test(src);

/** The shared systems + corpus fixtures spell `platform: __PLATFORM__`; the
 *  census is platform-independent (it reads routes, not emitted code), so it
 *  resolves the token to the node backend the way `run.mjs` does. */
const asNode = (src: string): string => src.replaceAll("__PLATFORM__", "node");

function loadPopulation(): { cases: CensusCase[]; e2eLessCorpus: string[] } {
  const cases: CensusCase[] = [];

  const systemsDir = path.join(REPO, "test/behavioral/systems");
  for (const f of fs
    .readdirSync(systemsDir)
    .filter((n) => n.endsWith(".ddd"))
    .sort()) {
    const rel = `test/behavioral/systems/${f}`;
    cases.push({
      key: `systems/${f.replace(/\.ddd$/, "")}`,
      file: rel,
      source: asNode(fs.readFileSync(path.join(REPO, rel), "utf8")),
    });
  }

  const corpusJson = JSON.parse(
    fs.readFileSync(path.join(REPO, "test/behavioral/corpus.json"), "utf8"),
  ) as { cases: { name: string; ddd: string; api?: boolean }[] };
  for (const c of corpusJson.cases) {
    // `api: false` entries are UI-tier only — their `test e2e` blocks lower to
    // Playwright specs, not api calls, so they have no callers to census.
    if (!c.api) continue;
    cases.push({
      key: `broad/${c.name}`,
      file: c.ddd,
      source: asNode(fs.readFileSync(path.join(REPO, c.ddd), "utf8")),
    });
  }

  const e2eLessCorpus: string[] = [];
  for (const feature of CORPUS) {
    const raw = corpusSource(feature.id);
    if (!hasE2EBlock(raw)) {
      e2eLessCorpus.push(feature.id);
      continue;
    }
    cases.push({
      key: `corpus/${feature.id}`,
      file: `test/fixtures/corpus/${feature.id}.ddd`,
      source: asNode(raw),
    });
  }
  return { cases, e2eLessCorpus };
}

const { cases: POPULATION, e2eLessCorpus: E2E_LESS } = loadPopulation();

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

interface DerivedOp {
  readonly id: string;
  readonly kind: string;
  readonly method: string;
  readonly path: string;
  readonly aggregate: string;
  /** `api.<seg>.<verb>` shape a `test e2e` body would write to call it. */
  readonly callHint: string;
}

interface Census {
  readonly derived: DerivedOp[];
  readonly called: Set<string>;
  /** `api.<slug>.<method>` calls that resolve to NO derived operation — a
   *  projection read or a workflow run (the `apiSurfaceCoverage.notLifted`
   *  classes), or a typo.  Pinned rather than discarded: a call this census
   *  cannot attribute is a call it cannot credit, and silently dropping one
   *  would let an operation look uncovered for the wrong reason. */
  readonly unattributed: Set<string>;
}

/** The e2e call a derived operation would answer.  Mirrors `renderApiCall`'s
 *  dispatch (`create` / `getById` / `destroy` / operation name / find name);
 *  only `gateProbe` still has NO e2e verb at all — see `R.gateProbe`. */
function callHint(op: { kind: string; idTokens: readonly string[]; aggregate: string }): string {
  const seg = aggregateSegment(op.aggregate);
  switch (op.kind) {
    case "create":
      return `api.${seg}.create({…})`;
    case "getById":
      return `api.${seg}.getById(id)`;
    case "destroy":
      return `api.${seg}.destroy(id)`;
    case "operation":
      return `api.${seg}.${op.idTokens[0]}(id, {…})`;
    case "find":
      // The auto-`findAll` reads the bare collection root; its verb is `all`,
      // which is `idTokens[0]` like any other find.
      return `api.${seg}.${op.idTokens[0]}({…})`;
    default:
      // gateProbe — no `can_<op>` verb reaches the probe route today.
      return `(no e2e verb reaches api.${seg} ${op.kind})`;
  }
}

/** Every slug `src/system/e2e-render.ts` accepts for an aggregate. */
const slugsFor = (agg: string): Set<string> =>
  new Set([lowerFirst(agg), snake(plural(agg)), lowerFirst(plural(agg))]);

function censusOf(model: LoomModel): Census {
  const derived: DerivedOp[] = [];
  const aggregates: string[] = [];
  for (const sys of model.systems) {
    // Only contexts a BACKEND deployable serves are exposed over HTTP; a
    // context no deployable ships has no route surface to call.
    const served = new Set<string>();
    for (const d of sys.deployables) {
      let frontend = false;
      try {
        frontend = platformFor(d.platform).isFrontend;
      } catch {
        frontend = false; // unknown platform → treat as backend, like e2e-render
      }
      if (!frontend) for (const n of d.contextNames) served.add(n);
    }
    for (const sd of sys.subdomains) {
      for (const ctx of sd.contexts) {
        if (!served.has(ctx.name)) continue;
        for (const op of deriveContextOperations(ctx)) {
          derived.push({
            id: op.id,
            kind: op.kind,
            method: op.method,
            path: op.path,
            aggregate: op.aggregate,
            callHint: callHint(op),
          });
        }
        for (const a of ctx.aggregates) aggregates.push(a.name);
      }
    }
  }

  const ids = new Set(derived.map((d) => d.id));
  const called = new Set<string>();
  const unattributed = new Set<string>();
  for (const sys of model.systems) {
    for (const t of sys.e2eTests) {
      if (t.kind !== "api") continue; // ui e2e drives pages, not routes
      for (const call of collectApiCallShapes(t.statements)) {
        const agg = aggregates.find((a) => slugsFor(a).has(call.aggregateSlug));
        if (!agg) {
          unattributed.add(`api.${call.aggregateSlug}.${call.method} (no such aggregate)`);
          continue;
        }
        // The verb dispatch `renderApiCall` performs: `create` / `getById` are
        // fixed names; anything else is an operation OR a repository find, and
        // both render their operationId from the same token pair.
        const candidates =
          call.method === "create"
            ? [camelId(opCreate(agg))]
            : call.method === "getById"
              ? [camelId(opGetById(agg))]
              : [camelId(opOperation(agg, call.method)), camelId(opFind(agg, call.method))];
        const hits = candidates.filter((c) => ids.has(c));
        if (hits.length === 0) {
          unattributed.add(`api.${call.aggregateSlug}.${call.method} (no derived operation)`);
        }
        for (const h of hits) called.add(h);
      }
    }
  }
  return { derived, called, unattributed };
}

/** The gate, as data: one message per operation that is uncovered-and-unpinned
 *  or pinned-but-no-longer-uncovered.  Shared by the real cases and by the
 *  mutation proof below, so the proof exercises the SHIPPED logic. */
function censusFailures(
  c: CensusCase,
  census: Census,
  pins: Record<string, string>,
  unattributedPins: readonly string[] = [],
): string[] {
  const uncovered = census.derived.filter((d) => !census.called.has(d.id));
  const uncoveredIds = new Set(uncovered.map((d) => d.id));
  const out: string[] = [];
  for (const op of uncovered) {
    if (op.id in pins) continue;
    out.push(
      `${c.key}: derived api operation \`${op.id}\` (${op.method.toUpperCase()} ${op.path}) ` +
        `has NO caller in any \`test e2e\` block of ${c.file}. ` +
        `Remedy: add a call to ${op.callHint} in a \`test e2e\` block of ${c.file}, ` +
        `or pin it in UNCALLED_PINS["${c.key}"] (test/ir/api-caller-census-pins.ts) with a reason.`,
    );
  }
  for (const id of Object.keys(pins)) {
    if (uncoveredIds.has(id)) continue;
    const exists = census.derived.some((d) => d.id === id);
    out.push(
      `${c.key}: STALE pin \`${id}\` — ` +
        (exists
          ? "this operation now HAS a caller. Delete the pin in the same PR that added the caller."
          : `no such derived operation in ${c.file} (renamed or removed). Delete the pin.`) +
        ` (UNCALLED_PINS["${c.key}"], test/ir/api-caller-census-pins.ts)`,
    );
  }
  // A call the census cannot map to a derived operation credits nothing — so an
  // UNEXPECTED one means either a not-yet-lifted route class reached a test body
  // (fine, pin it) or the attribution is broken (not fine).  Either way it must
  // be looked at, not swallowed.
  const seen = [...census.unattributed].sort();
  const expected = [...unattributedPins].sort();
  if (JSON.stringify(seen) !== JSON.stringify(expected)) {
    out.push(
      `${c.key}: unattributable \`api.*\` calls changed — got [${seen.join(", ")}], ` +
        `pinned [${expected.join(", ")}]. A call that maps to no derived operation credits no ` +
        "coverage: confirm it is a not-yet-lifted route class (projection read, workflow run — " +
        "`apiSurfaceCoverage.notLifted`) and update UNATTRIBUTED_CALLS" +
        `["${c.key}"] (test/ir/api-caller-census-pins.ts), or fix the call.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("api caller census — every derived operation has a runtime caller or a pin", () => {
  it("censuses a non-trivial population", () => {
    // A silently-empty population is the classic way a census gate passes
    // without reaching anything (`experience_gathered.md` §63).
    expect(POPULATION.length).toBeGreaterThanOrEqual(30);
  });

  it("keeps the per-class pin census honest", () => {
    // The counts used to live in a header comment and drifted to 15/2/1 against
    // 17/3/1 actual — prose nothing reads cannot be contradicted.  Recompute
    // from the pins themselves and compare both ways: an added pin whose count
    // was not raised fails, and so does a drained one whose count was not
    // lowered.  Reasons are matched by their `R.*` STRING (the pins store the
    // value, not the key), so a renamed class shows up here as an unknown
    // reason rather than as a silently-zero count.
    const byReason = new Map<string, string>(Object.entries(R).map(([k, v]) => [v, k]));
    const actual: Record<string, number> = {};
    for (const ops of Object.values(UNCALLED_PINS)) {
      for (const reason of Object.values(ops)) {
        const cls = byReason.get(reason);
        expect(cls, `pin reason is not one of the R.* constants: ${reason}`).toBeDefined();
        actual[cls as string] = (actual[cls as string] ?? 0) + 1;
      }
    }
    expect(
      actual,
      "PIN_CLASS_CENSUS (test/ir/api-caller-census-pins.ts) disagrees with the pins " +
        "below it. Adding a pin raises its count; draining one lowers it; a class at " +
        "zero is deleted from the census.",
    ).toEqual(PIN_CLASS_CENSUS);
  });

  it("pins no case that left the population", () => {
    const keys = new Set(POPULATION.map((c) => c.key));
    const orphans = Object.keys(UNCALLED_PINS).filter((k) => !keys.has(k));
    expect(
      orphans,
      `UNCALLED_PINS names cases that are no longer censused (renamed/deleted .ddd, or a ` +
        `corpus fixture that lost its \`test e2e\` block): ${orphans.join(", ")}. Delete them.`,
    ).toEqual([]);
  });

  it("lists every corpus fixture that has no `test e2e` block at all", () => {
    // Not this gate's drain (M-T9.13 owns authoring those blocks), but never a
    // silent cap: the excluded set is committed, so a fixture gaining an e2e
    // block — or a new e2e-less fixture landing — fails here first.
    expect(
      [...E2E_LESS].sort(),
      "corpus fixtures with no `test e2e` block changed. A fixture that GAINED one must be " +
        "removed from E2E_LESS_CORPUS_FIXTURES and gains a census case (with pins); a NEW " +
        "e2e-less fixture must be added there, and is a runtime-coverage gap in its own right.",
    ).toEqual([...E2E_LESS_CORPUS_FIXTURES].sort());
  });

  for (const c of POPULATION) {
    it(`${c.key}`, async () => {
      const census = censusOf(await buildLoomModel(c.source));
      expect(
        census.derived.length,
        `${c.key} derived no api operations — the census would pass vacuously`,
      ).toBeGreaterThan(0);
      const failures = censusFailures(
        c,
        census,
        UNCALLED_PINS[c.key] ?? {},
        UNATTRIBUTED_CALLS[c.key] ?? [],
      );
      expect(failures, `\n${failures.join("\n\n")}\n`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-check against the wire goldens — the census, measured against what a
// booted backend ACTUALLY requested.
// ---------------------------------------------------------------------------

interface WireGolden {
  entries: { method: string; path: string }[];
}

/** A census key is `<tier>/<case>`; the golden is keyed by the case alone. */
const caseNameOf = (key: string): string => key.replace(/^[a-z]+\//, "");

/** The wire golden for a case, if one exists (`test/behavioral/wire-golden/`). */
function goldenFor(key: string): WireGolden | undefined {
  const p = path.join(REPO, "test/behavioral/wire-golden", `${caseNameOf(key)}.json`);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as WireGolden) : undefined;
}

const WITH_GOLDEN = POPULATION.filter((c) => goldenFor(c.key) !== undefined);

/** The census cases a behavioural runner RECORDS, so a golden must exist for
 *  each — derived from the runners' own case assembly, not counted by hand
 *  (`test/_helpers/golden-coverage.ts`, the source `golden-coverage.test.ts`
 *  gates). */
const REQUIRED_GOLDEN = new Set(requiredGoldenCaseNames());
const EXPECT_GOLDEN = POPULATION.filter((c) => REQUIRED_GOLDEN.has(caseNameOf(c.key)));

describe("api caller census — cross-checked against the wire goldens", () => {
  it("cross-checks every census case the behavioural tier records", () => {
    // Was `>= 20` against a population of 45+ — ~25 cases of slack, so a case
    // that lost its golden (or never got one) silently dropped out of the
    // cross-check while this stayed green.  The expectation is now DERIVED:
    // exactly the census cases the runners record must carry a golden, so the
    // set can only change when the case list does.
    expect(
      EXPECT_GOLDEN.length,
      "no census case is expected to carry a golden — the derivation has broken",
    ).toBeGreaterThan(20);
    expect(
      WITH_GOLDEN.map((c) => c.key).sort(),
      "the census cases WITH a wire golden are no longer exactly the cases the behavioural " +
        "runners record. A case that gained one belongs in the derivation " +
        "(test/_helpers/golden-coverage.ts); a case that LOST one is a hole in the " +
        "cross-check — capture it with `cd test/behavioral && LOOM_WIRE_UPDATE=1 node run.mjs " +
        "<case>` (golden-coverage.test.ts names it too).",
    ).toEqual(EXPECT_GOLDEN.map((c) => c.key).sort());
  });

  for (const c of WITH_GOLDEN) {
    it(`${c.key}: the IR-derived caller set equals the requests actually made`, async () => {
      const census = censusOf(await buildLoomModel(c.source));
      const byRoute = new Map(census.derived.map((d) => [`${d.method} ${d.path}`, d.id]));
      // A golden entry is `{method, templated path}` — the same vocabulary the
      // derivation speaks, so the join needs no heuristics beyond dropping the
      // query string a find carries.
      const fromGolden = new Set<string>();
      for (const e of goldenFor(c.key)!.entries) {
        const id = byRoute.get(`${e.method.toLowerCase()} ${e.path.split("?")[0]}`);
        // Unmapped routes are the NOT-LIFTED classes (projection reads,
        // workflows) — `apiSurfaceCoverage.notLifted`, out of scope by design.
        if (id) fromGolden.add(id);
      }
      expect(
        [...fromGolden].sort(),
        `${c.key}: the operations the booted backend actually requested disagree with the ` +
          "operations this census reads off the e2e IR. Either the census mis-attributes a " +
          "call (it credits a caller that never runs), or the golden is stale — rebaseline it " +
          "with `cd test/behavioral && LOOM_WIRE_UPDATE=1 node run.mjs`.",
      ).toEqual([...census.called].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// Mutation proof — the gate must FAIL on a seeded defect.  Inline sources, so
// no real fixture is mutated.
// ---------------------------------------------------------------------------

const MUT_HEAD = `
system Mut {
  subdomain Core {
    context Ops {
      aggregate Widget with crudish {
        name: string
        operation rename(to: string) { name := to }
      }
      repository Widgets for Widget { }
    }
  }
  storage primary { type: postgres }
  resource widgetState { for: Ops, kind: state, use: primary }
  deployable d { platform: node contexts: [Ops] dataSources: [widgetState] port: 3000 }
`;

/** Only `create` + `getById` are driven — `rename` is emitted and never called. */
const MUT_UNCALLED = `${MUT_HEAD}
  test e2e "create and read back" against d {
    let w = api.widgets.create({ name: "a" })
    let read = api.widgets.getById(w)
    expect(read.name).toBe("a")
  }
}
`;

/** The same system with the one missing caller added. */
const MUT_CALLED = `${MUT_HEAD}
  test e2e "create, rename and read back" against d {
    let w = api.widgets.create({ name: "a" })
    api.widgets.rename(w, { to: "b" })
    let read = api.widgets.getById(w)
    expect(read.name).toBe("b")
  }
}
`;

const MUT_CASE = (source: string): CensusCase => ({
  key: "mutation/widget",
  file: "(inline)",
  source,
});

describe("api caller census — mutation proof", () => {
  it("FAILS, naming the operation, when a derived operation has no caller", async () => {
    const c = MUT_CASE(MUT_UNCALLED);
    const census = censusOf(await buildLoomModel(c.source));
    // The op is real and mounted…
    expect(census.derived.map((d) => d.id)).toContain("renameWidget");
    // …and the census says nothing calls it.
    expect(census.called).not.toContain("renameWidget");

    const failures = censusFailures(c, census, {});
    const named = failures.filter((f) => f.includes("`renameWidget`"));
    expect(
      named.length,
      `expected a failure naming renameWidget, got:\n${failures.join("\n")}`,
    ).toBe(1);
    expect(named[0]).toContain("mutation/widget"); // the system
    expect(named[0]).toContain("POST /api/widgets/{id}/rename"); // the route
    expect(named[0]).toContain("add a call to api.widgets.rename(id, {…})"); // the remedy
    expect(named[0]).toContain("or pin it in UNCALLED_PINS"); // the other remedy
  });

  it("goes GREEN for that operation once the caller is added", async () => {
    const c = MUT_CASE(MUT_CALLED);
    const census = censusOf(await buildLoomModel(c.source));
    expect(census.called).toContain("renameWidget");
    expect(censusFailures(c, census, {}).filter((f) => f.includes("`renameWidget`"))).toEqual([]);
  });

  it("FAILS on a STALE pin — the op gained a caller", async () => {
    const c = MUT_CASE(MUT_CALLED);
    const census = censusOf(await buildLoomModel(c.source));
    const failures = censusFailures(c, census, { renameWidget: "pinned yesterday" });
    expect(failures.some((f) => f.includes("STALE pin `renameWidget`"))).toBe(true);
    expect(failures.find((f) => f.includes("STALE pin"))).toContain("Delete the pin");
  });

  it("FAILS on a STALE pin — the op no longer exists", async () => {
    const c = MUT_CASE(MUT_UNCALLED);
    const census = censusOf(await buildLoomModel(c.source));
    const failures = censusFailures(c, census, { renamedAwayWidget: "pinned yesterday" });
    expect(failures.some((f) => f.includes("STALE pin `renamedAwayWidget`"))).toBe(true);
    expect(failures.find((f) => f.includes("STALE pin"))).toContain("renamed or removed");
  });
});
