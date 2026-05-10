// ---------------------------------------------------------------------------
// In-memory implementation of the `Vfs` interface.
//
// Backed by a single `Map<VfsPath, string>` plus a small pub/sub for
// prefix-scoped listeners.  No persistence — Phase 3's `IdbVfs`
// decorator wraps this with IndexedDB hydrate/flush.
//
// Sorted listing is computed on demand from the Map's keys; for
// playground-scale workspaces (low hundreds of paths) the cost is
// negligible.  If listing ever becomes hot, switch to a sorted
// secondary index keyed off the same Map.
// ---------------------------------------------------------------------------

import type { Vfs, VfsListener, VfsPath } from "./types.js";

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

export class MemoryVfs implements Vfs {
  private readonly entries = new Map<VfsPath, string>();
  private readonly subs = new Set<Subscription>();

  read(path: VfsPath): string | undefined {
    return this.entries.get(normalize(path));
  }

  readRequired(path: VfsPath): string {
    const norm = normalize(path);
    const v = this.entries.get(norm);
    if (v == null) {
      throw new Error(`vfs: no entry at "${norm}"`);
    }
    return v;
  }

  write(path: VfsPath, content: string): void {
    const norm = normalize(path);
    this.entries.set(norm, content);
    this.notify([norm]);
  }

  delete(path: VfsPath): void {
    const norm = normalize(path);
    if (!this.entries.delete(norm)) return;
    this.notify([norm]);
  }

  exists(path: VfsPath): boolean {
    return this.entries.has(normalize(path));
  }

  list(prefix: VfsPath): ReadonlyArray<VfsPath> {
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
    for (const key of this.entries.keys()) {
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

  hydrate(entries: Iterable<readonly [VfsPath, string]>): void {
    const changed: VfsPath[] = [];
    for (const [path, content] of entries) {
      const norm = normalize(path);
      this.entries.set(norm, content);
      changed.push(norm);
    }
    if (changed.length > 0) {
      changed.sort();
      this.notify(changed);
    }
  }

  snapshot(): ReadonlyMap<VfsPath, string> {
    return new Map(this.entries);
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
