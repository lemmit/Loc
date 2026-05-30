// ---------------------------------------------------------------------------
// Generated-tree merge — "scaffold then own" for generated code.
//
// Generated output is a first-class, editable, versioned citizen of the
// workspace: it lives under `/workspace/generated/**` next to the `.ddd`
// sources, so a user can hand-edit it.  The hard problem that creates —
// *regeneration must not clobber hand edits* — is solved with a per-file
// 3-way merge (per D-decision, the per-file model rather than a git
// vendor-branch):
//
//   base   = the output generated last time (stored as a JSON blob
//            behind `refs/loom/generated-base`)
//   ours   = the current working-tree content (may carry hand edits)
//   theirs = this run's fresh generator output
//
// Decision table per path:
//   - user didn't touch it (ours == base)      → take theirs
//   - generator didn't change it (theirs == base) → keep ours
//   - identical (ours == theirs)                → no-op
//   - both changed                              → standard conflict markers
//   - generator dropped it (theirs absent):
//       untouched (ours == base) → delete; else keep ours
//
// After applying, `refs/loom/generated-base` advances to this run's
// output so the next regenerate has the right base.  No git-branch
// plumbing, no working-tree churn of the `.ddd` sources, and a hand edit
// is never silently lost.
//
// Finer line-level (diff3) merging of the both-changed case is a future
// refinement; v1 surfaces the whole-file conflict so nothing is dropped.
// ---------------------------------------------------------------------------

import { commitOnSave } from "./helpers.js";
import { GENERATED_BASE_REF } from "./helpers.js";
import type { GitAuthor, GitStore } from "./git-store.js";
import type { VfsPath } from "../../vfs/types.js";

/** Root under which generated output is written.  Disjoint from the
 *  `.ddd` sources (`/workspace/*.ddd`) and custom packs
 *  (`/workspace/design/`), so generated paths never collide. */
export const GENERATED_PREFIX = "/workspace/generated/";

/** A generated file as produced by the build worker — a project-
 *  relative path (`catalog_web/domain/product.ts`) and its content. */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** Outcome of applying a generated tree — every affected absolute path,
 *  bucketed by how it was resolved.  `conflicted` paths now contain
 *  standard conflict markers in the working tree. */
export interface RegenerateResult {
  /** Written/updated from generator output. */
  written: VfsPath[];
  /** User edit kept (generator output unchanged from base). */
  preserved: VfsPath[];
  /** Both the user and the generator changed it → conflict markers. */
  conflicted: VfsPath[];
  /** Generated last time, untouched by the user, no longer emitted. */
  deleted: VfsPath[];
}

/** Read the current generated tree back from the workspace as
 *  project-relative `GeneratedFile`s (the `/workspace/generated/`
 *  prefix stripped).  This is the merge *result* — generator output
 *  with any hand edits applied — so feeding it to the bundler makes the
 *  preview reflect edits to generated code ("scaffold then own"). */
export async function readGeneratedTree(store: GitStore): Promise<GeneratedFile[]> {
  const out: GeneratedFile[] = [];
  for (const abs of await store.list(GENERATED_PREFIX)) {
    const content = await store.readFile(abs);
    if (content == null) continue;
    out.push({ path: abs.slice(GENERATED_PREFIX.length), content });
  }
  return out;
}

function conflictMarkers(ours: string, theirs: string): string {
  // Standard git-style markers; the editor renders them as plain text
  // until a richer conflict UX lands.
  return `<<<<<<< your edits\n${ours}\n=======\n${theirs}\n>>>>>>> regenerated\n`;
}

async function readGeneratedBase(
  store: GitStore,
): Promise<Record<string, string> | null> {
  try {
    const oid = await store.resolveRef(GENERATED_BASE_REF);
    return JSON.parse(await store.readBlobText(oid)) as Record<string, string>;
  } catch {
    return null; // no prior generate
  }
}

async function writeGeneratedBase(
  store: GitStore,
  map: Record<string, string>,
): Promise<void> {
  const oid = await store.writeBlobText(JSON.stringify(map));
  await store.writeRef(GENERATED_BASE_REF, oid);
}

/** Apply a freshly-generated tree to the workspace as a per-file 3-way
 *  merge against the last generated output, preserving hand edits.
 *  Writes results under `/workspace/generated/**`, advances the
 *  generated-base ref, and (unless `commit: false`) commits.  Returns a
 *  breakdown of how each path resolved. */
export async function applyGeneratedTree(
  store: GitStore,
  files: GeneratedFile[],
  opts: { author?: GitAuthor; commit?: boolean; message?: string } = {},
): Promise<RegenerateResult> {
  const base = await readGeneratedBase(store);
  const theirs = new Map<string, string>(files.map((f) => [f.path, f.content]));

  // Current working-tree generated files ("ours").
  const ours = new Map<string, string>();
  for (const abs of await store.list(GENERATED_PREFIX)) {
    const content = await store.readFile(abs);
    if (content != null) ours.set(abs.slice(GENERATED_PREFIX.length), content);
  }

  const result: RegenerateResult = {
    written: [],
    preserved: [],
    conflicted: [],
    deleted: [],
  };

  const allRel = new Set<string>([
    ...theirs.keys(),
    ...ours.keys(),
    ...Object.keys(base ?? {}),
  ]);

  for (const rel of allRel) {
    const abs = (GENERATED_PREFIX + rel) as VfsPath;
    const b = base?.[rel];
    const o = ours.get(rel);
    const t = theirs.get(rel);

    if (t !== undefined) {
      if (o === undefined || o === b) {
        // No working copy, or user didn't touch it since last gen →
        // take the new generator output.
        await store.writeFile(abs, t);
        result.written.push(abs);
      } else if (o === t) {
        // Already identical — nothing to do.
      } else if (t === b) {
        // Generator output unchanged from base, but the user edited →
        // keep the user's edit.
        result.preserved.push(abs);
      } else {
        // Both changed (and base may be absent — a user file shadowing a
        // newly-generated path) → conflict.
        await store.writeFile(abs, conflictMarkers(o, t));
        result.conflicted.push(abs);
      }
    } else if (o !== undefined) {
      // Generator no longer emits this path.
      if (b !== undefined && o === b) {
        await store.deleteFile(abs);
        result.deleted.push(abs);
      } else {
        result.preserved.push(abs); // user-edited / user-authored → keep
      }
    }
  }

  // Advance the base to this run's output.
  await writeGeneratedBase(store, Object.fromEntries(theirs));

  if (opts.commit !== false) {
    await commitOnSave(store, opts.message ?? "regenerate", opts.author);
  }
  return result;
}
