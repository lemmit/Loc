// ---------------------------------------------------------------------------
// The GATE LEDGER — for every (corpus feature × backend) cell, the STRONGEST
// tier of gate that actually covers it.
//
// WHAT IT IS FOR.  The repo already keeps four honest registers — the corpus
// manifest (which cells must GENERATE), the per-leg compile skip maps (which
// cells must COMPILE), `BEHAVIOURAL_SKIP` + `hasBehaviouralBlock` (which cells
// BOOT), and the committed wire goldens (which booted cells are COMPARED
// against a reviewed answer key).  Each is enforced by its own gate.  Nothing
// joins them, so two questions have no answer anywhere in the tree:
//
//   1. Which cells are held up by GENERATION ALONE?  A cell that emits and is
//      never compiled or booted is the silent-gap surface — the class
//      `docs/audits/quality-audit-2026-08.md` §3 measures as found by episodic
//      audit (~58%) rather than by a gate.  Joining the registers turns that
//      sweep into a per-PR check.
//   2. Which cells are covered by something STRONGER than a string assertion?
//      That is the deletion authority for the string-tier drain
//      (`docs/audits/verification-architecture-2026-08-31.md` §2): a per-target
//      `toContain` test may be deleted when — and only when — its cell is named
//      here at `compile` or `behavioural`, because then a stronger gate already
//      watches the same cell.  Nothing is deleted on judgement.
//
// IT ADDS NO REGISTER OF ITS OWN.  Every fact below is READ from the register
// that already owns it; this module holds a join and no data.  That is
// deliberate: `docs/audits/gated-features-inventory.md` is the cautionary tale
// — a hand-maintained matrix of the same shape, now carrying three "Superseded"
// banners and still cited.  A derived ledger cannot rot, and it fails the day a
// register moves out from under it.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BEHAVIOURAL_SKIP, declaresE2e, hasBehaviouralBlock } from "../behavioral/registers.mjs";
import { BACKENDS, type Backend, PLATFORM_CLAUSE } from "../fixtures/corpus/backends.js";
import { corpusSource } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GOLDEN_DIR = join(REPO, "test", "behavioral", "wire-golden");

/** Gate strength, weakest first.  The ordering IS the semantics: a cell's
 *  `strongest` is the last tier in this list that covers it, and the drain rule
 *  reads "≥ compile" against these indices. */
export const TIERS = ["none", "generate", "compile", "behavioural"] as const;
export type Tier = (typeof TIERS)[number];

/** Where each backend's corpus COMPILE leg lives, and the skip map it filters
 *  by.  Keyed by the manifest's backend id.  A backend missing from here has no
 *  compile tier at all, which the gate reports rather than silently scoring its
 *  cells at `generate`.
 *
 *  The dapper leg is deliberately absent: it re-runs the `dotnet` cells under a
 *  second persistence adapter, so it can only ever be a SUPERSET constraint on
 *  a cell plain dotnet already compiles — it changes no cell's strongest tier.
 *  (Same reasoning as the dapper exclusion in `wire-golden-coverage.test.ts`.) */
export const COMPILE_LEGS: Record<Backend, { file: string; register: string }> = {
  node: { file: "test/e2e/corpus-tsc-build.test.ts", register: "TS_COMPILE_SKIP" },
  dotnet: { file: "test/e2e/corpus-dotnet-build.test.ts", register: "DOTNET_COMPILE_SKIP" },
  java: { file: "test/e2e/corpus-java-build.test.ts", register: "JAVA_COMPILE_SKIP" },
  python: { file: "test/e2e/corpus-python-build.test.ts", register: "PYTHON_COMPILE_SKIP" },
  vanilla: { file: "test/e2e/corpus-elixir-build.test.ts", register: "ELIXIR_COMPILE_SKIP" },
};

/**
 * The KEYS of a `const <name>: Record<string, string> = { … }` skip map, read
 * out of its own source file.
 *
 * Source-parsed rather than imported because these registers live inside
 * `*.test.ts` files that call `describe`/`it` at module scope — importing one
 * from the fast suite would register a second (opt-in, docker-shaped) suite as
 * a side effect.  `allowlist-ratchet.test.ts` reads the same constructs the
 * same way and for the same reason.
 *
 * Deliberately strict: an unparseable register THROWS instead of returning an
 * empty set.  A silent `[]` would score every cell of that backend as compiled
 * — the ledger would report its best news exactly when it had lost its input.
 */
export function skipKeys(file: string, register: string): string[] {
  const src = readFileSync(join(REPO, file), "utf8");
  const decl = src.indexOf(`const ${register}`);
  if (decl < 0) throw new Error(`gate-ledger: ${register} not found in ${file}`);
  const open = src.indexOf("{", decl);
  if (open < 0) throw new Error(`gate-ledger: ${register} in ${file} has no object literal`);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`gate-ledger: ${register} in ${file} is unterminated`);
  const body = src
    .slice(open + 1, end)
    // Comments carry the drained entries' history and would otherwise read as
    // keys (`// B19 (`seed-values`) is FIXED` names a feature id).
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(/(?:^|[{,])\s*["'`]?([A-Za-z0-9_-]+)["'`]?\s*:/g)].map(
    (m) => m[1] as string,
  );
}

export interface Cell {
  readonly feature: string;
  readonly backend: Backend;
  /** Declared in the corpus manifest — the generation floor. */
  readonly generates: boolean;
  /** This backend's compile leg builds the emitted project for this feature. */
  readonly compiles: boolean;
  /** The `.ddd` carries a `test e2e "…"` / domain `test "…"` block AND this
   *  backend's leg does not skip it — i.e. something BOOTS this cell. */
  readonly boots: boolean;
  /** The case declares an api-tier `test e2e` block, so its wire IS recorded
   *  and a reviewed golden is what turns that recording into an oracle.  A
   *  unit-only case (domain `test "…"` only) records no wire and needs none. */
  readonly declaresE2e: boolean;
  /** A committed `wire-golden/<feature>.json` exists to compare against. */
  readonly golden: boolean;
  /** Boots, and — where it declares e2e — is compared against a reviewed
   *  answer key.  Both halves matter: a wire recording with nothing to compare
   *  against is the "silently-off gate" `registers.mjs` names. */
  readonly behavioural: boolean;
  readonly strongest: Tier;
}

export interface Ledger {
  readonly cells: readonly Cell[];
  /** Cells whose strongest gate is generation alone — the silent-gap surface. */
  readonly generateOnly: readonly Cell[];
  /** Cells that compile but are never booted — string tests here still carry
   *  runtime-behaviour claims nothing else checks, so they are the cells the
   *  drain must NOT touch and the behavioural tier should reach next. */
  readonly compileOnly: readonly Cell[];
  /** Backends with no compile leg registered at all. */
  readonly backendsWithoutCompileLeg: readonly Backend[];
  readonly counts: Readonly<Record<Tier, number>>;
}

const goldenExists = (feature: string): boolean =>
  readdirSync(GOLDEN_DIR).includes(`${feature}.json`);

const skipSetFor = (clause: string): Record<string, string> =>
  (BEHAVIOURAL_SKIP as Record<string, Record<string, string>>)[clause] ?? {};

/** Join the registers into one per-cell view.  Pure apart from the reads. */
export function buildGateLedger(): Ledger {
  const skips = new Map<Backend, Set<string>>();
  const noLeg: Backend[] = [];
  for (const b of BACKENDS) {
    const leg = COMPILE_LEGS[b];
    if (!leg) {
      noLeg.push(b);
      continue;
    }
    skips.set(b, new Set(skipKeys(leg.file, leg.register)));
  }

  const cells: Cell[] = [];
  for (const f of CORPUS) {
    const src = corpusSource(f.id);
    const hasBlock = hasBehaviouralBlock(src);
    const e2e = declaresE2e(src);
    const golden = goldenExists(f.id);
    for (const b of BACKENDS) {
      if (!f.backends.includes(b)) continue;
      const compiles = skips.has(b) && !skips.get(b)?.has(f.id);
      const boots = hasBlock && !(f.id in skipSetFor(PLATFORM_CLAUSE[b]));
      const behavioural = boots && (!e2e || golden);
      const strongest: Tier = behavioural ? "behavioural" : compiles ? "compile" : "generate";
      cells.push({
        feature: f.id,
        backend: b,
        generates: true,
        compiles,
        boots,
        declaresE2e: e2e,
        golden,
        behavioural,
        strongest,
      });
    }
  }

  const counts = { none: 0, generate: 0, compile: 0, behavioural: 0 } as Record<Tier, number>;
  for (const c of cells) counts[c.strongest]++;

  return {
    cells,
    generateOnly: cells.filter((c) => c.strongest === "generate"),
    compileOnly: cells.filter((c) => c.strongest === "compile"),
    backendsWithoutCompileLeg: noLeg,
    counts,
  };
}

/** `feature:backend` — the stable cell id used by the registers below and by a
 *  string-test deletion citing its cell. */
export const cellId = (c: Pick<Cell, "feature" | "backend">): string => `${c.feature}:${c.backend}`;

/** A markdown view, for `LOOM_LEDGER_REPORT=1` and for pasting into a drain
 *  mission.  Not written to disk by any gate — a derived view committed to the
 *  tree is the rot this module exists to avoid. */
export function renderLedger(l: Ledger): string {
  const byFeature = new Map<string, Cell[]>();
  for (const c of l.cells) byFeature.set(c.feature, [...(byFeature.get(c.feature) ?? []), c]);
  const mark = (c: Cell): string => (c.behavioural ? "B" : c.compiles ? "c" : "g");
  const rows = [...byFeature.entries()].map(([f, cs]) => {
    const per = BACKENDS.map((b) => {
      const c = cs.find((x) => x.backend === b);
      return c ? mark(c) : "-";
    });
    return `| ${f} | ${per.join(" | ")} |`;
  });
  return [
    `Gate ledger — B behavioural, c compile, g generate-only, - not declared`,
    ``,
    `| feature | ${BACKENDS.join(" | ")} |`,
    `| --- | ${BACKENDS.map(() => "---").join(" | ")} |`,
    ...rows,
    ``,
    `cells: ${l.cells.length}  behavioural: ${l.counts.behavioural}  compile-only: ${l.counts.compile}  generate-only: ${l.counts.generate}`,
  ].join("\n");
}
