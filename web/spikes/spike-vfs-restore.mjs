// THROWAWAY SPIKE (Phase P4).  tsx.  Not wired into the app.
//
// Verifies RestorableVfs.restore() semantics on MemoryVfs — the
// foundation of the tab-suspension fix: snapshot a session, mutate,
// then atomically restore and confirm the VFS matches the snapshot
// exactly (removals included) with ONE subscriber notification.

import { MemoryVfs } from "../src/vfs/memory-vfs.ts";

const log = (...a) => console.log(...a);
let ok = true;
const check = (label, cond) => {
  log(`  ${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) ok = false;
};

const vfs = new MemoryVfs();
vfs.write("/workspace/main.ddd", "system Sales {}");
vfs.write("/gen/http/index.ts", "export const a=1;");
const snap = [...vfs.snapshot()];

// Mutate after snapshot: change one, add one, (will be dropped on restore).
vfs.write("/workspace/main.ddd", "system Sales { module M {} }");
vfs.write("/gen/extra.ts", "TEMP");
vfs.delete("/gen/http/index.ts");

// Subscribe, then restore — expect exactly one fan-out covering the
// changed (main.ddd), removed-after-snapshot (extra.ts), and
// re-added (http/index.ts) paths.
let fanouts = 0;
let lastChanged = [];
const off = vfs.subscribe("/", (changed) => {
  fanouts++;
  lastChanged = [...changed];
});
vfs.restore(snap);
off();

check("single notification on restore", fanouts === 1);
check(
  "notification covers changed+readded+dropped",
  ["/gen/extra.ts", "/gen/http/index.ts", "/workspace/main.ddd"].every((p) =>
    lastChanged.includes(p),
  ),
);
check(
  "main.ddd restored to snapshot content",
  vfs.read("/workspace/main.ddd") === "system Sales {}",
);
check("dropped-by-snapshot extra.ts removed", !vfs.exists("/gen/extra.ts"));
check(
  "deleted-then-snapshot http/index.ts back",
  vfs.read("/gen/http/index.ts") === "export const a=1;",
);
check(
  "snapshot() now equals the restored snapshot",
  JSON.stringify([...vfs.snapshot()].sort()) === JSON.stringify(snap.sort()),
);

log("");
log(ok ? "PASS — RestorableVfs.restore() round-trips atomically. P4 VFS foundation verified." : "FAIL — restore semantics wrong.");
process.exit(ok ? 0 : 1);
