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

type Kind = "set" | "record";

interface Ratchet {
  /** Repo-relative file the allowlist lives in. */
  file: string;
  /** The `const NAME` the construct is bound to. */
  name: string;
  /** `set` → `new Set([...])` of string entries; `record` → `{ key: … }` map. */
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
  {
    file: "test/system/diagnostic-firing-census.data.ts",
    name: "UNCOVERED",
    kind: "set",
    max: 38,
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
  // What remains is two INDEPENDENT gaps, so the next drain will not be
  // wholesale: `prefix-filter` (the declared `MIKROORM_SUBSET` predicate
  // narrowing) and `policy-deny` (the read-deny form outside that subset).
  //
  // NOTE it lives in a `.mjs` runner rather than a vitest file, which is also
  // why it has no per-adapter ORACLE like the dapper maps have — the asymmetry
  // is real and stated at the entry.
  {
    file: "test/behavioral/run-mikroorm.mjs",
    name: "MIKRO_SKIP",
    kind: "record",
    max: 2,
  },
];

/** Extract the balanced `[...]` (set) or `{...}` (record) literal bound to
 *  `const NAME`, and count its TOP-LEVEL entries — string-comment aware so a
 *  `:` or quote inside a comment/nested value never inflates the count.
 *  Returns the entry count. */
function countEntries(src: string, name: string, kind: Kind): number {
  const anchor = new RegExp(`\\bconst\\s+${name}\\b`).exec(src);
  if (!anchor) throw new Error(`allowlist '${name}' not found — did it move/rename?`);
  const opener = kind === "set" ? "[" : "{";
  const closer = kind === "set" ? "]" : "}";
  // Seek the opener of the ASSIGNED VALUE, past the `=` — so an inline TYPE
  // annotation like `Record<string, { spec; why }[]>` (which contains its own
  // `{`) is skipped and we count the literal, not the type.
  const eq = src.indexOf("=", anchor.index);
  if (eq < 0) throw new Error(`assignment for '${name}' not found`);
  let i = src.indexOf(opener, eq);
  if (i < 0) throw new Error(`opener '${opener}' for '${name}' not found`);

  // Walk the balanced region, tracking bracket depth while skipping over
  // string / template / line- / block-comment spans.  At depth 1 (directly
  // inside the outer literal) count entry markers: a string-literal start for a
  // set, a `:` for a record key.
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
      // count a string literal as a set entry when it opens at depth 1
      if (kind === "set" && depth === 1 && !sawEntryOnThisDepth1Slot) {
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
    if (depth === 1) {
      if (kind === "record" && c === ":") count++;
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
