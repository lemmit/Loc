// ---------------------------------------------------------------------------
// One-time migration: legacy IdbVfs workspace → git store.
//
// Before the git-backed store, the playground persisted `/workspace/**`
// last-write-wins in the `loom-workspace` IndexedDB via `IdbVfs`.  On
// first load after the migration, if the git workspace is still empty
// but that legacy IDB holds workspace content, import it into an initial
// commit so returning users don't lose their work.  Idempotent: once the
// git workspace has any content the import is skipped, so it runs at most
// once per browser.
//
// `IdbVfs` is retained solely as the read source for this import; its
// removal is the final cleanup PR.
// ---------------------------------------------------------------------------

import { IdbVfs } from "../../vfs/idb-vfs.js";
import { commitOnSave } from "./helpers.js";
import type { GitStore } from "./git-store.js";

/** Import the legacy `loom-workspace` IDB into `store` when the git
 *  workspace is empty.  Returns true if an import ran. */
export async function importLegacyIdbWorkspace(store: GitStore): Promise<boolean> {
  // Only seed a fresh git workspace — never clobber existing git content.
  const existing = await store.list("/workspace");
  if (existing.length > 0) return false;

  let legacy: IdbVfs;
  try {
    legacy = await IdbVfs.open();
  } catch {
    return false; // hostile storage — nothing to import
  }

  const entries = [...legacy.snapshot().values()].filter((e) =>
    e.path.startsWith("/workspace/"),
  );
  if (entries.length === 0) return false;

  for (const e of entries) {
    if (e.kind === "file") await store.writeFile(e.path, e.content);
    else await store.mkdir(e.path);
  }
  await commitOnSave(store, "import legacy workspace");
  return true;
}
