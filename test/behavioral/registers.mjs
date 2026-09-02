// ---------------------------------------------------------------------------
// The behavioural tier's PURE REGISTERS — the data that decides which cases run
// and which must carry a wire golden, with NOTHING but node: builtins behind it.
//
// WHY IT IS ITS OWN FILE.  These registers have two readers with very different
// dependency footprints: the runners (`cases.mjs` / `wire-differential.mjs`,
// which pull in `pg` and `esbuild` from test/behavioral/node_modules) and the
// FAST SUITE gate `test/conformance/wire-golden-coverage.test.ts`, which runs
// off the ROOT install where test/behavioral/node_modules does not exist at all
// — CI runs `npm ci` at the root and only the behavioural workflows also run it
// in here.
//
// Importing the runner modules from the fast suite therefore works on a
// developer machine that happens to have installed the behavioural deps, and
// fails in CI with `Cannot find package 'esbuild'`.  It did exactly that, and
// the local probe that "proved" it fine was measuring a machine, not the repo.
// Keeping the registers dependency-free is what makes one copy serve both.
// ---------------------------------------------------------------------------

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "wire-golden");
const SYSTEMS_DIR = join(HERE, "systems");

/** True when a `.ddd` carries a behavioural block a runner can boot — a
 *  `test e2e "…"` (api) or a domain `test "…"` (unit). Mirror of the gate's
 *  detection in test/conformance/behavioural-coverage.test.ts. */
export function hasBehaviouralBlock(src) {
  return /(^|\n)\s*test\s+e2e\s+"/.test(src) || /(^|\n)\s*test\s+"/.test(src);
}

/** True when a `.ddd` DECLARES an api-tier `test e2e "…"` block.  The runner
 *  legs use this to tell a UNIT-ONLY case (domain `test "…"` blocks, no e2e —
 *  admitted by `hasBehaviouralBlock` above, and run by the node oracle via its
 *  derive-tiers-from-the-emitted-file-map posture) apart from a case that
 *  declared e2e and emitted nothing, which stays an error.  Until
 *  numeric-operands (M-T6.44) no fixture used the unit-only shape, so the five
 *  cross-backend legs had hard-required the e2e suite without anything
 *  noticing. */
export function declaresE2e(src) {
  return /(^|\n)\s*test\s+e2e\s+"/.test(src);
}

/** True when this `.ddd` makes its backends mount the root `POST /files` +
 *  `GET /files/{key}` pair (M-T1.2) — i.e. some declared field is `File`-typed
 *  AND an `objectStore` resource is wired.  Both halves are required: the
 *  emitters gate the routes on exactly that conjunction (an objectStore with no
 *  `File` field — `resources.ddd` — emits no /files route at all).
 *
 *  Read off the SOURCE, like `hasBehaviouralBlock` above and each runner's
 *  `authMode`, so all seven runner legs derive the same answer from the same
 *  place and cannot drift apart.  It gates one thing only: whether the wire
 *  differential fires its absent-file probe (M-T6.39).  A false positive would
 *  merely record the framework miss; a false negative loses the probe — which
 *  is why the conformance pin `files-absent-object-envelope-parity.test.ts`
 *  asserts the emitters directly rather than trusting this predicate. */
export function mountsFileRoutes(src) {
  return /:\s*File(\?|\[\])?\s*(\/\/|$|\n)/m.test(src) && /kind:\s*objectStore/.test(src);
}

/** Per-(platform, case) behavioural skips: a corpus feature or shared system that
 *  GENERATES and COMPILES on a backend but whose RUNTIME behaviour has a known,
 *  tracked gap there.  Honest and documented (not a silent drop) — the case still
 *  runs on every other backend, the gate (behavioural-coverage.test.ts) still
 *  requires it to EMIT everywhere, and each entry cites its bug in
 *  docs/audits/behavioral-parity-bugs-2026-07.md.  Removing an entry is how a fix
 *  re-arms the boot.  Keyed by platform clause; applies to BOTH featureCases and
 *  sharedSystemCases (a case name is either a corpus feature id or a systems/ file). */
/** Exported so the fast-suite golden-coverage gate
 *  (test/conformance/wire-golden-coverage.test.ts) can derive "does this case
 *  run anywhere?" from the SAME register the runners filter by, rather than
 *  keeping a second copy of it in sync. */
export const BEHAVIOURAL_SKIP = {
  node: {
    // B1 fixed (event-sourced create now folds events before asserting
    // invariants — src/generator/typescript/emit/aggregate.ts).  `ledger`
    // re-armed; no node skips remain.
  },
  dotnet: {
    // B2/B3/B4/B8/B12 fixed — no dotnet skips remain. (B12: `crudish` on a
    // `shape: document` aggregate now emits a matching `DeleteAsync` on the
    // document-repo impl, so the interface/impl method sets agree; repository.ts.)
  },
  java: {},
  // The DAPPER adapter of the .NET backend (`run-dapper.mjs` forces this exact
  // clause, and looks the skip set up by it).
  "dotnet { persistence: dapper }": {
    // DRAINED — all three entries (`projection-aggregation`, `projection-groupby`,
    // `read-gates`) claimed one boundary: "dapper emits no query-time projection
    // reads, `loom.dapper-unsupported` refuses to generate".  That claim was true
    // when `src/generator/dotnet/query-projection-emit.ts` had no `dapper` branch
    // at all (#2468); M-T6.25 ported the four direct-table arms to raw Npgsql, so
    // the three fixtures generate, compile and answer on this adapter.  The
    // adapter's own oracle agrees and is the ratchet that would have caught a
    // stale entry here: `test/e2e/corpus-dotnet-dapper-build.test.ts` now carries
    // `DAPPER_UNSUPPORTED = { "tenancy-hierarchy": … }` and nothing else, and it
    // FAILS an entry whose `loom.dapper-unsupported` no longer fires.  Deleting
    // these three RE-ARMS boots that had never run once on this leg.
  },
  elixir: {
    // B19 (`seed-values`) is FIXED — M-T6.37 landed the Ecto seeder, so this leg
    // now runs the collection reads over seeded rows like the other four:
    // `<Ctx>.Seeds` (elixir/vanilla/seed-emit.ts) inserts domain rows through the
    // aggregate's repository changeset, `raw` rows as schema-qualified INSERTs,
    // ship-once per dataset behind the `__loom_seed` marker, invoked from
    // `Application.start/2` on a SERVING node.  Its skip entry is deleted rather
    // than re-worded: an allowlist ratchets, so the fix removes the waiver.
    // B5/B6/B7/B9/B10/B11 fixed; batch-5 (core-domain/document/inheritance) booted
    // green on elixir — no elixir skips remain. (B11: `T or <primitive>` union return
    // now mints a valid PascalCase module alias; openapi-emit.ts.)
    // (B9: single `contains`
    // arms the `__put_assoc_parts/1` helper on an `assign` mutation + the helper
    // handles a single `has_one` struct; context-emit.ts. B10: parent-table
    // migrations ordered FK-topologically so a cross-aggregate reference target
    // is created first; migrations-emit.ts.)
  },
};

/** The shared `systems/*.ddd` cases, DERIVED from the directory rather than a
 *  hand-list — a new shared system is gated the moment it lands, and a golden
 *  can't be deleted to dodge the gate. */
export function sharedSystemGoldenCases() {
  return readdirSync(SYSTEMS_DIR)
    .filter((f) => f.endsWith(".ddd"))
    .map((f) => f.replace(/\.ddd$/, ""))
    .sort();
}

/**
 * Cases deliberately allowed to run with NO golden.
 *
 * EMPTY, and meant to stay that way.  Every case the tier records is compared;
 * an entry here is a signed decision to leave one uncompared, and it needs the
 * same thing a wire waiver needs — a reason and a named exit.
 *
 * This list exists because the alternative is what `main` did until this
 * change: a missing golden was only a failure for the shared systems, and for
 * every FEATURE case it returned `none` — no comparison, no message.  Four
 * cases (`field-mask`, `policy-deny`, `seed-values`, `vo-field-default`) had
 * been running that way on every backend leg, two of them authorization-shaped.
 * Nothing was wrong with them; nothing was checking them either.
 *
 * That is the failure mode the skip-outcome comment below already names — "a
 * silently-off gate is worse than an absent one" — so the missing-golden branch
 * now holds to the same standard: a new fixture fails with the capture command
 * until someone decides, rather than joining the tier ungated by default.
 *
 * @type {ReadonlyArray<{case: string, reason: string}>}
 */
export const GOLDEN_OPT_OUT = [];

/** Every case that must carry a golden: all of them, minus the signed opt-outs. */
export function requiredGoldenCases() {
  const optedOut = new Set(GOLDEN_OPT_OUT.map((o) => o.case));
  return { optedOut, shared: sharedSystemGoldenCases() };
}

export const goldenPath = (caseName) => join(GOLDEN_DIR, `${caseName}.json`);
