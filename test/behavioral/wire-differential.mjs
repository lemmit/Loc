// ---------------------------------------------------------------------------
// Runner-side glue for the cross-backend runtime wire differential
// (M-T9.11 slices b + c).  The pure logic lives in test/_helpers/wire-record.ts
// (fast-suite tested); this file is the thin `.mjs` wrapper the booted-backend
// runners call — load the golden, diff, apply waivers, print, gate.
//
// THE SHAPE OF THE GATE.  Slice (a) diffed the five backends against EACH OTHER
// over one heavy compose boot (nightly).  Here each backend is diffed against a
// COMMITTED canonical recording instead, which buys two things:
//
//   • an ORACLE — the golden is a reviewed answer key, so a divergence names a
//     winner.  (Slice (a)'s RS-11 finding is the cautionary tale: three
//     backends agreed and all three were wrong.)
//   • PER-PR for free — A ≡ golden ∧ B ≡ golden ⇒ A ≡ B, so the N-way diff
//     becomes N independent one-way gates, each riding a behavioral workflow
//     that already boots that backend on every PR.  No new CI boot.
//
// Env:
//   LOOM_WIRE_UPDATE=1  rebaseline — write the goldens from THIS run instead of
//                       comparing.  Deliberate + reviewable: the diff lands in
//                       the PR as a change to a checked-in file.
//   LOOM_WIRE_OFF=1     skip the gate entirely (local debugging escape hatch).
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GOLDEN_DIR = join(HERE, "wire-golden");
const SYSTEMS_DIR = join(HERE, "systems");

export const WIRE_OFF = process.env.LOOM_WIRE_OFF === "1";
export const WIRE_UPDATE = process.env.LOOM_WIRE_UPDATE === "1";

/** The TS core (`wire-record.ts` + `wire-waivers.ts`) bundled once per process —
 *  the same one-shot-esbuild trick `cases.mjs` uses for `manifest.ts`, so the
 *  runners consume the fast-suite-tested source rather than a forked copy. */
let corePromise = null;
export function loadWireCore(workDir) {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    mkdirSync(workDir, { recursive: true });
    const shim = join(workDir, "_wire-core-entry.mts");
    writeFileSync(
      shim,
      `export * from ${JSON.stringify(join(REPO, "test/_helpers/wire-record.ts"))};\n` +
        `export { WIRE_WAIVERS } from ${JSON.stringify(join(REPO, "test/_helpers/wire-waivers.ts"))};\n`,
    );
    const outfile = join(workDir, "_wire-core.mjs");
    await build({
      entryPoints: [shim],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    });
    return import(pathToFileURL(outfile).href);
  })();
  return corePromise;
}

/** The cases that MUST carry a golden: the shared `systems/*.ddd`, which every
 *  backend runs (`sharedSystemCases`).  DERIVED from the directory, not a
 *  hand-list — a new shared system is gated the moment it lands, and a golden
 *  can't be deleted to dodge the gate. */
export function requiredGoldenCases() {
  return readdirSync(SYSTEMS_DIR)
    .filter((f) => f.endsWith(".ddd"))
    .map((f) => f.replace(/\.ddd$/, ""))
    .sort();
}

export const goldenPath = (caseName) => join(GOLDEN_DIR, `${caseName}.json`);

function readGolden(caseName) {
  const p = goldenPath(caseName);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeGolden(caseName, backend, entries) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(
    goldenPath(caseName),
    `${JSON.stringify({ case: caseName, oracle: backend, entries }, null, 2)}\n`,
  );
}

/**
 * Compare one case's recording against its golden.
 *
 * Returns `{ gating, waived, report, usedWaivers, skipped }`.  `gating > 0` is a
 * gate failure the caller folds into its exit code; `skipped` means there is no
 * golden for this case (and it isn't a required one), so nothing was asserted.
 */
export async function gateWireRecording({ backend, caseName, entries, workDir }) {
  const none = { gating: [], waived: [], usedWaivers: new Set(), skipped: true, report: "" };
  if (WIRE_OFF) return none;

  const core = await loadWireCore(workDir);

  if (WIRE_UPDATE) {
    writeGolden(caseName, backend, entries);
    return {
      ...none,
      skipped: false,
      report: `  ⟐ wire: golden rebaselined from ${backend} (${entries.length} requests)`,
    };
  }

  const golden = readGolden(caseName);
  if (!golden) {
    if (requiredGoldenCases().includes(caseName)) {
      return {
        gating: [{ seq: -1, request: "(recording)", kind: "request-count", path: "$", golden: undefined, actual: entries.length }],
        waived: [],
        usedWaivers: new Set(),
        skipped: false,
        report:
          `  ✗ wire: no golden for shared system "${caseName}" — every systems/*.ddd case must be\n` +
          "      gated. Capture one with:  LOOM_WIRE_UPDATE=1 node run.mjs " +
          caseName,
      };
    }
    return none;
  }

  const divergences = core.diffRecording(golden.entries, entries);
  const split = core.applyWaivers(divergences, backend, caseName, core.WIRE_WAIVERS);
  return {
    gating: split.gating,
    waived: split.waived,
    usedWaivers: split.usedWaivers,
    skipped: false,
    report: core.renderWireReport(backend, caseName, split),
  };
}

/**
 * Run-level ratchet: waivers that apply to this backend but matched nothing
 * across every case that ran are STALE — the divergence they excuse is fixed,
 * so the entry must go.  Without this the registry only ever grows and stops
 * meaning anything (the same anti-slack rule as the M-T9.8 allowlist ratchet).
 */
export async function reportStaleWaivers({ backend, ranCases, usedWaivers, workDir }) {
  if (WIRE_OFF || WIRE_UPDATE) return { stale: [], report: "" };
  const core = await loadWireCore(workDir);
  const stale = core.staleWaivers(core.WIRE_WAIVERS, backend, ranCases, usedWaivers);
  if (!stale.length) return { stale, report: "" };
  const lines = [
    `\n✗ wire: ${stale.length} STALE waiver(s) for ${backend} — the divergence they excuse no`,
    "  longer occurs. Delete them from test/_helpers/wire-waivers.ts:",
    ...stale.map((w) => `    - ${w.backends.join(",")} @ ${w.path} — ${w.reason}`),
  ];
  return { stale, report: lines.join("\n") };
}

/**
 * The whole gate for one runner, as a two-call object — so all five runners
 * share ONE implementation instead of five copies of the same bookkeeping.
 *
 *   const wire = makeWireGate("java", WORK);
 *   …per case…  wire.check(c.name, out.wire)
 *   …at the end… const bad = await wire.finish()   // fold into the exit code
 */
export function makeWireGate(backend, workDir) {
  const usedWaivers = new Set();
  const ranCases = [];
  let gating = 0;
  return {
    /**
     * Compare one case's recording; prints its own line, returns the count.
     *
     * `results` (optional) is the case's test outcomes.  A recording is only
     * MEANINGFUL when the api tier actually completed: a failed or half-run
     * suite makes fewer requests, which the differ would faithfully report as a
     * `request-count` divergence — technically true, but it restates a failure
     * the runner is already gating on and buries the real error. So a failed
     * tier is noted and skipped, never re-diagnosed.
     */
    async check(caseName, entries, results) {
      if (WIRE_OFF) return 0;
      // No recording at all ⇒ the api tier never ran (a boot/infra failure the
      // runner has ALREADY counted as an errored case).
      if (entries == null) return 0;
      if (results?.some((r) => r.status !== "pass")) {
        process.stdout.write(
          "  ⟐ wire: skipped — the tier did not pass, so its recording is not comparable\n",
        );
        return 0;
      }
      const res = await gateWireRecording({ backend, caseName, entries, workDir });
      if (res.report) process.stdout.write(`${res.report}\n`);
      if (res.skipped) return 0;
      ranCases.push(caseName);
      for (const i of res.usedWaivers) usedWaivers.add(i);
      gating += res.gating.length;
      return res.gating.length;
    },
    /** Run-level ratchet + summary. Non-zero ⇒ the runner must exit non-zero. */
    async finish() {
      if (WIRE_OFF) {
        process.stdout.write("\nwire differential: SKIPPED (LOOM_WIRE_OFF=1)\n");
        return 0;
      }
      if (WIRE_UPDATE) {
        process.stdout.write("\nwire differential: goldens REBASELINED (LOOM_WIRE_UPDATE=1)\n");
        return 0;
      }
      const { stale, report } = await reportStaleWaivers({
        backend,
        ranCases,
        usedWaivers,
        workDir,
      });
      if (report) process.stdout.write(`${report}\n`);
      const bad = gating + stale.length;
      process.stdout.write(
        `\nwire differential (${backend}): ${ranCases.length} case(s) compared to golden, ` +
          `${gating} divergence(s)${stale.length ? `, ${stale.length} stale waiver(s)` : ""}\n`,
      );
      return bad;
    },
  };
}

/** The recorder source spliced into each runner's bundled entry.  Wraps the ONE
 *  dispatch chokepoint so request N is captured on every backend identically;
 *  the ordinal is the alignment key (ids are not — they differ per run). */
export function recorderPreamble() {
  return `import { toWireEntry as __toWireEntry } from ${JSON.stringify(join(REPO, "test/_helpers/wire-record.ts"))};
const __wire = [];
const __record = (dispatch) => async (req) => {
  const out = await dispatch(req);
  try {
    const r = out?.response;
    if (r) __wire.push(__toWireEntry(__wire.length, req.method, req.url, r.status, r.body ?? ""));
  } catch { /* recording must never affect the tier's pass/fail */ }
  return out;
};`;
}
