// ---------------------------------------------------------------------------
// In-memory implementation of the `Vfs` interface.
//
// Backed by a single `Map<VfsPath, VfsEntry>` plus a small pub/sub
// for prefix-scoped listeners.  No persistence — Phase 3's
// `IdbVfs` decorator wraps this with IndexedDB hydrate/flush.
//
// Sorted listing is computed on demand from the Map's keys; for
// playground-scale workspaces (low hundreds of paths) the cost is
// negligible.  If listing ever becomes hot, switch to a sorted
// secondary index keyed off the same Map.
//
// Directory semantics: directories are first-class entries created
// via `mkdir` / removed via `rmdir`.  Writing a file does NOT
// materialise dir entries for its ancestors — intermediate folders
// are inferred by tree-rendering consumers from path strings.  The
// dir-entry concept exists only so an *empty* folder is
// representable; populated folders need no dir entry.
// ---------------------------------------------------------------------------

import type {
  RestorableVfs,
  VfsEntry,
  VfsEntryKind,
  VfsListener,
  VfsPath,
} from "./types.js";

/** Normalise a VFS path: enforce leading `/`, collapse `..` and `.`,
 *  and reject any path that escapes the root.  The escape check
 *  matters because VFS paths come from user-supplied `.ddd` source
 *  (`design: "../../etc/passwd"`) and from main-thread-relayed
 *  writes — both untrusted inputs in a sandbox model. */
function normalize(path: VfsPath): VfsPath {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`vfs: empty path`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`vfs: path must be absolute (leading "/"): "${path}"`);
  }
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        throw new Error(`vfs: path escapes root: "${path}"`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

interface Subscription {
  prefix: VfsPath;
  listener: VfsListener;
}

/** Normalise the mixed `VfsEntry | [path, content]` shape `hydrate`
 *  and `restore` accept into a clean `VfsEntry` so the storage path
 *  doesn't have to branch.  Legacy tuple form is treated as a file
 *  (the only shape `hydrate` carried before directories existed). */
function asEntry(item: VfsEntry | readonly [VfsPath, string]): VfsEntry {
  if (Array.isArray(item)) {
    return { kind: "file", path: item[0] as VfsPath, content: item[1] as string };
  }
  return item as VfsEntry;
}

export class MemoryVfs implements RestorableVfs {
  private readonly entries = new Map<VfsPath, VfsEntry>();
  private readonly subs = new Set<Subscription>();

  read(path: VfsPath): string | undefined {
    const e = this.entries.get(normalize(path));
    return e?.kind === "file" ? e.content : undefined;
  }

  readRequired(path: VfsPath): string {
    const norm = normalize(path);
    const e = this.entries.get(norm);
    if (!e || e.kind !== "file") {
      throw new Error(`vfs: no entry at "${norm}"`);
    }
    return e.content;
  }

  write(path: VfsPath, content: string): void {
    const norm = normalize(path);
    const existing = this.entries.get(norm);
    if (existing && existing.kind === "dir") {
      throw new Error(
        `vfs: path "${norm}" is a directory; rmdir it before writing a file at the same path`,
      );
    }
    this.entries.set(norm, { kind: "file", path: norm, content });
    this.notify([norm]);
  }

  delete(path: VfsPath): void {
    const norm = normalize(path);
    const existing = this.entries.get(norm);
    // File-only delete — silently ignore both "missing" and "is a
    // directory".  Callers that want to remove a directory use
    // `rmdir`; the asymmetry stops a `for (const p of list(prefix))
    // delete(p)` loop from accidentally dropping folder entries.
    if (!existing || existing.kind !== "file") return;
    this.entries.delete(norm);
    this.notify([norm]);
  }

  mkdir(path: VfsPath): void {
    const norm = normalize(path);
    const existing = this.entries.get(norm);
    if (existing) {
      if (existing.kind === "dir") return; // idempotent
      throw new Error(
        `vfs: path "${norm}" is a file; cannot mkdir over it`,
      );
    }
    // mkdirp — walk parents first, oldest-to-youngest, so children
    // never appear before their parent.  Notify once with the full
    // affected set.
    const created: VfsPath[] = [];
    const segments = norm.split("/").filter((s) => s.length > 0);
    let cur = "";
    for (const seg of segments) {
      cur = `${cur}/${seg}`;
      const e = this.entries.get(cur);
      if (e) {
        if (e.kind !== "dir") {
          throw new Error(
            `vfs: cannot mkdir "${norm}" — ancestor "${cur}" is a file`,
          );
        }
        continue;
      }
      this.entries.set(cur, { kind: "dir", path: cur });
      created.push(cur);
    }
    if (created.length > 0) {
      created.sort();
      this.notify(created);
    }
  }

  rmdir(path: VfsPath): void {
    const norm = normalize(path);
    const existing = this.entries.get(norm);
    if (!existing || existing.kind !== "dir") return;
    // Refuse to remove a non-empty directory.  Children are any
    // path that starts with `<norm>/` — note we don't conflate a
    // sibling like `<norm>2` with a child.
    const prefix = `${norm}/`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        throw new Error(
          `vfs: directory "${norm}" is not empty (contains "${key}")`,
        );
      }
    }
    this.entries.delete(norm);
    this.notify([norm]);
  }

  exists(path: VfsPath): boolean {
    return this.entries.has(normalize(path));
  }

  isFile(path: VfsPath): boolean {
    return this.entries.get(normalize(path))?.kind === "file";
  }

  isDirectory(path: VfsPath): boolean {
    return this.entries.get(normalize(path))?.kind === "dir";
  }

  kindOf(path: VfsPath): VfsEntryKind | undefined {
    return this.entries.get(normalize(path))?.kind;
  }

  list(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.listFiltered(prefix, "file");
  }

  listDirs(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.listFiltered(prefix, "dir");
  }

  listAll(prefix: VfsPath): ReadonlyArray<VfsPath> {
    return this.listFiltered(prefix, undefined);
  }

  private listFiltered(
    prefix: VfsPath,
    kindFilter: VfsEntryKind | undefined,
  ): ReadonlyArray<VfsPath> {
    // Always interpret the prefix as a directory boundary —
    // `list("/workspace")` and `list("/workspace/")` return the
    // same set, both treating the prefix as the parent dir.
    // Avoiding the literal-startsWith fallback keeps the semantics
    // unambiguous: `list("/workspace/main")` cannot accidentally
    // match `/workspace/main.ddd` AND `/workspace/maintenance.ddd`,
    // which surprised exactly nobody when the early Phase 1 design
    // tried it.  Callers wanting glob-style matches can filter the
    // returned list themselves.
    const norm = normalize(prefix);
    const out: VfsPath[] = [];
    for (const [key, entry] of this.entries) {
      if (kindFilter !== undefined && entry.kind !== kindFilter) continue;
      if (norm === "/" || key === norm || key.startsWith(norm + "/")) {
        out.push(key);
      }
    }
    out.sort();
    return out;
  }

  subscribe(prefix: VfsPath, listener: VfsListener): () => void {
    const sub: Subscription = { prefix: normalize(prefix), listener };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  hydrate(entries: Iterable<VfsEntry | readonly [VfsPath, string]>): void {
    const changed: VfsPath[] = [];
    for (const item of entries) {
      const entry = asEntry(item);
      const norm = normalize(entry.path);
      // Preserve the normalised path on the stored entry so a
      // round-trip `snapshot` doesn't surface the pre-normalised
      // form a caller may have passed in.
      const stored: VfsEntry =
        entry.kind === "file"
          ? { kind: "file", path: norm, content: entry.content }
          : { kind: "dir", path: norm };
      this.entries.set(norm, stored);
      changed.push(norm);
    }
    if (changed.length > 0) {
      changed.sort();
      this.notify(changed);
    }
  }

  snapshot(): ReadonlyMap<VfsPath, VfsEntry> {
    return new Map(this.entries);
  }

  restore(entries: Iterable<VfsEntry | readonly [VfsPath, string]>): void {
    // Atomic replace: union of old + new keys is the affected set so
    // subscribers see removals as well as adds/changes in one fan-out.
    const affected = new Set<VfsPath>(this.entries.keys());
    this.entries.clear();
    for (const item of entries) {
      const entry = asEntry(item);
      const norm = normalize(entry.path);
      const stored: VfsEntry =
        entry.kind === "file"
          ? { kind: "file", path: norm, content: entry.content }
          : { kind: "dir", path: norm };
      this.entries.set(norm, stored);
      affected.add(norm);
    }
    if (affected.size > 0) this.notify([...affected].sort());
  }

  private notify(changed: ReadonlyArray<VfsPath>): void {
    for (const sub of this.subs) {
      // Fan out paths matching the subscriber's prefix.  Single-path
      // writes are the common case; the inner loop is fine.
      let matched: VfsPath[] | null = null;
      for (const p of changed) {
        if (sub.prefix === "/" || p === sub.prefix || p.startsWith(sub.prefix + "/")) {
          (matched ??= []).push(p);
        }
      }
      if (matched) sub.listener(matched);
    }
  }
}
