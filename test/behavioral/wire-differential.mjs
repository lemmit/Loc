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
 * The whole gate for one runner, as a two-call object — so all SEVEN runner
 * legs (five backends + the dapper/mikroorm persistence adapters) share ONE
 * implementation instead of seven copies of the same bookkeeping.
 *
 *   const wire = makeWireGate("java", WORK);
 *   …per case…  await wire.check(c.name, out.wire, out.results)
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
// The raw URLs, kept beside the recording rather than derived from it: the
// recorded \`path\` is TEMPLATED (\`/api/x/{id}\`), which is right for aligning
// two runs and useless as a URL to request.  Not itself compared.
const __urls = [];
// The credentials the tier itself used.  Without them the probes below measure the
// AUTH arm instead of the framework arm on any \`auth {}\` system — and the two
// disagree across backends for a reason that has nothing to do with RS-9 (node
// mounts auth as \`app.use("*", …)\` ahead of routing, so an unauthenticated
// miss is 401; phoenix routes first, so it is 404).  Forwarding them keeps the
// probe pointed at the thing it is meant to measure.
let __authHeaders = {};
// The UNWRAPPED dispatch, stashed as the recorder is installed.  The authz
// ladder below deliberately goes through THIS rather than the recorded wrapper:
// its requests are assertions about status codes, not part of the wire contract
// the golden freezes, and routing them through the recorder would shift every
// subsequent ordinal the golden aligns on — on the legs that adopt the ladder
// but not on the ones that haven't yet, which would fail the differential for a
// reason that has nothing to do with the wire.  (M-T9.11 can promote the ladder
// to a recorded probe later; that is a golden rebaseline, deliberately taken.)
let __rawDispatch = null;
const __record = (dispatch) => {
  __rawDispatch = dispatch;
  return async (req) => {
    const out = await dispatch(req);
    try {
      const r = out?.response;
      if (r) {
        __urls.push(req.url);
        for (const [k, v] of Object.entries(req.headers ?? {})) {
          if (!/^content-(type|length)$/i.test(k)) __authHeaders[k] = v;
        }
        __wire.push(__toWireEntry(__wire.length, req.method, req.url, r.status, r.body ?? ""));
      }
    } catch { /* recording must never affect the tier's pass/fail */ }
    return out;
  };
};

// ── framework-fault probes (RS-9) ───────────────────────────────────────────
// The emitted e2e suites only ever request what the API serves, so the wire
// golden ran five legs green while a wrong verb, an unknown path and an
// unreadable body answered five different shapes across three statuses.  These
// three requests go through the SAME dispatch, so they are recorded, diffed and
// waivable exactly like every other entry — no new boot, no new workflow.
//
// The target is taken from what the tier already requested: the first plain
// \`/api/<collection>\` it hit.  That keeps the probe backend-agnostic (the HTTP
// runners have only a base URL; there is no router to introspect) and skips a
// case that never makes such a call rather than guessing a path.
//
// PATCH is the wrong verb because no emitter produces a PATCH route — the REST
// surface is GET/POST/DELETE — so the mismatch is guaranteed rather than
// dependent on the fixture.  If the tier DID use PATCH on that path (an
// explicit \`route PATCH …\` api), the probe steps aside rather than assert a
// mismatch that isn't one.
const __frameworkProbes = async (dispatch) => {
  const paths = __urls.map((u) => { try { return new URL(u); } catch { return null; } }).filter(Boolean);
  const collection = paths.find((u) => /^\\/api\\/[^/]+$/.test(u.pathname));
  if (!collection) return;
  const usedPatch = __wire.some((e) => e.method === "PATCH");
  const origin = collection.origin;
  const json = { ...__authHeaders, "content-type": "application/json" };
  if (!usedPatch) {
    await dispatch({ method: "PATCH", url: origin + collection.pathname, headers: json, body: "{}" });
  }
  await dispatch({ method: "GET", url: origin + "/__loom_no_such_path", headers: { ...__authHeaders } });
  await dispatch({ method: "POST", url: origin + collection.pathname, headers: json, body: "{not json" });
  await __absentReadProbes(dispatch);
};

// ── absent-read probes (M-T6.31) ────────────────────────────────────────────
// The aggregate by-id 404 is the one error body several goldens already record
// (an emitted suite deletes a row and reads it back).  The OTHER by-key reads —
// the projection show and the workflow-instance show — no suite ever misses,
// because the \`test e2e\` DSL has no verb for "read this key that does not
// exist".  So those two routes shipped THREE different envelopes across the five
// backends (.NET's \`ProblemDetailsFactory\` shape, java's empty body, and a
// detail sentence elixir spelled differently) with every golden green.
//
// The probe is derived from what the tier ALREADY requested: for each distinct
// projection-show / instance-show URL it hit, re-request the same route with a
// key of the same SHAPE that cannot exist.  Two consequences worth stating:
//   * it is backend-agnostic (the HTTP runners have only a base URL — there is
//     no router to introspect), exactly like the framework probes above;
//   * a case that reads neither route is skipped rather than guessed at, so only
//     projection/instance-bearing goldens grow entries.
// Appended AFTER the framework probes so no existing ordinal moves.
const __absentKey = (seg) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
    ? "00000000-0000-0000-0000-000000000000"
    : /^\\d+$/.test(seg)
      // Max int32: absent on every backend, and parses under an \`int\`/\`long\`
      // path binding (a larger value would measure the BINDING, not the miss).
      ? "2147483647"
      : "__loom_absent";
const __absentReadProbes = async (dispatch) => {
  const seen = new Set();
  for (const raw of __urls) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    // \`/api/projections/<slug>/<key>\` and \`/api/workflows/<slug>/instances/<id>\`.
    const m = /^(\\/api\\/projections\\/[^/]+|\\/api\\/workflows\\/[^/]+\\/instances)\\/([^/]+)$/.exec(u.pathname);
    if (!m) continue;
    const target = m[1] + "/" + __absentKey(m[2]);
    if (seen.has(target)) continue;
    seen.add(target);
    await dispatch({ method: "GET", url: u.origin + target, headers: { ...__authHeaders } });
  }
};

// ── authorization ladder (M-T9.28 slice 1) ──────────────────────────────────
// The behavioural tier used to hold ONE identity, so the only authz statement it
// could make was "the satisfying principal gets through".  A \`requires\` emitted
// as a no-op passes that identically — which is exactly how #2446 shipped a
// guarded create with an OPEN route.  This walks the full ladder over ONE gated
// surface instead:
//
//   unauthenticated              → 401   (authn precedes authz)
//   authenticated-but-UNauthORIZED → 403 (the gate actually denies)
//   authorized                   → 2xx   (the gate is not always-deny)
//
// The middle rung is the one that needed the new principal, and the third rung
// is what keeps the first two honest — a backend that 403s everything would pass
// arms 1+2 alone.  All three requests go through the SAME dispatch chokepoint as
// the tier, so the ladder is backend-agnostic: the HTTP runners hand it a base
// URL and it never introspects a router.
//
// Credentials are supplied by the runner (\`creds\`), not derived here, because
// what "unauthorized" means is auth-flavour-shaped: dev-stub → an
// \`x-loom-dev-claims\` header carrying DEV_CLAIMS_UNAUTHORIZED; OIDC → a second
// mock-issuer token.  \`authorized\` is whatever the tier itself just used, read
// off the recorder — so it cannot drift from the credential the suite passed.
//
// An arm whose expected status is \`null\` is SKIPPED and reported as skipped, not
// silently passed: under the dev stub there is no anonymous caller to express
// (the emitted verifier accepts every request and falls back to its built-in
// identity), so that rung is unavailable rather than green.
const __authzLadder = async (spec, creds) => {
  if (!spec || !__rawDispatch) return [];
  const first = __urls.map((u) => { try { return new URL(u); } catch { return null; } }).find(Boolean);
  if (!first) return [];
  const origin = first.origin;
  const dispatch = __rawDispatch;
  const json = (h) => ({ ...h, "content-type": "application/json" });
  const out = [];
  const push = (name, status, error) => out.push({ tier: "authz", name, status, error });

  // Seed with the AUTHORIZED principal so the gated surface addresses a real
  // row.  Several backends load the aggregate BEFORE evaluating the guard, so a
  // made-up id would answer 404 and the ladder would measure not-found instead
  // of denial.
  const seeded = await dispatch({
    method: "POST",
    url: origin + spec.seed.path,
    headers: json(creds.authorized),
    body: JSON.stringify(spec.seed.body ?? {}),
  });
  let id = null;
  try {
    id = JSON.parse(seeded?.response?.body ?? "{}")?.id ?? null;
  } catch { /* handled by the null check below */ }
  if (!id) {
    push("authz ladder: seed", "fail", \`seed POST \${spec.seed.path} → \${seeded?.response?.status}: no id in body\`);
    return out;
  }

  const arm = async (label, headers, expected) => {
    if (expected === null || expected === undefined) {
      push(\`authz ladder: \${label} (skipped — \${spec.anonymousNote ?? "not expressible"})\`, "skip");
      return;
    }
    const r = await dispatch({
      method: spec.gated.method,
      url: origin + spec.gated.path.replace("{id}", id),
      headers: json(headers),
      body: JSON.stringify(spec.gated.body ?? {}),
    });
    const got = r?.response?.status;
    push(
      \`authz ladder: \${label} → \${expected}\`,
      got === expected ? "pass" : "fail",
      got === expected ? undefined : \`expected \${expected}, got \${got}: \${String(r?.response?.body ?? "").slice(0, 200)}\`,
    );
  };

  // Order matters: the two DENIED arms run first, so the surface is still in its
  // pre-operation state when they run and a 403 cannot be an artefact of the
  // operation having already been applied.  The authorized arm mutates, so it
  // goes last.
  await arm("unauthenticated", {}, spec.arms.anonymous);
  await arm("authenticated-but-unauthorized", creds.unauthorized, spec.arms.unauthorized);
  await arm("authorized", creds.authorized, spec.arms.authorized);
  return out;
};`;
}
