import * as path from "node:path";

/** True when a generated file key would resolve OUTSIDE `outDir` — i.e. an
 *  absolute key or one that climbs out via `..`.  The CLI write loop rejects
 *  such keys before any filesystem touch, so a generator (in particular an
 *  untrusted, out-of-tree backend / design pack) cannot write anywhere on
 *  disk.  Pure — no filesystem access, just path arithmetic.
 *
 *  A key that resolves to the out dir itself (`""` / `.`) also escapes: it is
 *  not a file *inside* the tree. */
export function escapesOutDir(outDir: string, relPath: string): boolean {
  const resolvedOut = path.resolve(outDir);
  const rel = path.relative(resolvedOut, path.resolve(resolvedOut, relPath));
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
}
