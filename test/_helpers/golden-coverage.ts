// Which behavioural cases MUST carry a wire golden — DERIVED from the same
// sources the runners boot from, never a hand-list.
//
// The wire-golden tier (M-T9.11) compares every case a runner records against a
// committed answer key in `test/behavioral/wire-golden/`.  #2577 made a missing
// golden a failure — but that check lives inside `wire-differential.mjs`, i.e.
// inside a BOOTED runner, so it only speaks on the heavy per-backend legs.  A PR
// that mints a recorded case (a corpus fixture that grows a `test e2e`, a new
// `systems/*.ddd`, a new `corpus.json` api entry) without capturing its golden
// therefore passes `test.yml` and reddens `main` afterwards — the mechanism
// behind two of the recent main-reds.
//
// This module is the boot-free half: it reproduces the runners' case assembly
// from the SAME modules (`cases.mjs` for the behavioural-block detection and the
// per-platform skip register, the typed corpus manifest, the `systems/` dir,
// `corpus.json`, `GOLDEN_OPT_OUT`) so the fast suite can assert the goldens
// exist.  Nothing here reads a golden's CONTENT — that stays the booted tier's
// job; this only answers "is there one, and is every one still claimed".

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BEHAVIOURAL_SKIP, hasBehaviouralBlock } from "../behavioral/cases.mjs";
import { GOLDEN_OPT_OUT } from "../behavioral/wire-differential.mjs";
import { PLATFORM_CLAUSE } from "../fixtures/corpus/backends.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS_DIR = path.join(REPO, "test/fixtures/corpus");
const BEHAVIORAL_DIR = path.join(REPO, "test/behavioral");
const SYSTEMS_DIR = path.join(BEHAVIORAL_DIR, "systems");
export const GOLDEN_DIR = path.join(BEHAVIORAL_DIR, "wire-golden");

/** The `platform:` clause `run-dapper.mjs` forces (its `DAPPER_CLAUSE`).  Spelled
 *  here because that runner keeps it module-private — and pinned against the
 *  runner's own source by `dapperClauseInRunner()`, so a drift fails loudly
 *  instead of silently dropping that leg out of the derivation. */
export const DAPPER_CLAUSE = "dotnet { persistence: dapper }";

/** True when `run-dapper.mjs` still spells its clause the way `DAPPER_CLAUSE` does. */
export function dapperClauseInRunner(): boolean {
  const src = fs.readFileSync(path.join(BEHAVIORAL_DIR, "run-dapper.mjs"), "utf8");
  return src.includes(`const DAPPER_CLAUSE = ${JSON.stringify(DAPPER_CLAUSE)}`);
}

/**
 * Every runner leg that runs the wire gate (`makeWireGate`), as the
 * `(backendKey, platformClause)` pair it hands `featureCases` / the clause it
 * hands `sharedSystemCases`.  Seven runners, six distinct pairs — `run.mjs` and
 * `run-mikroorm.mjs` collect the identical `("node", "node")` set.
 */
export const WIRE_GATED_LEGS: readonly {
  readonly runner: string;
  readonly backendKey: string;
  readonly platformClause: string;
}[] = [
  { runner: "run.mjs", backendKey: "node", platformClause: PLATFORM_CLAUSE.node },
  { runner: "run-mikroorm.mjs", backendKey: "node", platformClause: PLATFORM_CLAUSE.node },
  { runner: "run-dotnet.mjs", backendKey: "dotnet", platformClause: PLATFORM_CLAUSE.dotnet },
  { runner: "run-dapper.mjs", backendKey: "dotnet", platformClause: DAPPER_CLAUSE },
  { runner: "run-java.mjs", backendKey: "java", platformClause: PLATFORM_CLAUSE.java },
  { runner: "run-python.mjs", backendKey: "python", platformClause: PLATFORM_CLAUSE.python },
  { runner: "run-elixir.mjs", backendKey: "vanilla", platformClause: PLATFORM_CLAUSE.vanilla },
];

/** The platform clauses the legs above can be skipped by — every key of
 *  `BEHAVIOURAL_SKIP` must be one of these, or the register is talking about a
 *  leg nobody runs (and is therefore inert). */
export function knownSkipClauses(): string[] {
  return [...new Set(WIRE_GATED_LEGS.map((l) => l.platformClause))].sort();
}

const skipSetFor = (platformClause: string): Record<string, string> =>
  (BEHAVIOURAL_SKIP as Record<string, Record<string, string>>)[platformClause] ?? {};

/** Mirror of `cases.mjs` → `featureCases`, names only: every manifest feature
 *  declaring `backendKey`, carrying a behavioural block, not skipped on this
 *  platform clause.  (The runner bundles the manifest through esbuild to read it
 *  from `.mjs`; here it is a plain typed import of the same file.) */
export function featureCaseNames(backendKey: string, platformClause: string): string[] {
  const skip = skipSetFor(platformClause);
  return CORPUS.filter(
    (f) =>
      (f.backends as readonly string[]).includes(backendKey) &&
      !(f.id in skip) &&
      hasBehaviouralBlock(fs.readFileSync(path.join(CORPUS_DIR, `${f.id}.ddd`), "utf8")),
  ).map((f) => f.id);
}

/** Mirror of `cases.mjs` → `sharedSystemCases`, names only. */
export function sharedSystemCaseNames(platformClause: string): string[] {
  const skip = skipSetFor(platformClause);
  return fs
    .readdirSync(SYSTEMS_DIR)
    .filter((p) => p.endsWith(".ddd"))
    .map((f) => f.replace(/\.ddd$/, ""))
    .filter((name) => !(name in skip))
    .sort();
}

/** Mirror of `run.mjs`'s example cases — the `corpus.json` entries that carry an
 *  api or unit tier (the UI-only ones are `run-ui.mjs`'s job and record nothing). */
export function exampleCaseNames(): string[] {
  const corpusJson = JSON.parse(
    fs.readFileSync(path.join(BEHAVIORAL_DIR, "corpus.json"), "utf8"),
  ) as { cases: { name: string; ddd: string; api?: boolean; unit?: boolean }[] };
  return corpusJson.cases
    .filter((c) => !String(c.ddd).startsWith("corpus:") && (c.api || c.unit))
    .map((c) => c.name)
    .sort();
}

/** Cases signed off as allowed to run with no golden (`GOLDEN_OPT_OUT`). */
export function optedOutCaseNames(): string[] {
  return (GOLDEN_OPT_OUT as { case: string; reason: string }[]).map((o) => o.case);
}

export interface RequiredCase {
  readonly name: string;
  /** Every wire-gated runner that records this case — quoted in the failure so
   *  the remedy names a runner that can actually capture the golden. */
  readonly runners: string[];
}

/**
 * The union over every wire-gated leg of the cases it records, minus the signed
 * opt-outs.  Union, not intersection: a golden is per CASE (one answer key, all
 * backends compared to it), so a case that runs on even one leg needs one — and
 * a case skipped on ONE backend (`BEHAVIOURAL_SKIP`) still records everywhere
 * else.  A case skipped on EVERY leg drops out, which is what makes the register
 * the runners' skip register and not a second list.
 */
export function requiredGoldenCases(): RequiredCase[] {
  const byName = new Map<string, string[]>();
  const add = (name: string, runner: string) => {
    const runners = byName.get(name);
    if (runners) runners.push(runner);
    else byName.set(name, [runner]);
  };
  for (const leg of WIRE_GATED_LEGS) {
    for (const n of featureCaseNames(leg.backendKey, leg.platformClause)) add(n, leg.runner);
    for (const n of sharedSystemCaseNames(leg.platformClause)) add(n, leg.runner);
  }
  // Example (broad) systems ride the node runner only.
  for (const n of exampleCaseNames()) add(n, "run.mjs");

  const optedOut = new Set(optedOutCaseNames());
  return [...byName.entries()]
    .filter(([name]) => !optedOut.has(name))
    .map(([name, runners]) => ({ name, runners: [...new Set(runners)].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Just the names — the shape most callers want. */
export function requiredGoldenCaseNames(): string[] {
  return requiredGoldenCases().map((c) => c.name);
}

/** Every committed golden, by case name. */
export function committedGoldenNames(): string[] {
  return fs
    .readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
