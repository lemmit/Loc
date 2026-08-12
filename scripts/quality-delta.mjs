// The weekly quality delta — M-T9.31 lane 1 (quality-audit-2026-08 §6 R11/R12).
//
// §3 of that audit ("how the bugs are actually found") is the most important
// table in it and the most expensive: it took an afternoon of reading 235
// commit bodies by hand, which means it is a SNAPSHOT nobody will redo, which
// means the ratio it measures — discovery-by-audit vs discovery-by-gate —
// cannot be watched moving.  A number reconstructed by hand once a quarter is
// an anecdote; the same number appended weekly is a series.
//
// So this script recomputes, mechanically and cheaply, the parts of that audit
// that ARE mechanical:
//
//   * REGISTER COUNTS, read from the repo at HEAD — wire waivers, the
//     unsupported-register open gaps, the HEEx parity pins, the corpus
//     COMPILE_SKIP maps.  Every one of these is a ratcheting list the repo
//     already keeps honest (a stale entry fails its gate); counting them turns
//     four ratchets into four trend lines.
//   * MERGE STATS from `git log` over the trailing window — how much landed,
//     what share of it was fix-shaped, and — where the commit says so — whether
//     the fix was born from a GATE going red or from an episodic AUDIT.
//   * R12 DUPLICATE-CLAIM HYGIENE — open PRs sharing a head branch (#2349/#2351
//     were the same branch open twice), and drafts sitting on an unmoved head.
//   * MAIN-PUSH GATE FAILURES in the window, from the Actions API — the
//     red-time signal `ci-red-alarm` alarms on one at a time but never totals.
//
// WHAT IT DELIBERATELY DOES NOT DO.  It does not judge.  The discovery split is
// reported over ATTRIBUTED fixes only, with the unattributed count printed
// beside it, because a classifier that silently buckets what it cannot read
// would reproduce exactly the failure the audit warns about (§4.2 — a green
// number is evidence of stability, not correctness).  A subject that names no
// mechanism is counted as unattributed, never as "gate" by default.  And it
// never closes anyone's PR: R12 findings are FLAGGED for a human.
//
// The classification core (`isFixShaped`, `discoverySource`, `summarize`) is
// pure and pinned by test/system/quality-delta.test.ts against a fixture of
// real merge subjects from this repo.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

/** The trailing window each run reports on. */
const WINDOW_DAYS = 7;
/** A draft whose head commit has not moved in this long is a parked claim. */
const STALE_DRAFT_DAYS = 10;

// ---------------------------------------------------------------------------
// Classification — the pure core.
// ---------------------------------------------------------------------------

/** A landed merge, by this repo's squash-merge convention: the PR number is
 *  appended to the subject.  Plain pushes to main (rare) are not merges. */
export function isMerge(subject) {
  return /\(#\d+\)\s*$/.test(subject);
}

/** Markers that make a subject fix-shaped.
 *
 *  Two families, and the second is the load-bearing one.  `fix(` is the
 *  conventional-commit prefix, but this repo overwhelmingly writes a NARRATIVE
 *  subject instead — "A wrong verb answers 404 on node/elixir", "`policy
 *  { deny }` crashed codegen on `persistence: dapper`", "the cron sweep was
 *  cancelling itself".  Counting only `fix(` would have scored the 08-02
 *  window at a few percent against a hand count of 235/988.
 *
 *  Stems, not words: `silent` catches "silently", `leak` catches "leaks",
 *  `crash` catches "crashed".  Kept as an exported constant because the list
 *  is a REVIEWED judgement about this repo's idiom, not a general classifier —
 *  every entry earns its place by appearing in real fix subjects. */
export const FIX_MARKERS = [
  "fix(",
  "red on",
  "silent",
  "vacuous",
  "bypass",
  "leak",
  "crash",
  "wrong",
  // Same family, same evidence base: each of these is the subject line of a
  // real recorded bug fix on this repo's main.
  "instead of",
  "regress",
  "flake",
  "flaky",
  "broke",
  "broken",
];

/**
 * Markers naming a GATE as the discovering mechanism.
 *
 * Every entry is a phrase that only appears when a gate **FIRED** — never a
 * phrase that merely names a gate.  That restriction is the whole design, and
 * it is deliberately biased:
 *
 * The obvious list ("corpus", "behavioral", "e2e", "conformance") is WRONG
 * here, because in this repo those words appear far more often in subjects
 * that BUILD a gate ("the e2e-less corpus fixtures get runtime callers", "one
 * shared harness, both packs") than in subjects where one caught something.
 * Building a gate is what an AUDIT does with its findings — so the broad list
 * would score audit-born work as gate-born, and the metric this whole script
 * exists to watch is precisely "gate share vs audit share".  A classifier that
 * inflates the numerator of its own success metric is worthless.
 *
 * The bias therefore runs one way on purpose: gate attribution UNDER-counts.
 * A fix a gate really caught, described without saying so, lands in
 * `unattributed` — visible, and never silently credited.  When the crossover
 * this script watches for finally happens, it will have happened for real.
 */
export const GATE_MARKERS = [
  // A gate went red.
  "red on",
  "went red",
  "was red",
  "is red",
  "still red",
  "main-red",
  "ci-red",
  "startup_failure",
  "never green",
  "failed on main",
  "fails on main",
  "failing on main",
  "broke main",
  "broke the build",
  "the leg failed",
  // A compiler refused — the per-backend build gates speaking.
  "warnaserror",
  "does not compile",
  "did not compile",
  "never compiled",
  "would not compile",
  "uncompilable",
  // A gate caught it intermittently.
  "flake",
  "flaky",
  "intermittent",
];

/** Markers naming an EPISODIC AUDIT as the discovering mechanism — a human (or
 *  agent) deliberately went looking.  The audit's ~58% bucket.
 *
 *  Same restraint as above in the other direction: "found" alone is too broad
 *  ("found and fixed" describes any fix), so the possessive phrases that name
 *  a DISCOVERING EXERCISE are spelled out instead. */
export const AUDIT_MARKERS = [
  // `audit` — but NOT `audited` / `auditable`, which are the names of a Loom
  // CAPABILITY and appear all over this repo's subjects ("`mask unless` +
  // `audited` did not compile").  A domain word that happens to spell a
  // methodology word is the single most common false positive here, and it is
  // systematic: left unqualified it would quietly credit every audit-capability
  // fix to the audit bucket, permanently depressing the ratio being watched.
  /\baudit(?!ed\b|able\b)/,
  "review",
  "census",
  // `sweep` is deliberately ABSENT.  In this repo it is at least as often a
  // component ("pr-gate: the cron sweep was cancelling itself") as a
  // methodology ("hollow-work sweep), and an ambiguous marker on the bucket
  // the gate share must OVERTAKE is worse than a missing one.
  "bug-hunt",
  "bug hunt",
  "probe",
  "survey",
  "hunt",
  "retro(",
  "it found",
  "they found",
  "the bugs",
  "bugs it",
  "bugs they",
  "coverage exercise",
  "showcase",
  "fleet",
  "hollow-work",
];

/** Markers may be plain substrings or regexes — a regex is how a marker
 *  expresses a boundary a substring cannot (see `audit` above).  Never use the
 *  `g` flag in one: `RegExp.test` with `g` is stateful and would match every
 *  other call. */
const hasAny = (haystack, markers) =>
  markers.some((m) => (typeof m === "string" ? haystack.includes(m) : m.test(haystack)));

/** Is this subject fix-shaped?  Subject only — the body is prose about the fix
 *  and would match almost anything. */
export function isFixShaped(subject) {
  return hasAny(subject.toLowerCase(), FIX_MARKERS);
}

/**
 * Where did this fix come from — a gate, or an audit?
 *
 * Reads the subject FIRST and the body only as a fallback, which matters:
 * the audit's own §3 method was "full commit bodies, which in this repo name
 * the discovering gate", and the bodies really are where "found by the corpus
 * leg" gets written down.  But a body also narrates the FIX, so a body-first
 * reader mistakes "adds a behavioral test" (prevention) for "found by the
 * behavioral leg" (discovery).  Subject wins; body breaks the tie only when
 * the subject is silent.
 *
 * Returns "gate" | "audit" | "unattributed".  When one text names BOTH — "the
 * corpus fixture the audit minted" — the AUDIT wins, because the audit is what
 * caused the gate to exist and to run: attributing it to the gate would let
 * every audit-minted gate inflate the very ratio being watched.
 */
export function discoverySource({ subject, body = "" }) {
  const s = subject.toLowerCase();
  const subjAudit = hasAny(s, AUDIT_MARKERS);
  const subjGate = hasAny(s, GATE_MARKERS);
  if (subjAudit) return "audit";
  if (subjGate) return "gate";

  const b = body.toLowerCase();
  if (hasAny(b, AUDIT_MARKERS)) return "audit";
  if (hasAny(b, GATE_MARKERS)) return "gate";
  return "unattributed";
}

/**
 * Roll a commit list up into the reported figures.
 *
 * `commits` is `{ subject, body }[]`.  Shares are integers-as-percent, and the
 * discovery shares are computed over ATTRIBUTED fixes only — see the header:
 * dividing by all fixes would let an unreadable subject drag both numbers
 * down and make the R11 crossover look further away than it is, while
 * bucketing the unreadable ones would make it look closer.  Both denominators
 * are printed, so neither reading is hidden.
 */
export function summarize(commits) {
  const merges = commits.filter((c) => isMerge(c.subject));
  const fixes = merges.filter((c) => isFixShaped(c.subject));
  const bySource = { gate: 0, audit: 0, unattributed: 0 };
  for (const c of fixes) bySource[discoverySource(c)] += 1;
  const attributed = bySource.gate + bySource.audit;
  const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 100));
  return {
    commits: commits.length,
    merges: merges.length,
    fixes: fixes.length,
    fixShare: pct(fixes.length, merges.length),
    gate: bySource.gate,
    audit: bySource.audit,
    unattributed: bySource.unattributed,
    attributed,
    gateShare: pct(bySource.gate, attributed),
    auditShare: pct(bySource.audit, attributed),
  };
}

// ---------------------------------------------------------------------------
// R12 — duplicate-claim hygiene.  Pure over a PR list.
// ---------------------------------------------------------------------------

/** Open PRs sharing one head branch — #2349/#2351 were the same branch open
 *  twice (a draft and a ready), and each burned a full CI fan-out. */
export function duplicateHeads(prs) {
  const byRef = new Map();
  for (const pr of prs) {
    const list = byRef.get(pr.headRef) ?? [];
    list.push(pr);
    byRef.set(pr.headRef, list);
  }
  return [...byRef.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([headRef, list]) => ({ headRef, prs: list.sort((a, b) => a.number - b.number) }))
    .sort((a, b) => a.headRef.localeCompare(b.headRef));
}

/** Drafts whose HEAD COMMIT has not moved in `days` — an abandoned claim.
 *
 *  Deliberately keyed on the head commit's date, not the PR's `updated_at`: a
 *  bot comment, a label, or a base-branch retarget all bump `updated_at`
 *  without a single new commit, so `updated_at` would quietly clear a draft
 *  that has in fact been parked for a fortnight.  A claim is stale when the
 *  WORK stopped. */
export function staleDrafts(prs, { now, days }) {
  const cutoff = now - days * 86_400_000;
  return prs
    .filter((pr) => pr.draft && Date.parse(pr.headCommittedAt) < cutoff)
    .map((pr) => ({
      ...pr,
      idleDays: Math.floor((now - Date.parse(pr.headCommittedAt)) / 86_400_000),
    }))
    .sort((a, b) => b.idleDays - a.idleDays);
}

// ---------------------------------------------------------------------------
// Register counts — read from the repo at HEAD.
//
// Read as TEXT, not by importing the modules.  Two of the four sources live
// under `test/` and one is a `.test.ts` file; importing them would need the
// TypeScript build (and, for the parity pin, would drag in the whole walker
// registry) just to count rows.  The files are hand-maintained literal arrays
// with a house style the repo's own gates keep stable, so a line reader is
// enough — and every counter below asserts it found a plausible population, so
// a reformat that breaks the reader FAILS LOUDLY instead of silently reporting
// a comforting zero.  (A metric that reads 0 because its parser broke is the
// exact "green number, blind instrument" failure §4.3 of the audit describes.)
// ---------------------------------------------------------------------------

const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

/** The slice of `src` from the line opening `marker` to the line closing the
 *  literal at column 0 (`];` or `};`).
 *
 *  The DRAINED state is a same-line empty literal — `= {};`, which four of the
 *  six corpus skip maps are in today — and that has no closing line to find.
 *  Distinguishing "drained" from "reader broke" is the whole job here, so the
 *  empty case is matched explicitly and returns an empty block; only a marker
 *  that is genuinely absent returns `undefined` (and every caller throws on
 *  that, rather than reporting a comforting zero). */
function literalBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return undefined;
  const rest = src.slice(start);
  const firstLine = rest.slice(0, rest.indexOf("\n") === -1 ? undefined : rest.indexOf("\n"));
  if (/[[{]\s*[\]}]\s*;/.test(firstLine)) return "";
  const end = rest.search(/^[\]}];/m);
  return end === -1 ? undefined : rest.slice(0, end);
}

/** Entries in the wire-differential waiver registry.  Each waiver carries
 *  exactly one `reason:` (the field `wire-record.test.ts` requires), so the
 *  reason count IS the waiver count. */
export function countWireWaivers(src) {
  const block = literalBlock(src, "export const WIRE_WAIVERS");
  if (block === undefined) throw new Error("wire-waivers.ts: WIRE_WAIVERS array not found");
  return (block.match(/^ {4}reason:/gm) ?? []).length;
}

/** Open `gap` rows in the unsupported register — the parity sprint backlog
 *  (`openGaps()`).  `scope` rows are permanent-by-design and not debt. */
export function countOpenGaps(src) {
  const block = literalBlock(src, "export const UNSUPPORTED_REGISTER");
  if (block === undefined)
    throw new Error("unsupported-register.ts: UNSUPPORTED_REGISTER array not found");
  const rows = (block.match(/^ {4}code:/gm) ?? []).length;
  if (rows === 0) throw new Error("unsupported-register.ts: no rows read — the format moved");
  return {
    gaps: (block.match(/^ {4}kind: "gap",$/gm) ?? []).length,
    scope: (block.match(/^ {4}kind: "scope",$/gm) ?? []).length,
    rows,
  };
}

/** Keys of an object literal, one per line at two-space indent, skipping the
 *  comment lines these hand-maintained maps are mostly made of. */
function objectKeys(block) {
  return [...block.matchAll(/^ {2}(?:"([^"]+)"|([A-Za-z_$][\w$]*)):/gm)].map((m) => m[1] ?? m[2]);
}

/** Primitives the TSX walker renders that HEEx does not — the frozen parity
 *  gap.  Each is a reviewed decision; the list is meant to shrink. */
export function countHeexPins(src) {
  const block = literalBlock(src, "const KNOWN_HEEX_GAPS");
  if (block === undefined) throw new Error("heex-parity.test.ts: KNOWN_HEEX_GAPS not found");
  return objectKeys(block);
}

/** Corpus features a backend's compile tier skips, per backend.  All five were
 *  drained to empty by 08-02; a non-zero entry here is new compile-tier debt. */
export function countCompileSkips(files) {
  const out = {};
  for (const [backend, src] of Object.entries(files)) {
    const block = literalBlock(src, "COMPILE_SKIP: Record<string, string> = {");
    if (block === undefined) throw new Error(`${backend}: COMPILE_SKIP map not found`);
    out[backend] = objectKeys(block);
  }
  return out;
}

const CORPUS_SKIP_FILES = {
  node: "test/e2e/corpus-tsc-build.test.ts",
  dotnet: "test/e2e/corpus-dotnet-build.test.ts",
  dapper: "test/e2e/corpus-dotnet-dapper-build.test.ts",
  java: "test/e2e/corpus-java-build.test.ts",
  python: "test/e2e/corpus-python-build.test.ts",
  elixir: "test/e2e/corpus-elixir-build.test.ts",
};

/** Every register count, read off the working tree. */
export function readRegisters() {
  const skipSrc = Object.fromEntries(
    Object.entries(CORPUS_SKIP_FILES).map(([k, rel]) => [k, read(rel)]),
  );
  return {
    wireWaivers: countWireWaivers(read("test/_helpers/wire-waivers.ts")),
    register: countOpenGaps(read("src/diagnostics/unsupported-register.ts")),
    heexPins: countHeexPins(read("test/generator/elixir/heex-parity.test.ts")),
    compileSkips: countCompileSkips(skipSrc),
  };
}

// ---------------------------------------------------------------------------
// Git — the trailing window.
// ---------------------------------------------------------------------------

const REC = "";
const FIELD = " ";

/** Parse `git log`'s NUL-delimited, RS-separated output.  Exported so the
 *  reader itself is testable — a silently-empty log would zero every merge
 *  figure while the report still rendered. */
export function parseLog(raw) {
  return raw
    .split(REC)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, body = ""] = rec.split(FIELD);
      return { sha, subject: subject ?? "", body };
    });
}

function gitLog(days) {
  // The separators go to git as its OWN `%xNN` escapes, not as literal bytes:
  // `execFile` rejects an argv entry containing a NUL, so interpolating FIELD
  // here would throw before git ever ran.  git expands `%x00`/`%x1e` itself,
  // and the OUTPUT carries the real bytes `parseLog` splits on.
  const raw = execFileSync(
    "git",
    ["log", "--first-parent", `--since=${days} days ago`, "--format=%H%x00%s%x00%b%x1e"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseLog(raw);
}

// ---------------------------------------------------------------------------
// GitHub API.
// ---------------------------------------------------------------------------

const API_HEADERS = (token) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
});

async function api(url, token) {
  const res = await fetch(url, { headers: API_HEADERS(token) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${url}: ${await res.text()}`);
  return res.json();
}

/** Open PRs, each with its head commit's date — the input `staleDrafts` needs.
 *  One extra call per DRAFT only (ready PRs never go stale by this rule), so
 *  the cost stays proportional to the thing being measured. */
async function fetchOpenPrs(repo, token) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`,
      token,
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  const prs = [];
  for (const pr of out) {
    let headCommittedAt = pr.updated_at;
    if (pr.draft) {
      try {
        const commit = await api(
          `https://api.github.com/repos/${repo}/commits/${pr.head.sha}`,
          token,
        );
        headCommittedAt = commit.commit?.committer?.date ?? pr.updated_at;
      } catch {
        // A head SHA can be gone (force-push, deleted fork).  Fall back to
        // `updated_at` rather than dropping the PR from the R12 sweep.
      }
    }
    prs.push({
      number: pr.number,
      title: pr.title,
      draft: pr.draft,
      headRef: pr.head.ref,
      createdAt: pr.created_at,
      headCommittedAt,
    });
  }
  return prs;
}

/** How many pages of run history one call will walk before giving up and
 *  SAYING SO.  Sized for the failure query (few per week); a run of bad luck
 *  that exceeds it is reported as truncated, never rounded down silently. */
const MAX_RUN_PAGES = 40;

/**
 * `push: main` workflow-run FAILURES in the window, with the gates that failed.
 *
 * Deliberately not a rate.  The obvious shape — "N failed of M runs (P%)" —
 * cannot be computed honestly at this repo's volume: ~29 merges/day × ~60
 * workflows is a five-figure weekly run count, so any capped pagination gives a
 * DENOMINATOR that is really "as far as I got", and dividing by it produces a
 * confident percentage that is simply false.  (Measured while building this: a
 * single 30-run page spanned six minutes.)  A count of failures plus the gates
 * that produced them is the signal `ci-red-alarm` never aggregates, and it is
 * exactly computable — so that is what gets reported.
 *
 * Exact because the API returns runs newest-first: the walk stops at the first
 * page that falls entirely outside the window, rather than trusting a cap.
 * `status=failure` narrows server-side where supported; the client-side
 * `conclusion` filter means the result is correct even where it is not, just
 * slower — and a walk that runs out of pages sets `truncated`.
 */
async function fetchMainRuns(repo, token, sinceIso) {
  const since = Date.parse(sinceIso);
  const failed = [];
  let truncated = true;
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const body = await api(
      `https://api.github.com/repos/${repo}/actions/runs?branch=main&event=push&status=failure` +
        `&per_page=100&page=${page}`,
      token,
    );
    const batch = body.workflow_runs ?? [];
    failed.push(
      ...batch.filter((r) => r.conclusion === "failure" && Date.parse(r.created_at) >= since),
    );
    // Newest-first ordering: once a whole page predates the window, everything
    // after it does too.
    const exhausted = batch.length < 100;
    const pastWindow = batch.length > 0 && Date.parse(batch[batch.length - 1].created_at) < since;
    if (exhausted || pastWindow) {
      truncated = false;
      break;
    }
  }
  const byWorkflow = new Map();
  for (const r of failed) byWorkflow.set(r.name, (byWorkflow.get(r.name) ?? 0) + 1);
  return {
    failed: failed.length,
    shas: new Set(failed.map((r) => r.head_sha)).size,
    truncated,
    byWorkflow: [...byWorkflow.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

/** The 2026-08-02 audit's hand-reconstructed figures — the fixed reference
 *  every run is read against, so a single comment is interpretable without
 *  scrolling the issue.  These are HISTORY: do not "refresh" them, or the
 *  series loses its origin. */
export const BASELINE = {
  date: "2026-08-02",
  wireWaivers: 2,
  heexPins: 1,
  compileSkips: 0,
  gateShare: 16, // per-PR compile + behavioral/e2e gates, §3
  auditShare: 58, // deliberate audit / coverage exercise, §3
};

const arrow = (now, was, goodDown = true) => {
  if (now === was) return "→ flat";
  const better = goodDown ? now < was : now > was;
  return `${now > was ? "↑" : "↓"} ${now > was ? "+" : ""}${now - was} ${better ? "✅" : "⚠️"}`;
};

/** The markdown comment for one run.  Pure — takes everything it prints. */
export function renderReport({ now, days, registers, stats, prs, runs, sha }) {
  const end = new Date(now);
  const start = new Date(now - days * 86_400_000);
  const day = (d) => d.toISOString().slice(0, 10);
  const skipTotal = Object.values(registers.compileSkips).reduce((n, l) => n + l.length, 0);
  const dupes = duplicateHeads(prs);
  const stale = staleDrafts(prs, { now, days: STALE_DRAFT_DAYS });

  const lines = [];
  lines.push(`## Quality delta — ${day(end)}`);
  lines.push("");
  lines.push(
    `Window: \`${day(start)}\` → \`${day(end)}\` (${days}d) · registers read at \`${sha.slice(0, 8)}\`` +
      ` · baseline = the ${BASELINE.date} audit.`,
  );
  lines.push("");

  lines.push("### Ratchets (lower is better; each is a list that fails its gate when stale)");
  lines.push("");
  lines.push("| register | now | baseline | Δ |");
  lines.push("|---|---:|---:|---|");
  lines.push(
    `| wire-golden waivers | ${registers.wireWaivers} | ${BASELINE.wireWaivers} | ${arrow(registers.wireWaivers, BASELINE.wireWaivers)} |`,
  );
  lines.push(
    `| unsupported-register open gaps | ${registers.register.gaps} | — | ${registers.register.scope} \`scope\` rows (by design) |`,
  );
  lines.push(
    `| HEEx parity pins | ${registers.heexPins.length} | ${BASELINE.heexPins} | ${arrow(registers.heexPins.length, BASELINE.heexPins)} |`,
  );
  lines.push(
    `| corpus COMPILE_SKIP (all backends) | ${skipTotal} | ${BASELINE.compileSkips} | ${arrow(skipTotal, BASELINE.compileSkips)} |`,
  );
  lines.push("");
  if (skipTotal > 0) {
    for (const [backend, ids] of Object.entries(registers.compileSkips)) {
      if (ids.length)
        lines.push(`- \`${backend}\` skips: ${ids.map((i) => `\`${i}\``).join(", ")}`);
    }
    lines.push("");
  }
  if (registers.heexPins.length) {
    lines.push(`- HEEx pins: ${registers.heexPins.map((p) => `\`${p}\``).join(", ")}`);
    lines.push("");
  }

  lines.push("### Landed work");
  lines.push("");
  lines.push("| metric | value |");
  lines.push("|---|---:|");
  lines.push(`| merges | ${stats.merges} |`);
  lines.push(`| fix-shaped merges | ${stats.fixes} (${stats.fixShare}%) |`);
  lines.push("");

  lines.push("### R11 — discovery vs prevention (the pinned success metric)");
  lines.push("");
  lines.push("| discovered by | fixes | share of attributed |");
  lines.push("|---|---:|---:|");
  lines.push(`| **gate** (a check went red) | ${stats.gate} | ${stats.gateShare}% |`);
  lines.push(`| **audit** (someone went looking) | ${stats.audit} | ${stats.auditShare}% |`);
  lines.push(`| unattributed | ${stats.unattributed} | — |`);
  lines.push("");
  lines.push(
    `Baseline: gate ${BASELINE.gateShare}% · audit ${BASELINE.auditShare}%. ` +
      `**Target: gate share overtakes audit share.** ` +
      (stats.attributed === 0
        ? "No attributed fixes this window — no verdict."
        : stats.gateShare > stats.auditShare
          ? "✅ **Met this window.**"
          : stats.gateShare === stats.auditShare
            ? "➖ Level — overtaking needs a strict lead, so not met."
            : `❌ Not yet — gate trails by ${stats.auditShare - stats.gateShare}pp.`),
  );
  lines.push("");
  lines.push(
    `<sub>Shares are over the ${stats.attributed} fixes whose subject or body names a mechanism; ` +
      `${stats.unattributed} named none and are counted nowhere. **Gate attribution deliberately ` +
      `under-counts** — only phrases meaning a gate FIRED count, never phrases that merely name a ` +
      `gate, since those overwhelmingly appear in audit-born work that BUILDS one. So the crossover ` +
      `this table watches for is harder to reach than it looks, on purpose. Classifier: ` +
      `\`scripts/quality-delta.mjs\`, pinned by \`test/system/quality-delta.test.ts\`.</sub>`,
  );
  lines.push("");

  lines.push("### Main-push gate failures");
  lines.push("");
  if (runs === undefined) {
    lines.push("_Actions API not queried (no token)._");
  } else {
    lines.push(
      `**${runs.failed}** \`push: main\` run(s) concluded \`failure\`, across **${runs.shas}** ` +
        `merged commit(s).` +
        (runs.truncated ? " ⚠️ _Page cap reached — this is a LOWER BOUND._" : ""),
    );
    if (runs.byWorkflow.length) {
      lines.push("");
      for (const [name, n] of runs.byWorkflow.slice(0, 15)) lines.push(`- ${name} — ${n}×`);
    }
    lines.push("");
    lines.push(
      "<sub>A count, not a rate: at ~29 merges/day × ~60 workflows the denominator cannot be " +
        "paged honestly, and a percentage over a partial denominator would be a false number.</sub>",
    );
  }
  lines.push("");

  lines.push("### R12 — claim hygiene");
  lines.push("");
  if (dupes.length === 0 && stale.length === 0) {
    lines.push(`No duplicate heads; no drafts idle >${STALE_DRAFT_DAYS}d. ✅`);
  }
  if (dupes.length) {
    lines.push(`**⚠️ ${dupes.length} head branch(es) with more than one open PR:**`);
    lines.push("");
    for (const d of dupes) {
      lines.push(`- \`${d.headRef}\` — ${d.prs.map((p) => `#${p.number}`).join(", ")}`);
    }
    lines.push("");
  }
  if (stale.length) {
    lines.push(
      `**⚠️ ${stale.length} draft(s) whose head commit has not moved in >${STALE_DRAFT_DAYS}d:**`,
    );
    lines.push("");
    for (const d of stale) lines.push(`- #${d.number} — ${d.idleDays}d idle — ${d.title}`);
    lines.push("");
  }
  lines.push("_Flagged only — nothing is closed automatically._");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Publish — one long-lived issue, deduped by label, exactly like ci-red-alarm.
// ---------------------------------------------------------------------------

const LABEL = "quality-delta";

async function publish(repo, token, body) {
  const open = await api(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=${LABEL}&per_page=1`,
    token,
  );
  const target = open.find((i) => !i.pull_request);
  const post = async (url, payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...API_HEADERS(token), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} posting: ${await res.text()}`);
    return res.json();
  };
  if (target) {
    await post(`https://api.github.com/repos/${repo}/issues/${target.number}/comments`, { body });
    return target.number;
  }
  const created = await post(`https://api.github.com/repos/${repo}/issues`, {
    title: "📈 Quality delta (weekly)",
    body:
      "The mechanical half of the 2026-08-02 quality audit, appended weekly by " +
      "`.github/workflows/quality-delta.yml` (M-T9.31 lane 1). Each comment is one " +
      "datapoint — the series is the point, so **leave this issue open**.\n\n" +
      body,
    labels: [LABEL],
  });
  return created.number;
}

// ---------------------------------------------------------------------------

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const dryRun = process.argv.includes("--dry-run") || !token;

  const now = Date.now();
  const registers = readRegisters();
  const stats = summarize(gitLog(WINDOW_DAYS));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  let prs = [];
  let runs;
  if (token && repo) {
    prs = await fetchOpenPrs(repo, token);
    runs = await fetchMainRuns(repo, token, new Date(now - WINDOW_DAYS * 86_400_000).toISOString());
  }

  const body = renderReport({ now, days: WINDOW_DAYS, registers, stats, prs, runs, sha });

  if (dryRun) {
    console.log(body);
    return;
  }
  const issue = await publish(repo, token, body);
  console.log(`quality-delta: appended to issue #${issue}`);
}

// Run only when invoked directly — importing this module (the unit test does)
// must never reach the network or the git log.  `pathToFileURL` rather than a
// hand-built `file://` string: the latter mis-encodes any path with a space.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
