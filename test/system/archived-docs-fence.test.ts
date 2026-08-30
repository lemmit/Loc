import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - docs/build.mjs is a plain ESM script outside the TS project graph.
import { ARCHIVED, archivedNotice, RENDERED_SUBDIRS } from "../../docs/build.mjs";

// ---------------------------------------------------------------------------
// The archived-corpus fence.
//
// `docs/old/**` is a FROZEN design record (grammar sketches, semantics,
// rationale — its status tables are superseded) and `docs/audits/**` are
// snapshot-in-time findings true only as of the commit each one names.
// CLAUDE.md says so, at length, for agents reading the repo.  A reader of the
// DEPLOYED site had no such fence: `docs/build.mjs` renders both corpora to
// GitHub Pages, where an archived proposal looked exactly as current as
// `docs/language.md`.
//
// `archivedNotice()` now stamps a banner on those pages.  This file is the
// gate that keeps it honest — the same move this repo already makes for the
// pipeline layering invariant (`ALLOWED = {}` in pipeline-layering.test.ts)
// and the diagnostic catalog: the rule is enforced, not merely written down.
//
// Deliberately NOT gated here: whether the PROSE around a live→archive link
// marks it as historical.  Every heuristic for that either passes on the URL
// text itself (`old/proposals/…` contains "proposal") or fires on correct
// prose, and a gate that cannot reach the thing it names is worse than none
// (experience_gathered.md §59, §63).  The checks below are all mechanical.
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsDir = path.join(repoRoot, "docs");

/** Path prefixes (relative to docs/) whose rendered pages are archived. */
const ARCHIVED_PREFIXES: string[] = (ARCHIVED as { prefix: string }[]).map((a) => a.prefix);

/** A rendered subdir is archived when some ARCHIVED prefix covers it. */
const isArchivedSubdir = (sub: string): boolean =>
  ARCHIVED_PREFIXES.some((p) => `${sub}/`.startsWith(p));

/** The corpora that are frozen/perishable and must never render unmarked.
 *  Hard-coded rather than derived, so DELETING an ARCHIVED entry fails here
 *  instead of silently unmarking the corpus it covered. */
const MUST_BE_MARKED = ["old/plans", "old/proposals", "audits"];

describe("archived docs carry a fence on the published site", () => {
  it("every corpus that must be marked is still covered by an ARCHIVED prefix", () => {
    const unmarked = MUST_BE_MARKED.filter((sub) => !isArchivedSubdir(sub));
    expect(unmarked, "an archived corpus lost its ARCHIVED prefix in docs/build.mjs").toEqual([]);
  });

  it("every rendered subdir under an archived corpus produces a banner", () => {
    const missing = RENDERED_SUBDIRS.filter(
      (sub: string) => isArchivedSubdir(sub) && archivedNotice(`${sub}/page.md`, 1) === "",
    );
    expect(missing, "rendered archived subdir with no banner").toEqual([]);
  });

  it("marks every rendered page of an archived corpus, and no live page", () => {
    const marked: string[] = [];
    const bare: string[] = [];
    for (const sub of RENDERED_SUBDIRS as string[]) {
      const dir = path.join(docsDir, sub);
      if (!fs.existsSync(dir)) continue;
      const depth = sub.split("/").length;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const rel = `${sub}/${f}`;
        (archivedNotice(rel, depth) === "" ? bare : marked).push(rel);
      }
    }
    // Live corpora stay unmarked; archived ones are marked. No page is both.
    expect(marked.filter((r) => !ARCHIVED_PREFIXES.some((p) => r.startsWith(p)))).toEqual([]);
    expect(bare.filter((r) => ARCHIVED_PREFIXES.some((p) => r.startsWith(p)))).toEqual([]);
    // Sanity: the gate actually reached both sides.
    expect(marked.length).toBeGreaterThan(100);
    expect(bare.length).toBeGreaterThan(10);
  });

  it("the banner routes to the live surfaces, not deeper into the archive", () => {
    const html = archivedNotice("old/proposals/x.md", 2);
    expect(html).toContain('href="../../README.html"');
    expect(html).toContain('href="../../new-plan/README.html"');
    expect(fs.existsSync(path.join(docsDir, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(docsDir, "new-plan", "README.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Link integrity into the frozen corpora.
//
// Nobody edits `docs/old/**`, so the 60-odd inbound links from live docs rot
// silently when an archived file is renamed or dropped.  A dead link into the
// archive is how a reader ends up guessing at what a doc used to say.
// ---------------------------------------------------------------------------

/** Live docs that may link into the archive. */
function liveDocs(): string[] {
  const out = [path.join(repoRoot, "CLAUDE.md")];
  const walk = (dir: string, recurse: boolean) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recurse && e.name !== "old" && e.name !== "_site") walk(full, recurse);
      } else if (e.name.endsWith(".md")) out.push(full);
    }
  };
  walk(docsDir, false);
  walk(path.join(docsDir, "language-reference"), true);
  walk(path.join(docsDir, "new-plan"), true);
  return out;
}

const MD_LINK = /\]\(([^)\s]+?\.md)(#[^)]*)?\)/g;

describe("live docs never link to a missing archived doc", () => {
  it("every live → docs/old|audits link resolves", () => {
    const dead: string[] = [];
    let seen = 0;
    for (const file of liveDocs()) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(MD_LINK)) {
        const href = m[1];
        // Normalise to a docs-relative path, then keep only archive targets.
        const abs = path.resolve(path.dirname(file), href);
        const rel = path.relative(docsDir, abs).split(path.sep).join("/");
        if (!/^(old\/|audits\/)/.test(rel)) continue;
        seen++;
        if (!fs.existsSync(abs)) {
          dead.push(`${path.relative(repoRoot, file)} -> ${href}`);
        }
      }
    }
    // The gate must actually reach the links it claims to check.
    expect(
      seen,
      "no live → archive links found; the matcher stopped reaching them",
    ).toBeGreaterThan(40);
    expect(dead, "dead link into the frozen archive").toEqual([]);
  });
});
