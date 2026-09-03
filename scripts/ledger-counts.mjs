// Make the gap-ledger's counts CODE, not prose (experience_gathered.md §91: "a
// count in prose is a cache with no invalidation").
//
// `docs/audits/targets-completeness-2026-08-30.ledger.json` is the source of
// truth for the ledger's `open`/`done`/`claimed`/`checkedOk`/`conflicts`
// buckets. Its companion `.md` carries two regions that are pure projections
// of that JSON and must never be hand-edited out of sync with it:
//
//   - the "## Counts" table (recomputed from the JSON's buckets)
//   - the "## Open ledger" table (one row per entry in the `open` bucket, in
//     the JSON array's own order)
//
// Usage:
//   node scripts/ledger-counts.mjs            print both regenerated regions
//   node scripts/ledger-counts.mjs --check     exit 1 if the .md's regions
//                                              differ from what this script
//                                              would generate from the JSON
//   node scripts/ledger-counts.mjs --write     rewrite the .md's two regions
//                                              in place
//
// Run `--check` in CI (test/system/ledger-counts.test.ts) so a future PR that
// moves a row between buckets without regenerating the `.md` fails the gate
// instead of shipping a stale table.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
export const LEDGER_JSON = path.join(
  ROOT,
  "docs/audits/targets-completeness-2026-08-30.ledger.json",
);
export const LEDGER_MD = path.join(ROOT, "docs/audits/targets-completeness-2026-08-30.md");

/** Load and parse the ledger JSON. */
export function loadLedger(jsonPath = LEDGER_JSON) {
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

/** Recompute the `counts` object from the live buckets — never trust a
 *  stored `counts` field, so a caller cannot "forget" to recount. */
export function computeCounts(ledger) {
  const open = ledger.open ?? [];
  const byPriority = {};
  for (let p = 0; p <= 5; p++) byPriority[`P${p}`] = open.filter((r) => r.P === p).length;

  const tally = (field) => {
    const out = {};
    for (const r of open) {
      const v = r[field];
      if (v == null) continue;
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };

  const byClass = {};
  for (const r of open) {
    const key = r.class == null ? "null" : r.class;
    byClass[key] = (byClass[key] ?? 0) + 1;
  }

  const fleetBucket = (sources) => {
    const fleets = new Set();
    for (const s of sources ?? []) {
      if (typeof s === "string" && s.startsWith("fleet1")) fleets.add(1);
      else if (typeof s === "string" && s.startsWith("fleet2")) fleets.add(2);
    }
    if (fleets.size === 1 && fleets.has(1)) return "fleet1only";
    if (fleets.size === 1 && fleets.has(2)) return "fleet2only";
    if (fleets.size === 2) return "both";
    return "unknown";
  };
  const bySourceFleet = {};
  for (const r of open) {
    const b = fleetBucket(r.sources);
    bySourceFleet[b] = (bySourceFleet[b] ?? 0) + 1;
  }

  return {
    open: open.length,
    byPriority,
    byKind: tally("kind"),
    byConfidence: tally("confidence"),
    byClass,
    bySize: tally("size"),
    bySourceFleet,
    claimed: (ledger.claimed ?? []).length,
    done: (ledger.done ?? []).length,
    conflicts: (ledger.conflicts ?? []).length,
    checkedOk: (ledger.checkedOk ?? []).length,
    // Static properties of the original wave plan, not the live open bucket.
    waveRows: ledger.counts?.waveRows,
    packets: ledger.counts?.packets,
  };
}

function fmtKindRow(counts) {
  const k = counts.byKind;
  return `${k.silent ?? 0} / ${k.honest ?? 0} / ${k.breadth ?? 0} / ${k.mission ?? 0} / ${k["stale-prose"] ?? 0}`;
}
function fmtConfRow(counts) {
  const c = counts.byConfidence;
  return `${c.proven ?? 0} / ${c.likely ?? 0} / ${c.suspected ?? 0}`;
}
function fmtSizeRow(counts) {
  const s = counts.bySize;
  return `${s.S ?? 0} / ${s.M ?? 0} / ${s.L ?? 0}`;
}
function fmtFleetRow(counts) {
  const f = counts.bySourceFleet;
  return `${f.fleet1only ?? 0} / ${f.fleet2only ?? 0} / ${f.both ?? 0}`;
}
function fmtClassRow(counts) {
  const c = counts.byClass;
  return `${c["faulty-fix"] ?? 0} / ${c.regression ?? 0}`;
}

/** Render the "## Counts" table body (header + separator + data rows), no
 *  leading "## Counts" heading — the caller splices it into the doc. */
export function renderCountsTable(ledger) {
  const counts = computeCounts(ledger);
  const rows = [
    ["open rows", `**${counts.open}**`],
    ["P0", String(counts.byPriority.P0 ?? 0)],
    ["P1", String(counts.byPriority.P1 ?? 0)],
    ["P2", String(counts.byPriority.P2 ?? 0)],
    ["P3", String(counts.byPriority.P3 ?? 0)],
    ["P4", String(counts.byPriority.P4 ?? 0)],
    ["P5", String(counts.byPriority.P5 ?? 0)],
    ["kind: silent / honest / breadth / mission / stale-prose", fmtKindRow(counts)],
    ["confidence: proven / likely / suspected", fmtConfRow(counts)],
    ["class: faulty-fix / regression", fmtClassRow(counts)],
    ["size S / M / L", fmtSizeRow(counts)],
    ["provenance: fleet1-only / fleet2-only / corroborated by both", fmtFleetRow(counts)],
    ["claimed by an open PR", String(counts.claimed)],
    ["done / merged", String(counts.done)],
    ["conflicts", String(counts.conflicts)],
    ["checkedOk entries", String(counts.checkedOk)],
    ["rows scheduled into waves", `${counts.waveRows ?? 0} across ${counts.packets ?? 0} packets`],
  ];
  const lines = ["| metric | value |", "|---|---|"];
  for (const [metric, value] of rows) lines.push(`| ${metric} | ${value} |`);
  return lines.join("\n");
}

const CONF_ABBR = { proven: "prov", likely: "like", suspected: "susp" };

function targetsCell(targets) {
  return (targets ?? []).join(", ");
}

function kindClassCell(row) {
  return row.class ? `${row.kind}/${row.class}` : row.kind;
}

/** Render the "## Open ledger" table (header + separator + one row per
 *  `open` entry, in the JSON array's own order — the array order already
 *  carries the P0→P5 / security-first curation, so this does not re-sort). */
export function renderOpenLedgerTable(ledger) {
  const lines = [
    "| P | id | kind/class | conf | targets | size | title |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of ledger.open ?? []) {
    const pCell = `P${r.P}${r.securityClass ? " !" : ""}`;
    const conf = CONF_ABBR[r.confidence] ?? r.confidence ?? "";
    lines.push(
      `| ${pCell} | \`${r.id}\` | ${kindClassCell(r)} | ${conf} | ${targetsCell(r.targets)} | ${r.size ?? ""} | ${r.title ?? ""} |`,
    );
  }
  return lines.join("\n");
}

/** Splice `newBody` in place of the table that currently follows `heading`
 *  in `md` (from the header line through the blank line before the next
 *  "## " heading or EOF). Returns the updated document text. */
function replaceTableUnderHeading(md, heading, newBody) {
  const headingIdx = md.indexOf(`## ${heading}`);
  if (headingIdx === -1) throw new Error(`heading not found: ## ${heading}`);
  const afterHeading = md.indexOf("\n", headingIdx) + 1;
  // The table itself starts at the first line beginning with "| " after the
  // heading (skipping any prose paragraphs in between, which stay put).
  const rest = md.slice(afterHeading);
  const tableStartRel = rest.search(/^\|/m);
  if (tableStartRel === -1) throw new Error(`no table found under ## ${heading}`);
  const tableStart = afterHeading + tableStartRel;
  // The table ends at the next blank-line-then-"## " boundary, or EOF.
  const nextHeadingRel = md.slice(tableStart).search(/\n## /);
  const tableEnd = nextHeadingRel === -1 ? md.length : tableStart + nextHeadingRel;
  const before = md.slice(0, tableStart);
  const after = md.slice(tableEnd);
  // Normalize to exactly one blank line between the table and whatever
  // follows (a "## " heading, or EOF) — the doc's convention throughout.
  const afterTrimmed = after.replace(/^\n+/, "");
  const sep = afterTrimmed.length > 0 ? "\n\n" : "\n";
  return `${before}${newBody}${sep}${afterTrimmed}`;
}

export function regenerateMd(ledger, md) {
  let out = replaceTableUnderHeading(md, "Counts", renderCountsTable(ledger));
  out = replaceTableUnderHeading(out, "Open ledger", renderOpenLedgerTable(ledger));
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const write = args.includes("--write");

  const ledger = loadLedger();
  const currentMd = fs.readFileSync(LEDGER_MD, "utf8");
  const regenerated = regenerateMd(ledger, currentMd);

  if (check) {
    if (regenerated !== currentMd) {
      console.error(
        "ledger-counts --check: docs/audits/targets-completeness-2026-08-30.md is stale " +
          "relative to the ledger JSON. Run `node scripts/ledger-counts.mjs --write` and commit the result.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("ledger-counts --check: .md matches the JSON.");
    return;
  }

  if (write) {
    fs.writeFileSync(LEDGER_MD, regenerated);
    console.log(`ledger-counts --write: updated ${path.relative(ROOT, LEDGER_MD)}`);
    return;
  }

  console.log("## Counts\n");
  console.log(renderCountsTable(ledger));
  console.log("\n## Open ledger (table only)\n");
  console.log(renderOpenLedgerTable(ledger));
}

// Only run as a CLI when invoked directly (not when imported by the test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
