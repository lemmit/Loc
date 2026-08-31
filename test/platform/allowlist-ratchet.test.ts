import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Allowlist ratchet (M-T9.8, hollow-work audit, graduated CI check #3).
//
// The repo suppresses known gaps with explicit allowlists / skip-lists —
// showcase-completeness's ALLOWLIST of un-emitted grammar kinds, the corpus
// compile-tier skip maps, the heex-parity frozen gap set, and so on.  Each is
// a legitimate, reviewed escape valve.  The failure mode is SILENT GROWTH: a PR
// that can't make its feature pass on a backend quietly adds a skip entry, the
// gate goes green, and the coverage claim hollows out one line at a time.
//
// This gate snapshots each allowlist's entry count and fails when it grows past
// the pinned baseline.  Shrinking is always fine — when you drain an entry,
// lower its `max` in the same PR (the count is asserted `<= max`, and a strict
// "you left slack" reminder fires so the baseline tracks reality).  Raising a
// `max` is a deliberate, reviewed line in the diff — exactly the visibility the
// audit asked for — and every new allowlist entry must still cite an open
// tracker in its own comment (a convention this count-ratchet backstops).
//
// Adding a NEW allowlist to the codebase?  Register it here too, or the ratchet
// can't see it.  (The registry is itself audited: REGISTERED lists every
// suppression construct the 2026-07-13 sweep found; a new one belongs here.)
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type Kind = "set" | "record" | "nested-record";

interface Ratchet {
  /** Repo-relative file the allowlist lives in. */
  file: string;
  /** The `const NAME` the construct is bound to. */
  name: string;
  /** `set` → `new Set([...])` of string entries; `record` → `{ key: … }` map;
   *  `nested-record` → `{ group: { key: … } }`, counted at the LEAF level.
   *  The nested kind exists because counting a two-level register's top level
   *  pins the number of GROUPS (platform clauses), not suppressions — a
   *  ratchet that would sit still while the thing it guards tripled. */
  kind: Kind;
  /** Max entries allowed.  Lower it when you drain; raising it is a reviewed
   *  decision.  Every entry in the list must cite an open tracker. */
  max: number;
}

const REGISTERED: Ratchet[] = [
  // Un-emitted grammar kinds excused from the showcase HARD gate (M-T6.16 owns
  // draining these as their emitters land).
  {
    file: "test/conformance/showcase-completeness.test.ts",
    name: "ALLOWLIST",
    kind: "set",
    // 14: +ProjectionJoin +ProjectionSelect — the query-time projection
    // comprehension grammar nodes (read-path-architecture.md rev.13).
    //
    // NOT gated: `PROJECTION_QT_SUPPORTED` (`system-checks.ts`) is 5/5
    // (node/python/elixir/java/dotnet), so
    // `loom.projection-query-time-unsupported` fires only for a hypothetical
    // un-ported future backend.  These two stay allowlisted for the SHOWCASE
    // reason the allowlist itself gives (see the entries' comment in
    // `showcase-completeness.test.ts`): the same parity/blast-radius grounds
    // that keep folded `Projection` out of the shared single-file fixture, not
    // a missing emitter.  Draining them means adding them to `showcase.ddd`
    // and accepting the fan-out across every generator matrix — not waiting on
    // a port.
    max: 14,
  },
  // Walker primitives with a TSX renderer but no HEEx one.  Empty: the last
  // entry — `ProvenanceInfo`, the provenance "?" disclosure — landed its HEEx
  // renderer (a native `<details>` over the co-located `<field>_provenance`
  // jsonb column, read server-side off the Ecto struct; M-T1.19), so it now
  // renders on all six frontends.  Lowered 1→0 as the drain (M-T9.8).
  {
    file: "test/generator/elixir/heex-parity.test.ts",
    name: "KNOWN_HEEX_GAPS",
    kind: "record",
    // 1 = `DataGrid`.  It is TanStack-backed and holds a CLIENT row model,
    // which LiveView has no analogue for (every interaction would be a server
    // round-trip, and multi-column ORDER BY has no backend support); `Table`
    // is the fallback, server-driven on HEEx, so Phoenix is not silently
    // degraded.  Lowered 2→1 as the drain (M-T9.8): `Chart` shipped its HEEx
    // renderer.  Its pinned reason — "no JS-free LiveView charting" — was
    // false: the rows a chart plots are a grouped projection's, already
    // server-side in an assign, so the geometry is arithmetic and the output
    // is inline SVG with no library and no JS.
    max: 1,
  },
  // Per-backend corpus compile-tier skips (a widening gate FIXES the emitter
  // and drops the entry — see each file's header).
  { file: "test/e2e/corpus-java-build.test.ts", name: "JAVA_COMPILE_SKIP", kind: "record", max: 0 },
  {
    file: "test/e2e/corpus-python-build.test.ts",
    name: "PYTHON_COMPILE_SKIP",
    kind: "record",
    max: 0,
  },
  {
    file: "test/e2e/corpus-dotnet-build.test.ts",
    name: "DOTNET_COMPILE_SKIP",
    kind: "record",
    max: 0,
  },
  { file: "test/e2e/corpus-tsc-build.test.ts", name: "TS_COMPILE_SKIP", kind: "record", max: 0 },
  // The .NET Dapper adapter's compile tier.  Lowered 3 -> 2 by M-T6.29, which
  // drained `policy-deny`: the `deny` authz sentinel got its `whereToSql` arm
  // (`1 = 0`, ANDed into every read SELECT) and `dapper.ts` reads
  // `writeScopeFilter` to emit the `GetByIdForWriteAsync` the shared command
  // layer has always dispatched to.
  //
  // 2 -> 0 by M-T6.25.  Both remaining entries were the SAME bug — query-time
  // projection handlers were EF-LINQ over `AppDbContext` — and the folded read
  // controller's raw-Npgsql port was the precedent they needed.  That port is
  // written: the four direct-table arms read through `NpgsqlDataSource` now, so
  // this map is DRAINED, not reclassified.
  //
  // 0 -> 1, and the raise is the reviewed line this ratchet asks for.
  // `policy-document` joined the manifest's `dotnet` row (the EF document
  // repository's capability filter + write-scope member landed), which enrolled
  // it in THIS leg for the first time — and it found two more EF leaks in the
  // Dapper adapter, of exactly the class the 2 -> 0 drain above closed:
  // `EfOrgPathResolver.cs` is emitted whatever the adapter (CS0234/CS0246) and
  // the Dapper document repository never got the EF twin's
  // `GetByIdForWriteAsync` (CS0535).  So the count goes up while the repo's
  // knowledge does too: the defects predate the entry, and were invisible
  // because no dapper fixture had a `tenantRegistry` the compiler ever saw.
  //
  // 1 -> 0 again: both leaks are fixed.  The hierarchy seam now emits ONE
  // resolver per persistence adapter (`DapperOrgPathResolver.cs`, raw Npgsql
  // over the registry's `data_key`), and the Dapper document repository carries
  // the EF twin's `GetByIdForWriteAsync` — plus the in-app `_CapabilityVisible`
  // read filter it had also never received, which was the SILENT half (a
  // `tenantOwned` document aggregate read across tenants on this adapter).
  // `policy-document` compiles clean here under /warnaserror.
  {
    file: "test/e2e/corpus-dotnet-dapper-build.test.ts",
    name: "DAPPER_COMPILE_SKIP",
    kind: "record",
    max: 0,
  },
  // Capability boundaries the validator states honestly (`loom.dapper-unsupported`),
  // not gaps — these never reach the compiler.  1 -> 5: the reclassification
  // above (+3 query-time-projection fixtures, one of them the `projection-join`
  // fixture minted by the clause census) plus `read-gates`, whose query-time
  // gate kind hit the same boundary.  Every added entry is ONE pre-existing
  // boundary meeting more fixtures, not a new suppression — but the raise is
  // still a reviewed line, and `read-gates` costs this leg its find-gate and
  // folded-projection-gate coverage as collateral (stated at the entry).
  {
    file: "test/e2e/corpus-dotnet-dapper-build.test.ts",
    name: "DAPPER_UNSUPPORTED",
    kind: "record",
    // 2 -> 1, M-T6.25 — the acceptance ratchet `read-gates`' entry named.  It
    // was here for one reason: the fixture carries a query-time projection
    // (`OpenOrders`), and this adapter emitted none.  The port removed that
    // boundary, so the fixture is back to covering all three of its read-gate
    // kinds here rather than losing the find gate and the folded-projection
    // gate as per-fixture collateral.
    //
    // 1 = `tenancy-hierarchy`, the one boundary left with a real witness.
    max: 1,
  },
  // Primitives exempt from the pack testid contract.
  {
    file: "test/conformance/pack-testid-coverage.test.ts",
    name: "TSX_EXEMPT",
    kind: "set",
    max: 2,
  },
  // Pinned pipeline backward value-edges (empty — the graph is acyclic).
  { file: "test/platform/pipeline-layering.test.ts", name: "ALLOWED", kind: "record", max: 0 },
  // The two sibling M-T9.8 gates' own escape valves (both empty at zero).
  { file: "test/platform/dead-generator-exports.test.ts", name: "ALLOW", kind: "set", max: 0 },
  // Documented feature docs with no corpus fixture yet (feature-doc-coverage
  // Phase 2 gate).  Empty at zero — domain-services + scaffold-macros both
  // drained by their corpus fixtures; a documented feature with no fixture now
  // fails the gate outright.
  {
    file: "test/conformance/feature-doc-coverage.test.ts",
    name: "KNOWN_GAPS",
    kind: "set",
    max: 0,
  },
  // Catalogued `loom.*` codes with no proof anything ever raises them
  // (M-T9.33).  38 at the 2026-08-13 census; each leaves by gaining a
  // FIRING_FIXTURES entry that drives it, or an UNREACHABLE_PINS entry saying
  // what preempts it.  The census gate carries its own anti-slack check; this
  // registration is what makes the number visible from the one place that
  // lists every ratchet in the repo.
  //
  // 38 -> 31: four capability gates pinned UNREACHABLE (their supported-set
  // literal already names every backend family, and they have no second arm),
  // three driven by real fixtures through the `no db-owning deployable hosts
  // this context` arm the pinned four lack.
  //
  // 31 -> 17: the rest of the backend-capability cluster.  Eleven more latent
  // gates plus the two java entity-field backstops are pinned — this time as
  // CHECKED pins (`LATENT_GATES` re-reads each gate's real capability `Set` on
  // every run, so a sixth backend family fails the pin instead of leaving a
  // stale claim in prose).  `loom.field-mask-unsupported` was the one in the
  // cluster that turned out drivable, through the same `anyBackend` arm.
  //
  // …and of those, the two java entity-field backstops are now GONE
  // ENTIRELY rather than pinned (M-T6.36): a backend-named code for a shape
  // the LANGUAGE refuses on every platform is a phantom, not a backstop, and
  // it carried two undrainable rows in the M-T9.27 register.  The
  // unreachability moved to a scope-layer test that fails if part-type scope
  // widens.
  {
    file: "test/system/diagnostic-firing-census.data.ts",
    name: "UNCOVERED",
    kind: "set",
    max: 0,
  },
  // The MikroORM behavioural leg's skip register.  It was NOT registered here
  // until `projection-join` (a query-time projection the adapter refuses) had to
  // be added — so it had been growing unwatched, which is precisely the
  // silent-growth this ratchet exists to stop.  It carries its own STALE-key
  // check inside the runner (a key naming no corpus fixture fails the leg), but
  // nothing bounded its SIZE.
  //
  // The pin has now moved in BOTH directions inside one PR, which is the whole
  // case for it existing:
  //   4 -> 5  `policy-deny` was added on `main` by the read-deny work while
  //           this pin said 4. The registration's first act was catching a
  //           concurrent grower from another author.
  //   5 -> 2  M-T6.23 slice 4 (#2533) landed the adapter's query-time
  //           projection reads, retiring `projection-aggregation` /
  //           `-groupby` / `-join` together — one boundary, three fixtures,
  //           drained in one go. The `no stale slack` check is what forced
  //           this line down; left at 5 the register could have re-grown by
  //           three without anyone noticing.
  //
  // `policy-deny` then drained too: the adapter grew the `authz-filter` arm the
  // deny sentinel needed AND the write-scope pre-guard it had never read.  Then
  // `prefix-filter`, the last one, when `MIKRO_INTRINSIC_SQL` gave the adapter a
  // `raw()`-fragment arm for every `queryable` catalogue intrinsic — the
  // register is EMPTY.
  //
  // NOTE it lives in a `.mjs` runner rather than a vitest file, which is also
  // why it has no per-adapter ORACLE like the dapper maps have — the asymmetry
  // is real and stated at the entry.
  {
    file: "test/behavioral/run-mikroorm.mjs",
    name: "MIKRO_SKIP",
    kind: "record",
    // 2 → 1 → 0.  `policy-deny` drained with the `authz-filter` arm + the
    // write-scope pre-guard; `prefix-filter` with the intrinsic arm the entry
    // itself named as its exit condition.
    max: 0,
  },
  // The behavioural tier's OWN per-(platform, case) skip register — the sibling
  // of MIKRO_SKIP above, and unregistered for exactly as long.  It suppresses a
  // whole case on a whole backend leg, which is the single heaviest suppression
  // in the repo (a skipped case loses its CRUD round-trip, its RS-rule
  // assertions AND its wire-golden comparison on that leg), and nothing bounded
  // its size: the dapper cell alone had grown to three entries.
  //
  // 4 -> 1 in this PR.  The three `dotnet { persistence: dapper }` entries all
  // asserted ONE boundary — "dapper emits no query-time projection reads" — and
  // M-T6.25 removed it; the adapter's own oracle
  // (`corpus-dotnet-dapper-build.test.ts`, `DAPPER_UNSUPPORTED`) had already
  // ratcheted down to `tenancy-hierarchy` while these three stayed.  That
  // divergence is what this registration exists to make visible.
  //
  // 1 -> 0 in this PR.  The last entry was elixir/`seed-values` (B19 — the
  // backend emitted no seeder at all, so every `seed` dataset was silently
  // dropped and the rows that fixture reads back never existed).  M-T6.37
  // lands the Ecto seeder here, so the skip is deleted and the pin follows it
  // down in the same PR — the ratchet contract, and the reason this bound is
  // an EXACT pin rather than a ceiling: leaving `max: 1` would bank slack for
  // the next backend that wants to opt a whole case out of its leg.
  //
  // NOTE, as with MIKRO_SKIP: it lives in a `.mjs` runner, not a vitest file.
  // It moved out of `cases.mjs` into the dependency-free `registers.mjs` so the
  // fast-suite golden-coverage gate can read it without test/behavioral's own
  // node_modules; this ratchet is what NOTICED the move (`allowlist
  // 'BEHAVIOURAL_SKIP' not found — did it move/rename?`), which is the point of
  // pinning by file rather than by name alone.
  {
    file: "test/behavioral/registers.mjs",
    name: "BEHAVIOURAL_SKIP",
    kind: "nested-record",
    max: 0,
  },
  // The Elixir corpus compile tier's skip map — the fifth leg of the per-backend
  // set registered above (java / python / dotnet / tsc), left out only because
  // it lives in its own workflow (`corpus-elixir-build.yml`, split off for the
  // docker image + hex egress).  Empty today; registered so it cannot grow
  // unwatched the way the four siblings cannot.
  {
    file: "test/e2e/corpus-elixir-build.test.ts",
    name: "ELIXIR_COMPILE_SKIP",
    kind: "record",
    max: 0,
  },
  // The corpus features whose cells stop at the COMPILE tier — nothing boots
  // them, so no gate observes their runtime behaviour.  Signed with a reason
  // each; M-T9.13 owns the drain.  Unlike the skip maps above this register is
  // asserted set-EQUAL to the derived ledger, so it cannot go stale in the
  // other direction either — but it can still GROW, which is what this pins.
  {
    file: "test/system/gate-ledger.test.ts",
    name: "BEHAVIOURAL_ABSENT",
    kind: "record",
    max: 14,
  },
];

/** Extract the balanced `[...]` (set) or `{...}` (record) literal bound to
 *  `const NAME`, and count its entries — string-comment aware so a `:` or quote
 *  inside a comment/nested value never inflates the count.  `set`/`record` count
 *  the TOP level (depth 1); `nested-record` counts one level in (depth 2), i.e.
 *  the leaves of a `{ group: { key: reason } }` register.
 *  Returns the entry count. */
function countEntries(src: string, name: string, kind: Kind): number {
  const anchor = new RegExp(`\\bconst\\s+${name}\\b`).exec(src);
  if (!anchor) throw new Error(`allowlist '${name}' not found — did it move/rename?`);
  const opener = kind === "set" ? "[" : "{";
  const closer = kind === "set" ? "]" : "}";
  /** The bracket depth an entry marker counts at. */
  const entryDepth = kind === "nested-record" ? 2 : 1;
  // Seek the opener of the ASSIGNED VALUE, past the `=` — so an inline TYPE
  // annotation like `Record<string, { spec; why }[]>` (which contains its own
  // `{`) is skipped and we count the literal, not the type.
  const eq = src.indexOf("=", anchor.index);
  if (eq < 0) throw new Error(`assignment for '${name}' not found`);
  let i = src.indexOf(opener, eq);
  if (i < 0) throw new Error(`opener '${opener}' for '${name}' not found`);

  // Walk the balanced region, tracking bracket depth while skipping over
  // string / template / line- / block-comment spans.  At `entryDepth` count
  // entry markers: a string-literal start for a set, a `:` for a record key.
  let depth = 0;
  let count = 0;
  let sawEntryOnThisDepth1Slot = false;
  for (; i < src.length; i++) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    if (two === "//") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (two === "/*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // count a string literal as a set entry when it opens at the entry depth
      if (kind === "set" && depth === entryDepth && !sawEntryOnThisDepth1Slot) {
        count++;
        sawEntryOnThisDepth1Slot = true;
      }
      // skip to the matching, unescaped quote
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "[" || c === "{" || c === "(") {
      depth++;
      continue;
    }
    if (c === "]" || c === "}" || c === ")") {
      depth--;
      if (depth === 0) break; // closed the outer literal
      continue;
    }
    if (depth === entryDepth) {
      if ((kind === "record" || kind === "nested-record") && c === ":") count++;
      if (c === ",") sawEntryOnThisDepth1Slot = false; // next slot
    }
  }
  void closer;
  return count;
}

describe("allowlist ratchet — suppression lists don't grow (M-T9.8)", () => {
  it("registers the known suppression constructs (guard against vacuous pass)", () => {
    expect(REGISTERED.length).toBeGreaterThanOrEqual(8);
  });

  it.each(REGISTERED)("$name in $file is within its pinned baseline", ({
    file,
    name,
    kind,
    max,
  }) => {
    const abs = path.join(repoRoot, file);
    const src = fs.readFileSync(abs, "utf8");
    const n = countEntries(src, name, kind);
    expect(
      n,
      `${name} (${file}) has ${n} entries, over the pinned max ${max}. ` +
        "An allowlist grew: FIX the underlying gap and drain the entry, or if the " +
        "addition is genuinely justified, raise `max` here (a reviewed line) AND make " +
        "the new entry cite an open tracker. See M-T9.8.",
    ).toBeLessThanOrEqual(max);
  });

  it("baselines have no stale slack (drain lowers the max in the same PR)", () => {
    const slack: string[] = [];
    for (const { file, name, kind, max } of REGISTERED) {
      const n = countEntries(fs.readFileSync(path.join(repoRoot, file), "utf8"), name, kind);
      if (n < max) slack.push(`${name} (${file}): max ${max} but only ${n} entries — lower it`);
    }
    expect(slack, slack.join("\n")).toEqual([]);
  });
});
