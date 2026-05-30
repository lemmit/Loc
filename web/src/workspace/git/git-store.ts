// ---------------------------------------------------------------------------
// GitStore — async, git-backed durable store for the playground.
//
// The new main-thread source of truth (see git-fs.ts).  It exposes:
//   - an **async file API** (read/write/delete/mkdir/rmdir/list/…) whose
//     operation set matches what the workspace controller calls today
//     (`web/src/workspace/workspace-sources.ts`), so PR 2 can swap the
//     sync VFS subscription for this store with minimal reshaping;
//   - a **reactive notifier** (`subscribe` / `notify`) — the one seam
//     LightningFS and isomorphic-git lack, since neither emits change
//     events.  Its prefix-matching + coalescing semantics mirror
//     `web/src/vfs/memory-vfs.ts` exactly so subscribers behave the same;
//   - **thin git ops** (stage/commit/log/checkout/merge/refs) plus a
//     tree diff, used by the composed helpers in helpers.ts.
//
// Deliberately NOT an implementation of the sync `Vfs` interface
// (proposal decisions #2/#3): the store is async and stands alone.
//
// Path convention: every public method takes an absolute, normalised
// POSIX `VfsPath` (`/workspace/...`).  isomorphic-git `filepath` args
// are repo-relative, so they are derived by stripping the leading `/`.
// ---------------------------------------------------------------------------

import * as git from "isomorphic-git";

import type { VfsEntry, VfsListener, VfsPath } from "../../vfs/types.js";
import { asFsClient, type GitFs } from "./git-fs.js";

/** Normalise a VFS path: enforce leading `/`, collapse `..`/`.`, reject
 *  root escape.  Mirrors `web/src/vfs/memory-vfs.ts`'s `normalize` so
 *  the two stores agree on path identity. */
export function normalizePath(path: VfsPath): VfsPath {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`git-store: empty path`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`git-store: path must be absolute (leading "/"): "${path}"`);
  }
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        throw new Error(`git-store: path escapes root: "${path}"`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

/** True iff `path` is `prefix` itself or sits beneath it at a directory
 *  boundary.  Same rule as MemoryVfs's listing/notify matcher: a `/`
 *  prefix matches everything; otherwise `path === prefix` or
 *  `path.startsWith(prefix + "/")`.  Duplicated here (rather than
 *  shared) to keep this PR from touching memory-vfs.ts; a later cleanup
 *  can lift it into a shared `web/src/vfs/path.ts`. */
function underPrefix(path: VfsPath, prefix: VfsPath): boolean {
  return prefix === "/" || path === prefix || path.startsWith(prefix + "/");
}

interface Subscription {
  prefix: VfsPath;
  listener: VfsListener;
}

/** A node:fs-style error carrying a POSIX `code`.  LightningFS throws
 *  these for ENOENT / EEXIST / ENOTEMPTY / etc. */
function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Author identity for commits/merges. */
export interface GitAuthor {
  name: string;
  email: string;
}

/** Default author for compiler-driven commits (commit-on-save,
 *  regenerate merges).  Real user identity is a later concern. */
export const LOOM_AUTHOR: GitAuthor = {
  name: "Loom Playground",
  email: "playground@loom.local",
};

/** One entry of a tree-vs-tree diff. */
export interface FileDiff {
  path: VfsPath;
  status: "added" | "removed" | "modified";
}

/** Options for the `list*` family.  `skip` prunes subtrees (absolute
 *  paths) from the underlying walk — e.g. the source scan skips
 *  `/workspace/generated`. */
export interface ListOpts {
  skip?: ReadonlyArray<VfsPath>;
}

/** Outcome of a merge — either a clean result or a conflict listing.
 *  Never throws on conflict, so callers branch on `ok`. */
export type MergeOutcome =
  | {
      ok: true;
      oid?: string;
      fastForward?: boolean;
      alreadyMerged?: boolean;
      mergeCommit?: boolean;
    }
  | { ok: false; conflicts: VfsPath[] };

/** A single commit, projected to the fields the UI/log needs. */
export interface CommitInfo {
  oid: string;
  message: string;
  author: GitAuthor;
  timestamp: number;
}

const REPO_RELATIVE = (path: VfsPath): string => path.replace(/^\//, "");
const ABSOLUTE = (filepath: string): VfsPath =>
  filepath.startsWith("/") ? filepath : "/" + filepath;

export class GitStore {
  private readonly subs = new Set<Subscription>();
  /** Serialises commits so concurrent callers (debounced autosave +
   *  an intentional regenerate) can't interleave git index/HEAD writes. */
  private commitChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly gfs: GitFs) {}

  /** The underlying LightningFS + repo dir — for the composed helpers
   *  in helpers.ts that need raw git access. */
  get context(): GitFs {
    return this.gfs;
  }

  private get fs() {
    return this.gfs.fs;
  }
  private get fsc(): git.FsClient {
    return asFsClient(this.gfs.fs);
  }
  private get dir() {
    return this.gfs.dir;
  }

  // -- file API -------------------------------------------------------------

  async readFile(path: VfsPath): Promise<string | undefined> {
    const norm = normalizePath(path);
    try {
      return (await this.fs.promises.readFile(norm, "utf8")) as string;
    } catch (err) {
      const code = errCode(err);
      // Missing path or "it's a directory" → no content, matching the
      // `Vfs.read` contract (returns undefined rather than throwing).
      if (code === "ENOENT" || code === "EISDIR") return undefined;
      throw err;
    }
  }

  async writeFile(path: VfsPath, content: string): Promise<void> {
    const norm = normalizePath(path);
    await this.ensureParentDirs(norm);
    await this.fs.promises.writeFile(norm, content, "utf8");
    this.notify([norm]);
  }

  /** File-only delete — no-op when the path is missing or is a
   *  directory (callers want `rmdir` for those), mirroring MemoryVfs. */
  async deleteFile(path: VfsPath): Promise<void> {
    const norm = normalizePath(path);
    try {
      const st = await this.fs.promises.stat(norm);
      if (st.isDirectory()) return;
      await this.fs.promises.unlink(norm);
      this.notify([norm]);
    } catch (err) {
      if (errCode(err) === "ENOENT") return;
      throw err;
    }
  }

  /** mkdirp + idempotent.  Notifies once with every newly-created dir
   *  (oldest-first), matching MemoryVfs's batched fan-out. */
  async mkdir(path: VfsPath): Promise<void> {
    const norm = normalizePath(path);
    const created = await this.ensureDirChain(norm);
    if (created.length > 0) {
      created.sort();
      this.notify(created);
    }
  }

  /** Remove an empty directory.  No-op when absent or a file; throws
   *  when non-empty (LightningFS surfaces ENOTEMPTY). */
  async rmdir(path: VfsPath): Promise<void> {
    const norm = normalizePath(path);
    let st: { isDirectory(): boolean };
    try {
      st = await this.fs.promises.stat(norm);
    } catch (err) {
      if (errCode(err) === "ENOENT") return;
      throw err;
    }
    if (!st.isDirectory()) return;
    try {
      await this.fs.promises.rmdir(norm);
    } catch (err) {
      if (errCode(err) === "ENOTEMPTY") {
        throw new Error(`git-store: directory "${norm}" is not empty`);
      }
      throw err;
    }
    this.notify([norm]);
  }

  async exists(path: VfsPath): Promise<boolean> {
    return (await this.kindOf(path)) !== undefined;
  }

  async isFile(path: VfsPath): Promise<boolean> {
    return (await this.kindOf(path)) === "file";
  }

  async isDirectory(path: VfsPath): Promise<boolean> {
    return (await this.kindOf(path)) === "dir";
  }

  async kindOf(path: VfsPath): Promise<"file" | "dir" | undefined> {
    const norm = normalizePath(path);
    try {
      const st = await this.fs.promises.stat(norm);
      return st.isDirectory() ? "dir" : "file";
    } catch (err) {
      if (errCode(err) === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Files under `prefix`, sorted.  Directory-boundary prefix match. */
  async list(prefix: VfsPath, opts?: ListOpts): Promise<VfsPath[]> {
    return this.listFiltered(prefix, "file", opts?.skip);
  }

  /** Directories under `prefix`, sorted. */
  async listDirs(prefix: VfsPath, opts?: ListOpts): Promise<VfsPath[]> {
    return this.listFiltered(prefix, "dir", opts?.skip);
  }

  /** Files and directories under `prefix`, sorted. */
  async listAll(prefix: VfsPath, opts?: ListOpts): Promise<VfsPath[]> {
    return this.listFiltered(prefix, undefined, opts?.skip);
  }

  private async listFiltered(
    prefix: VfsPath,
    kind: "file" | "dir" | undefined,
    skip?: ReadonlyArray<VfsPath>,
  ): Promise<VfsPath[]> {
    const norm = normalizePath(prefix);
    const all = await this.walkTree(skip);
    const out: VfsPath[] = [];
    for (const node of all) {
      if (kind !== undefined && node.kind !== kind) continue;
      if (underPrefix(node.path, norm)) out.push(node.path);
    }
    out.sort();
    return out;
  }

  // -- notifier -------------------------------------------------------------

  /** Subscribe to writes/deletes/dir-ops (and checkout/merge working-tree
   *  changes) touching paths under `prefix`.  Returns an unsubscribe fn.
   *  Mirrors `MemoryVfs.subscribe`. */
  subscribe(prefix: VfsPath, listener: VfsListener): () => void {
    const sub: Subscription = { prefix: normalizePath(prefix), listener };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  private notify(changed: ReadonlyArray<VfsPath>): void {
    for (const sub of this.subs) {
      let matched: VfsPath[] | null = null;
      for (const p of changed) {
        if (underPrefix(p, sub.prefix)) (matched ??= []).push(p);
      }
      if (matched) sub.listener(matched);
    }
  }

  // -- git ops --------------------------------------------------------------

  /** Stage every working-tree change (adds, modifications, deletions)
   *  under the repo.  Returns true when anything was staged. */
  async stageAll(): Promise<boolean> {
    // Stage by hashing actual content rather than trusting
    // `statusMatrix`'s stat-based change shortcut: LightningFS (and
    // fake-indexeddb under test) give coarse mtimes, so a same-size edit
    // can carry an unchanged mtime and be missed.  `git.add` always
    // hashes the file, so add-every-working-file is immune to that.
    const nodes = await this.walkTree();
    const workingFiles = nodes
      .filter((n) => n.kind === "file")
      .map((n) => REPO_RELATIVE(n.path));
    for (const filepath of workingFiles) {
      await git.add({ fs: this.fsc, dir: this.dir, filepath });
    }
    // Removals: anything currently tracked in the index but gone from
    // the working tree.
    const workingSet = new Set(workingFiles);
    let tracked: string[] = [];
    try {
      tracked = await git.listFiles({ fs: this.fsc, dir: this.dir });
    } catch {
      tracked = [];
    }
    for (const filepath of tracked) {
      if (!workingSet.has(filepath)) {
        await git.remove({ fs: this.fsc, dir: this.dir, filepath });
      }
    }
    // No-op detection is content-based too: compare the staged tree to
    // HEAD's tree rather than re-reading stat-derived status.
    return this.indexDiffersFromHead();
  }

  /** True when the staged index differs from HEAD.  Uses the HEAD-vs-
   *  STAGE columns of `statusMatrix` (`[path, HEAD, WORKDIR, STAGE]`),
   *  which compare by blob oid — reliable here because `stageAll`
   *  already hashed real content into the index.  The WORKDIR column
   *  (the stat-shortcut one) is intentionally ignored. */
  private async indexDiffersFromHead(): Promise<boolean> {
    const matrix = await git.statusMatrix({ fs: this.fsc, dir: this.dir });
    return matrix.some(
      ([, head, , stage]) =>
        !((head === 1 && stage === 1) || (head === 0 && stage === 0)),
    );
  }

  async commit(message: string, author: GitAuthor = LOOM_AUTHOR): Promise<string> {
    return git.commit({
      fs: this.fsc,
      dir: this.dir,
      message,
      author: { ...author },
    });
  }

  /** Stage the whole working tree and commit it, serialised against any
   *  other in-flight `commitWorkingTree` so two commits never interleave.
   *  Returns the new commit oid, or `undefined` when nothing changed. */
  async commitWorkingTree(
    message: string,
    author: GitAuthor = LOOM_AUTHOR,
  ): Promise<string | undefined> {
    const run = this.commitChain.then(async () => {
      const staged = await this.stageAll();
      if (!staged) return undefined;
      return this.commit(message, author);
    });
    // Keep the chain alive regardless of this run's outcome so one
    // failure doesn't wedge every subsequent commit.
    this.commitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async log(depth?: number): Promise<CommitInfo[]> {
    const commits = await git.log({ fs: this.fsc, dir: this.dir, depth });
    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message,
      author: { name: c.commit.author.name, email: c.commit.author.email },
      timestamp: c.commit.author.timestamp,
    }));
  }

  async resolveRef(ref: string): Promise<string> {
    return git.resolveRef({ fs: this.fsc, dir: this.dir, ref });
  }

  async writeRef(ref: string, value: string, force = true): Promise<void> {
    await git.writeRef({ fs: this.fsc, dir: this.dir, ref, value, force });
  }

  /** Write a UTF-8 blob and return its oid.  Used to persist small
   *  out-of-tree state (e.g. the generated-base snapshot) behind a ref
   *  without materialising a working-tree file. */
  async writeBlobText(text: string): Promise<string> {
    return git.writeBlob({
      fs: this.fsc,
      dir: this.dir,
      blob: new TextEncoder().encode(text),
    });
  }

  /** Read a blob by oid as UTF-8 text.  Inverse of `writeBlobText`. */
  async readBlobText(oid: string): Promise<string> {
    const { blob } = await git.readBlob({ fs: this.fsc, dir: this.dir, oid });
    return new TextDecoder().decode(blob);
  }

  /** Create a branch at the current HEAD (without checking it out). */
  async branch(name: string): Promise<void> {
    await git.branch({ fs: this.fsc, dir: this.dir, ref: name });
  }

  async currentBranch(): Promise<string> {
    const branch = await git.currentBranch({
      fs: this.fsc,
      dir: this.dir,
      fullname: false,
    });
    return branch ?? "main";
  }

  /** Check out `ref` into the working tree, then notify subscribers of
   *  the working-tree paths that changed.
   *
   *  Note: isomorphic-git's checkout selects files to overwrite by an
   *  oid/stat diff.  Under coarse-mtime backends (fake-indexeddb in
   *  tests) a same-size edit can share an mtime and be skipped; real
   *  browsers give millisecond mtimes for edits seconds apart, so this
   *  is a test-environment artifact, not a production concern. */
  async checkout(ref: string, force = false): Promise<void> {
    const before = await this.contentMap();
    await git.checkout({ fs: this.fsc, dir: this.dir, ref, force });
    await this.notifyDiff(before);
  }

  /** Merge `theirs` into the current branch.  Returns a structured
   *  outcome instead of throwing on conflict; on a clean merge the
   *  working tree is synced and subscribers are notified.  The
   *  generated-base relationship the proposal models is established by
   *  the commit graph (PR 4); here this is the merge primitive. */
  async merge(
    theirs: string,
    opts: { author?: GitAuthor; message?: string } = {},
  ): Promise<MergeOutcome> {
    const before = await this.contentMap();
    const author = opts.author ?? LOOM_AUTHOR;
    try {
      const res = await git.merge({
        fs: this.fsc,
        dir: this.dir,
        theirs,
        author: { ...author },
        message: opts.message,
      });
      // merge updates HEAD/index; materialise the result in the working
      // tree so reads reflect it, then fan out the changed paths.
      await git.checkout({
        fs: this.fsc,
        dir: this.dir,
        ref: await this.currentBranch(),
        force: true,
      });
      await this.notifyDiff(before);
      return {
        ok: true,
        oid: res.oid,
        fastForward: res.fastForward,
        alreadyMerged: res.alreadyMerged,
        mergeCommit: res.mergeCommit,
      };
    } catch (err) {
      if (err instanceof git.Errors.MergeConflictError) {
        return { ok: false, conflicts: err.data.filepaths.map(ABSOLUTE) };
      }
      throw err;
    }
  }

  /** Per-file diff between two refs/trees (blobs only).  Minimal
   *  added/removed/modified classification — the unified-diff UX is a
   *  later concern; isomorphic-git has no one-shot unified diff. */
  async treeDiff(a: string, b: string): Promise<FileDiff[]> {
    const out: FileDiff[] = [];
    await git.walk({
      fs: this.fsc,
      dir: this.dir,
      trees: [git.TREE({ ref: a }), git.TREE({ ref: b })],
      map: async (filepath, entries) => {
        if (filepath === ".") return;
        const [A, B] = entries as Array<git.WalkerEntry | null>;
        const aType = A ? await A.type() : undefined;
        const bType = B ? await B.type() : undefined;
        if (aType !== "blob" && bType !== "blob") return; // dirs/trees
        const path = ABSOLUTE(filepath);
        if (!A || aType !== "blob") out.push({ path, status: "added" });
        else if (!B || bType !== "blob") out.push({ path, status: "removed" });
        else if ((await A.oid()) !== (await B.oid()))
          out.push({ path, status: "modified" });
      },
    });
    out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return out;
  }

  // -- snapshot -------------------------------------------------------------

  /** Project the workspace tree to the `VfsEntry` union — the shape the
   *  build-worker seed (`client.ts` `seedWorkspace`) and worker-rehydrate
   *  flow consume.  Files carry content; empty dirs are `kind: "dir"`. */
  async snapshotEntries(root: VfsPath = "/workspace"): Promise<VfsEntry[]> {
    const norm = normalizePath(root);
    const nodes = await this.walkTree();
    const out: VfsEntry[] = [];
    for (const node of nodes) {
      if (!underPrefix(node.path, norm)) continue;
      if (node.kind === "file") {
        const content = (await this.readFile(node.path)) ?? "";
        out.push({ kind: "file", path: node.path, content });
      } else {
        out.push({ kind: "dir", path: node.path });
      }
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  // -- internals ------------------------------------------------------------

  /** Recursive walk of the LightningFS tree, skipping the gitdir.
   *  Returns every file and directory as `{ path, kind }`.  At
   *  playground scale (low hundreds of paths) a full walk per list call
   *  is negligible, matching MemoryVfs's full-scan listing.
   *
   *  `skip` prunes whole subtrees by absolute path — the hot per-keystroke
   *  source scan passes `/workspace/generated` so it doesn't traverse the
   *  (potentially large) generated tree just to filter it out. */
  private async walkTree(
    skip?: ReadonlyArray<VfsPath>,
  ): Promise<Array<{ path: VfsPath; kind: "file" | "dir" }>> {
    const out: Array<{ path: VfsPath; kind: "file" | "dir" }> = [];
    const skipSet =
      skip && skip.length > 0 ? new Set(skip.map((p) => normalizePath(p))) : null;
    const visit = async (dirPath: VfsPath): Promise<void> => {
      let names: string[];
      try {
        names = await this.fs.promises.readdir(dirPath);
      } catch {
        return;
      }
      for (const name of names) {
        if (dirPath === "/" && name === ".git") continue; // never expose the repo
        const childPath = dirPath === "/" ? `/${name}` : `${dirPath}/${name}`;
        if (skipSet?.has(childPath)) continue; // prune this subtree
        let st: { isDirectory(): boolean };
        try {
          st = await this.fs.promises.stat(childPath);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          out.push({ path: childPath, kind: "dir" });
          await visit(childPath);
        } else {
          out.push({ path: childPath, kind: "file" });
        }
      }
    };
    await visit("/");
    return out;
  }

  /** Snapshot every workspace file's content — used to diff before/after
   *  a checkout/merge so the notifier can fan out the changed paths. */
  private async contentMap(): Promise<Map<VfsPath, string>> {
    const map = new Map<VfsPath, string>();
    for (const node of await this.walkTree()) {
      if (node.kind !== "file") continue;
      map.set(node.path, (await this.readFile(node.path)) ?? "");
    }
    return map;
  }

  private async notifyDiff(before: Map<VfsPath, string>): Promise<void> {
    const after = await this.contentMap();
    const changed = new Set<VfsPath>();
    for (const [path, content] of after) {
      if (before.get(path) !== content) changed.add(path);
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changed.add(path);
    }
    if (changed.size > 0) this.notify([...changed].sort());
  }

  /** mkdirp for a file's parent chain (so LightningFS `writeFile`
   *  doesn't ENOENT on a missing parent). */
  private async ensureParentDirs(filePath: VfsPath): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return; // file directly under root
    await this.ensureDirChain(filePath.slice(0, slash));
  }

  /** mkdirp for a directory path; returns the dirs newly created. */
  private async ensureDirChain(dirPath: VfsPath): Promise<VfsPath[]> {
    const segments = dirPath.split("/").filter((s) => s.length > 0);
    const created: VfsPath[] = [];
    let cur = "";
    for (const seg of segments) {
      cur = `${cur}/${seg}`;
      try {
        await this.fs.promises.mkdir(cur);
        created.push(cur);
      } catch (err) {
        if (errCode(err) === "EEXIST") continue; // already a dir
        throw err;
      }
    }
    return created;
  }
}
