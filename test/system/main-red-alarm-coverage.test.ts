// main-red alarm coverage ratchet.
//
// WHY THIS EXISTS
// ---------------
// Branch protection requires only the fast `tests passed` rollup, so every
// heavy gate reports on `main` AFTER the merge. `ci-red-alarm.yml` is the
// signal that a post-merge gate went red — it opens (or comments on) one
// `ci-red` issue whenever a watched workflow concludes `failure` on main.
//
// Its watchlist used to be hand-curated, which reintroduced the exact hole it
// was built to close: `API call (typed in-system call runtime e2e)` failed on
// 100% of its main pushes for two days (Aug 2–4, 2026) and nothing said so,
// because nobody had added it to the list. A gate that is NEVER green has no
// red transition to notice — the alarm is the only thing that would have
// spoken, and it was not listening.
//
// So the rule is now mechanical, and this test is what enforces it:
//
//     every workflow that runs on `push: main` is on the watchlist.
//
// `workflow_run.workflows` takes literal names (no expressions, no globs), so
// the list has to be spelled out in the YAML; this test is what keeps that
// spelling honest. Adding a main gate without alarming on it now fails the
// fast suite, in the same audit→gate ratchet `merge-queue-readiness.test.ts`
// applies to the merge queue.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsDir = path.resolve(here, "../../.github/workflows");

const ALARM = "ci-red-alarm.yml";

/** Top-level `name:` of a workflow — the identity `workflow_run` matches on. */
function workflowName(source: string): string | undefined {
  const m = source.match(/^name:[ \t]*(.+)$/m);
  return m ? stripQuotes(m[1].trim()) : undefined;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/**
 * Does this workflow trigger on a push to `main`?
 *
 * Deliberately small reader over the block-style `on:` every workflow here
 * uses (same discipline as `merge-queue-readiness.test.ts` — no YAML parser is
 * resolvable in this repo's dependency tree). The "reads every workflow" case
 * below fails loudly if that stops holding.
 */
function pushesOnMain(source: string): boolean {
  const lines = source.split("\n").map((l) => l.replace(/\r$/, ""));
  let inOn = false;
  let inPush = false;
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      inOn = /^on:\s*$/.test(line);
      inPush = false;
      continue;
    }
    if (!inOn) continue;
    if (/^ {2}\S/.test(line)) inPush = /^ {2}push:/.test(line);
    if (!inPush) continue;
    // `branches: [main]` — the only form used here; the flow-seq check keeps a
    // `branches: [main-something]` from matching by substring.
    const m = line.match(/^ {4}branches:\s*\[(.+)\]\s*$/);
    if (m?.[1].split(",").some((b) => stripQuotes(b.trim()) === "main")) return true;
  }
  return false;
}

/** The `workflows:` list of the alarm's `workflow_run` trigger. */
function watchlist(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^ {4}workflows:\s*$/.test(l));
  expect(start, "ci-red-alarm.yml has no `workflows:` list").toBeGreaterThan(-1);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^ {6}- (.+)$/);
    if (!m) break;
    out.push(stripQuotes(m[1].trim()));
  }
  return out;
}

const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml"));
const read = (f: string): string => readFileSync(path.join(workflowsDir, f), "utf8");

describe("main-red alarm coverage", () => {
  it("the reader sees a name for every workflow in the repo", () => {
    expect(files.length).toBeGreaterThan(0);
    const nameless = files.filter((f) => workflowName(read(f)) === undefined);
    expect(nameless, "workflows with no top-level `name:`").toEqual([]);
  });

  it("watches every workflow that runs on `push: main`", () => {
    const watched = new Set(watchlist(read(ALARM)));
    const unwatched = files
      .filter((f) => pushesOnMain(read(f)))
      .map((f) => ({ file: f, name: workflowName(read(f)) as string }))
      .filter((w) => !watched.has(w.name))
      .map((w) => `${w.name}  (${w.file})`);
    expect(
      unwatched,
      "these gates run on main but nothing alarms when they fail — add their `name:` to ci-red-alarm.yml",
    ).toEqual([]);
  });

  it("watches nothing that no longer exists (a renamed gate stops alarming silently)", () => {
    const names = new Set(files.map((f) => workflowName(read(f))));
    const stale = watchlist(read(ALARM)).filter((n) => !names.has(n));
    expect(stale, "watchlist entries matching no workflow `name:`").toEqual([]);
  });

  it("lists each watched workflow once", () => {
    const list = watchlist(read(ALARM));
    expect(list.length).toBe(new Set(list).size);
  });

  it("alarms only on a real failure on the default branch", () => {
    const source = read(ALARM);
    expect(source).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(source).toContain("github.event.workflow_run.head_branch == 'main'");
  });
});
