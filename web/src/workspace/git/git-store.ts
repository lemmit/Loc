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

/** Options for the `list*` family.  `skip` prunes subtrees (absolute
 *  paths) from the underlying walk — e.g. the source scan skips
 *  `/workspace/generated`. */
export interface ListOpts {
  skip?: ReadonlyArray<VfsPath>;
}

/** A single commit, projected to the fields the UI/log needs. */
export interface CommitInfo {
  oid: string;
  message: string;
  author: GitAuthor;
  timestamp: number;
}

/** One file's change within a commit (vs. its first parent).  Paths are
 *  absolute (`/workspace/...`).  Read-only — used by the History view. */
export interface CommitFileChange {
  path: VfsPath;
  status: "added" | "modified" | "removed";
}

const REPO_RELATIVE = (path: VfsPath): string => path.replace(/^\//, "");
const ABSOLUTE = (filepath: string): VfsPath =>
  filepath.startsWith("/") ? filepath : `/${filepath}`;

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

  /** Read a `/workspace/...` file as it existed at `ref` (default `HEAD`) —
   *  the last-committed baseline, ignoring uncommitted working-tree edits.
   *  Since the playground auto-commits on save, `HEAD` is the last saved
   *  state, so the evolution diff (live source vs this) is the "changes
   *  since I last saved" view.  Returns `undefined` when the ref or path
   *  is absent — an empty repo with no commits yet, or a file that exists
   *  only in the working tree — which the caller reads as "no baseline". */
  async readFileAtRef(path: VfsPath, ref = "HEAD"): Promise<string | undefined> {
    const norm = normalizePath(path);
    try {
      const oid = await git.resolveRef({ fs: this.fsc, dir: this.dir, ref });
      const { blob } = await git.readBlob({
        fs: this.fsc,
        dir: this.dir,
        oid,
        filepath: REPO_RELATIVE(norm),
      });
      return new TextDecoder().decode(blob);
    } catch {
      return undefined;
    }
  }

  /** The `/workspace` files a commit changed relative to its first parent
   *  (added / modified / removed).  A root commit (no parent) reports
   *  every file as `added`.  Read-only: walks the two commit trees and
   *  compares blob oids — commits here are linear (no merges), so the
   *  first parent is the exact base.  Used by the History view. */
  async commitChanges(oid: string): Promise<CommitFileChange[]> {
    const { commit } = await git.readCommit({ fs: this.fsc, dir: this.dir, oid });
    const parent = commit.parent[0];
    const trees = parent
      ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })]
      : [git.TREE({ ref: oid })];
    const out: CommitFileChange[] = [];
    await git.walk({
      fs: this.fsc,
      dir: this.dir,
      trees,
      map: async (filepath, entries) => {
        if (filepath === ".") return;
        const abs = ABSOLUTE(filepath);
        // Only surface tracked workspace content; never the bootstrapped
        // empty `/workspace` dir node itself.
        if (!abs.startsWith("/workspace/")) return;
        if (parent) {
          const [A, B] = entries as Array<git.WalkerEntry | null>;
          const aBlob = A && (await A.type()) === "blob";
          const bBlob = B && (await B.type()) === "blob";
          if (!aBlob && !bBlob) return; // dirs/trees
          if (!aBlob) out.push({ path: abs, status: "added" });
          else if (!bBlob) out.push({ path: abs, status: "removed" });
          else if ((await A.oid()) !== (await B.oid()))
            out.push({ path: abs, status: "modified" });
        } else {
          const [A] = entries as Array<git.WalkerEntry | null>;
          if (A && (await A.type()) === "blob") out.push({ path: abs, status: "added" });
        }
      },
    });
    out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return out;
  }

  /** Restore the `/workspace` tree to the state captured by commit `oid`
   *  — overwrite/add every file from that commit and delete workspace
   *  files it didn't contain.  Content-based (read the commit's blobs and
   *  write them), so it doesn't depend on git checkout's stat shortcut and
   *  never moves HEAD: the caller commits the restored state as a new
   *  commit, keeping history linear and recoverable.  Returns the absolute
   *  paths it changed. */
  async restoreCommit(oid: string): Promise<VfsPath[]> {
    // Target = the commit's /workspace blobs.
    const target = new Map<VfsPath, string>();
    await git.walk({
      fs: this.fsc,
      dir: this.dir,
      trees: [git.TREE({ ref: oid })],
      map: async (filepath, entries) => {
        if (filepath === ".") return;
        const abs = ABSOLUTE(filepath);
        if (!abs.startsWith("/workspace/")) return;
        const [entry] = entries as Array<git.WalkerEntry | null>;
        if (entry && (await entry.type()) === "blob") {
          const { blob } = await git.readBlob({
            fs: this.fsc,
            dir: this.dir,
            oid: await entry.oid(),
          });
          target.set(abs, new TextDecoder().decode(blob));
        }
      },
    });

    const changed: VfsPath[] = [];
    // Delete current workspace files absent from the target.
    for (const node of await this.walkTree()) {
      if (node.kind !== "file" || !node.path.startsWith("/workspace/")) continue;
      if (!target.has(node.path)) {
        await this.deleteFile(node.path);
        changed.push(node.path);
      }
    }
    // Write/overwrite the target files that differ.
    for (const [path, content] of target) {
      if ((await this.readFile(path)) !== content) {
        await this.writeFile(path, content);
        changed.push(path);
      }
    }
    return changed;
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
