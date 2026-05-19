// Dependency-tree planner (Phase B3).
//
// Pragmatic, flat install: BFS from the generated package.json's
// `dependencies`, pick the highest version satisfying each range,
// dedupe by name (flat — highest wins).  Sufficient for the curated
// stacks Loom emits (hono / drizzle / zod / pglite / react /
// mantine), which don't have conflicting nested trees.
//
// Deliberately out of scope for B3 (documented, revisited in B4 if a
// real dep needs it): nested version conflicts, peerDependencies
// auto-install (curated stacks carry their peers as top-level deps;
// drizzle's 28 peers are optional DB drivers we don't use).

import { fetchPackument, type Packument, type VersionMeta } from "./registry.js";
import { maxSatisfying } from "./semver.js";

export interface PlannedPackage {
  name: string;
  version: string;
  meta: VersionMeta;
}

export async function planInstall(
  rootDeps: Record<string, string>,
): Promise<Map<string, PlannedPackage>> {
  const chosen = new Map<string, PlannedPackage>();
  const packuments = new Map<string, Packument>();
  const queue: Array<[string, string]> = Object.entries(rootDeps);

  while (queue.length) {
    const [name, range] = queue.shift()!;
    let pack = packuments.get(name);
    if (!pack) {
      pack = await fetchPackument(name);
      packuments.set(name, pack);
    }
    const version = maxSatisfying(Object.keys(pack.versions), range);
    if (!version) {
      throw new Error(
        `[npm-in-browser] no version of "${name}" satisfies "${range}"`,
      );
    }
    const prev = chosen.get(name);
    // Flat dedupe: only (re)descend when this is a new pick or a
    // higher version than what we already planned.
    if (prev && prev.version === version) continue;
    if (prev && maxSatisfying([prev.version, version], `>=${prev.version}`) === prev.version && prev.version !== version) {
      // already have an equal-or-higher pin; skip
      continue;
    }
    const meta = pack.versions[version];
    chosen.set(name, { name, version, meta });
    for (const [dn, dr] of Object.entries(meta.dependencies ?? {})) {
      queue.push([dn, dr]);
    }
  }
  return chosen;
}
