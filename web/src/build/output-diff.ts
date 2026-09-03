// What changed in the generated output (M-T8.20 slice 2).
//
// The playground regenerates statelessly, so every generate replaces the file
// tree wholesale and the user is left to spot the difference by eye — the
// audit's §4 #17 ("diff of generated output vs previous generate", which
// Prisma Studio and Amplication both have and Loom did not).  Two shapes are
// derived here:
//
//   1. `diffGenerated` — per-file added / changed / removed against the
//      PREVIOUS generate, driven by the per-file content hash the build
//      worker now returns (`VirtualFile.hash`).  Hash, not content: a
//      100-file tree is re-diffed on every keystroke-driven regenerate, and
//      the worker already has the bytes in hand.
//   2. `groupByDeployable` — the same change list folded by generated
//      project (`api/`, `web_app/`, `.loom/`, the root), which is how a
//      reader actually asks the question: "did my edit touch the frontend?".
//
// Pure: no React, no DOM, no worker.

import { GENERATED_PREFIX } from "../workspace/git/refs.js";
import type { VirtualFile } from "./protocol.js";

export type ChangeStatus = "added" | "changed" | "removed";

export interface OutputChange {
  path: string;
  status: ChangeStatus;
}

export interface OutputDiff {
  /** Path → status, for the files that changed.  A path absent from the map
   *  is unchanged; that is the common case and the reason this is a map of
   *  changes rather than a status per file. */
  byPath: Map<string, ChangeStatus>;
  added: number;
  changed: number;
  removed: number;
  /** True when there is anything at all to mark. */
  any: boolean;
}

const EMPTY: OutputDiff = { byPath: new Map(), added: 0, changed: 0, removed: 0, any: false };

/** Compare this generate's tree with the previous one.
 *
 *  `previous` of `null` means "there is no previous generate" — the very
 *  first one after a load or a workspace switch.  Everything would then read
 *  as "added", which is noise rather than information, so the diff is empty:
 *  the markers exist to show what an EDIT moved.
 *
 *  Falls back to comparing content when either side carries no `hash`, so a
 *  tree assembled on the main thread (the workspace 3-way merge in
 *  `App.persistGeneratedTree`) still diffs correctly. */
export function diffGenerated(
  current: readonly VirtualFile[],
  previous: readonly VirtualFile[] | null,
): OutputDiff {
  if (!previous) return EMPTY;
  const before = new Map(previous.map((f) => [f.path, f]));
  const byPath = new Map<string, ChangeStatus>();
  let added = 0;
  let changed = 0;
  let removed = 0;

  for (const file of current) {
    const prior = before.get(file.path);
    if (!prior) {
      byPath.set(file.path, "added");
      added++;
      continue;
    }
    before.delete(file.path);
    if (identical(file, prior)) continue;
    byPath.set(file.path, "changed");
    changed++;
  }
  for (const path of before.keys()) {
    byPath.set(path, "removed");
    removed++;
  }
  return { byPath, added, changed, removed, any: byPath.size > 0 };
}

function identical(a: VirtualFile, b: VirtualFile): boolean {
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash;
  return a.content === b.content;
}

/** One generated project's slice of a change list. */
export interface DeployableChanges {
  /** Top-level directory — the deployable's project folder, or `""` for the
   *  files that sit at the output root (`docker-compose.yml`). */
  name: string;
  changes: OutputChange[];
}

/** Fold a change list by generated project.
 *
 *  The grouping key is the first path segment because that IS the deployable
 *  in `generate system`'s output layout: one directory per deployable, plus
 *  `.loom/` for the artifact bundle and a handful of root files.  Groups are
 *  sorted with the root last (it is the least interesting) and by name
 *  otherwise; within a group, paths stay sorted. */
export function groupByDeployable(changes: readonly OutputChange[]): DeployableChanges[] {
  const groups = new Map<string, OutputChange[]>();
  for (const change of changes) {
    const slash = change.path.indexOf("/");
    const name = slash < 0 ? "" : change.path.slice(0, slash);
    const list = groups.get(name);
    if (list) list.push(change);
    else groups.set(name, [change]);
  }
  const out: DeployableChanges[] = [];
  for (const [name, list] of groups) {
    list.sort((a, b) => a.path.localeCompare(b.path));
    out.push({ name, changes: list });
  }
  out.sort((a, b) => {
    if ((a.name === "") !== (b.name === "")) return a.name === "" ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** The generated half of a git commit's file list, as `OutputChange`s.
 *
 *  History commits record absolute workspace paths (`/workspace/generated/
 *  api/index.ts`); the *What changed in the output* view wants the
 *  project-relative path the rest of the playground speaks (`api/index.ts`).
 *  Returns `[]` for a commit that touched no generated file, which is what
 *  a source-only autosave looks like. */
export function generatedChangesOf(
  files: readonly { path: string; status: "added" | "modified" | "removed" }[],
  prefix: string = GENERATED_PREFIX,
): OutputChange[] {
  const out: OutputChange[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    out.push({
      path: file.path.slice(prefix.length),
      status: file.status === "modified" ? "changed" : file.status,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
