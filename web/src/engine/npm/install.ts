// Install orchestrator (Phase B3).
//
// rootDeps → plan → fetch+extract every package into a flat
// node_modules under `nmRoot`, via a caller-supplied byte sink (the
// playground VFS in the engine; an in-memory Map in the spike).
//
// The optional cache lets a name@version that was extracted once be
// replayed without re-fetching — the hook the IDB/snapshot warm-boot
// (B3c / P4) plugs into.  Tarball fetches run with bounded
// concurrency so a big stack doesn't open 100+ sockets at once.

import { fetchTarball } from "./registry.js";
import { planInstall, type PlannedPackage } from "./resolve-tree.js";
import { gunzip, untar, type TarEntry } from "./targz.js";

export interface InstallCache {
  get(key: string): TarEntry[] | undefined;
  set(key: string, entries: TarEntry[]): void;
}

export interface InstallResult {
  /** name → resolved version actually written. */
  versions: Map<string, string>;
  fileCount: number;
}

async function extract(pkg: PlannedPackage): Promise<TarEntry[]> {
  const tgz = await fetchTarball(pkg.meta.dist.tarball);
  return untar(await gunzip(tgz));
}

export async function install(
  rootDeps: Record<string, string>,
  write: (path: string, data: Uint8Array) => void,
  opts: { nmRoot?: string; cache?: InstallCache; concurrency?: number } = {},
): Promise<InstallResult> {
  const nmRoot = opts.nmRoot ?? "/node_modules";
  const concurrency = opts.concurrency ?? 8;
  const plan = [...(await planInstall(rootDeps)).values()];
  const versions = new Map<string, string>();
  let fileCount = 0;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < plan.length) {
      const pkg = plan[cursor++];
      const key = `${pkg.name}@${pkg.version}`;
      let entries = opts.cache?.get(key);
      if (!entries) {
        entries = await extract(pkg);
        opts.cache?.set(key, entries);
      }
      for (const e of entries) {
        write(`${nmRoot}/${pkg.name}/${e.name}`, e.data);
        fileCount++;
      }
      versions.set(pkg.name, pkg.version);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, plan.length) }, worker),
  );
  return { versions, fileCount };
}
