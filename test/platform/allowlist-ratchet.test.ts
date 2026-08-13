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
    // comprehension grammar nodes (read-path-architecture.md rev.13).  Gated
    // (`loom.projection-query-time-unsupported`) until the per-backend
    // query-time emit lands, which owns draining these two (same lifecycle as
    // the Projection/CommandHandler mid-flight entries).
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
  // The .NET Dapper adapter's compile tier.  Both remaining entries are the
  // SAME bug — query-time projection handlers are EF-LINQ over `AppDbContext`
  // (M-T6.25) — and the folded read controller already has the raw-Npgsql port
  // they need, so that pair is a port with a precedent, not an open design
  // question.  Lowered 3 -> 2 by M-T6.29, which drained `policy-deny`: the
  // `deny` authz sentinel now has its `whereToSql` arm (`1 = 0`, ANDed into
  // every read SELECT) and `dapper.ts` reads `writeScopeFilter` to emit the
  // `GetByIdForWriteAsync` the shared command layer has always dispatched to.
  {
    file: "test/e2e/corpus-dotnet-dapper-build.test.ts",
    name: "DAPPER_COMPILE_SKIP",
    kind: "record",
    max: 2,
  },
  // Capability boundaries the validator states honestly (`loom.dapper-unsupported`),
  // not gaps — these never reach the compiler.  Raised 1 -> 2 for `read-gates`:
  // #2498 added the query-time-projection refusal without exempting the one corpus
  // fixture that trips it, which left `corpus × dotnet (Dapper)` — and `main` — red.
  // This is a widening, so it is stated rather than absorbed: the number goes back
  // to 1 (and DAPPER_COMPILE_SKIP to 0) with the one raw-Npgsql port all three
  // entries are waiting on.
  {
    file: "test/e2e/corpus-dotnet-dapper-build.test.ts",
    name: "DAPPER_UNSUPPORTED",
    kind: "record",
    max: 2,
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
