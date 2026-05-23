import type { LangiumDocument } from "langium";
import { URI } from "langium";
import type { LangiumSharedServices } from "langium/lsp";
import { isModel, type Model } from "../../../src/language/generated/ast.js";
import type { Vfs, VfsPath } from "../vfs/types.js";

/**
 * Browser-side equivalent of the Node CLI's `loadProject`
 * (`src/language/project-loader.ts`).  Reads `.ddd` source from the
 * worker's `MemoryVfs` instead of `node:fs`, walks transitive
 * `import "./other.ddd"` statements from `entryPath`, registers every
 * reachable document with Langium's workspace, and runs them through
 * one `DocumentBuilder.build(...)` call so cross-document references
 * resolve through Langium's standard machinery.
 *
 * Returns the entry document plus every reachable document (the
 * entry first, then imports in discovery order, deduplicated by
 * absolute VFS path).  Throws on missing imports or cycles with a
 * clear message so the worker can surface them as diagnostics.
 *
 * The CLI loader and this one diverge on exactly one thing — IO.
 * Path-walking semantics, URI assignment, and dedup are identical so
 * the merged Loom IR is structurally indistinguishable between
 * environments.
 */
export async function loadProjectFromVfs(
  entryPath: VfsPath,
  shared: LangiumSharedServices,
  vfs: Vfs,
): Promise<{ entry: LangiumDocument<Model>; all: LangiumDocument<Model>[] }> {
  const docs = shared.workspace.LangiumDocuments;
  const visited = new Map<VfsPath, LangiumDocument<Model>>();
  const inProgress = new Set<VfsPath>();

  const resolved = resolveVfsPath(entryPath);
  if (vfs.read(resolved) == null) {
    throw new Error(`.ddd entry not found in VFS: "${resolved}"`);
  }

  function walk(absPath: VfsPath, chain: VfsPath[]): LangiumDocument<Model> {
    const existing = visited.get(absPath);
    if (existing) return existing;
    if (inProgress.has(absPath)) {
      throw new Error(
        `circular .ddd import detected: ${[...chain, absPath].join(" → ")}`,
      );
    }
    inProgress.add(absPath);

    const text = vfs.read(absPath);
    if (text == null) {
      throw new Error(
        `.ddd import not found in VFS: "${absPath}"` +
          (chain.length > 0 ? ` (imported by ${chain[chain.length - 1]})` : ""),
      );
    }

    // The Langium document URI must round-trip through workspace
    // lookups — keep it deterministic per VFS path so a second
    // generate of the same project hits the same document set.
    const uri = vfsPathToUri(absPath);
    // Delete-then-create so a re-generate after edits replays through
    // Langium's reset path rather than reusing a stale AST.  The Node
    // worker does the same for single-file generates.
    const existingDoc = docs.all.find((d) => d.uri.toString() === uri.toString());
    if (existingDoc) docs.deleteDocument(existingDoc.uri);
    const doc = docs.createDocument(uri, text) as LangiumDocument<Model>;
    const model = doc.parseResult?.value;

    if (model && isModel(model)) {
      const dir = posixDirname(absPath);
      for (const imp of model.imports ?? []) {
        const rawPath = imp.path;
        if (!rawPath) continue;
        const importedAbs = posixResolve(dir, rawPath);
        if (vfs.read(importedAbs) == null) {
          // Distinguish "path is a directory" from "path is just
          // missing" — both make `read` return undefined, but the
          // user-facing fix is very different.  Only check when
          // the VFS surfaces directory entries (back-compat with
          // the file-only Vfs interface).
          const isDir =
            "isDirectory" in vfs && typeof vfs.isDirectory === "function"
              ? vfs.isDirectory(importedAbs)
              : false;
          if (isDir) {
            throw new Error(
              `.ddd import "${rawPath}" (resolved to ${importedAbs}) is a directory — imported by ${absPath}.  Imports must point at a .ddd source file.`,
            );
          }
          throw new Error(
            `.ddd import not found in VFS: "${rawPath}" (resolved to ${importedAbs}) imported by ${absPath}`,
          );
        }
        walk(importedAbs, [...chain, absPath]);
      }
    }

    visited.set(absPath, doc);
    inProgress.delete(absPath);
    return doc;
  }

  const entry = walk(resolved, []);
  const all = [...visited.values()];
  await shared.workspace.DocumentBuilder.build(all, { validation: true });
  return { entry, all };
}

/** Stable URI for a VFS path so a re-generate replays through the
 *  same Langium document.  `inmemory:///` is the playground's
 *  convention (the single-file worker uses
 *  `inmemory:///main.ddd`); we extend it to encode the full VFS
 *  path so two files at different paths get different URIs. */
function vfsPathToUri(absPath: VfsPath): URI {
  // absPath always starts with `/`; strip the leading slash so the
  // resulting URI is `inmemory:///workspace/main.ddd`, not
  // `inmemory://///workspace/main.ddd`.
  return URI.parse(`inmemory:///${absPath.replace(/^\/+/, "")}`);
}

/** Normalise a VFS-style absolute path: enforce leading `/`, collapse
 *  `..` and `.`, reject root-escape.  Mirrors `MemoryVfs.normalize` so
 *  callers' paths round-trip identically. */
function resolveVfsPath(path: VfsPath): VfsPath {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("vfs project-loader: empty path");
  }
  if (!path.startsWith("/")) {
    throw new Error(`vfs project-loader: path must be absolute: "${path}"`);
  }
  return posixResolve("/", path);
}

function posixDirname(absPath: VfsPath): VfsPath {
  const lastSlash = absPath.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return absPath.substring(0, lastSlash);
}

/** POSIX `path.resolve(base, rel)` for absolute results.  Handles
 *  relative `./` and `../` segments and absolute `rel` inputs (the
 *  absolute case ignores `base`, matching node:path.posix.resolve). */
function posixResolve(base: VfsPath, rel: string): VfsPath {
  const combined = rel.startsWith("/") ? rel : `${base}/${rel}`;
  const parts: string[] = [];
  for (const seg of combined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) {
        throw new Error(`vfs project-loader: path escapes root: "${combined}"`);
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}
