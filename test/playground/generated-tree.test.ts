import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import {
  applyGeneratedTree,
  GENERATED_PREFIX,
  GitStore,
  openGitFs,
  readGeneratedTree,
  type GeneratedFile,
} from "../../web/src/workspace/git/index.js";

// ---------------------------------------------------------------------------
// applyGeneratedTree — per-file 3-way merge of generated output into the
// workspace ("scaffold then own").  Generated files land under
// /workspace/generated/**; regeneration preserves hand edits and surfaces
// genuine both-changed conflicts as markers, never dropping a user edit.
// ---------------------------------------------------------------------------

let dbCounter = 0;
function uniqueDbName(): string {
  return `loom-gen-test-${++dbCounter}`;
}

async function freshStore(): Promise<GitStore> {
  return new GitStore(await openGitFs(uniqueDbName()));
}

function gen(path: string, content: string): GeneratedFile {
  return { path, content };
}

async function read(store: GitStore, rel: string): Promise<string | undefined> {
  return store.readFile(GENERATED_PREFIX + rel);
}

describe("applyGeneratedTree", () => {
  let store: GitStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  it("first generate writes the whole tree under /workspace/generated", async () => {
    const res = await applyGeneratedTree(store, [
      gen("app/domain/product.ts", "export const a = 1;"),
      gen("app/http/index.ts", "export const server = true;"),
    ]);
    expect(await read(store, "app/domain/product.ts")).toBe("export const a = 1;");
    expect(await read(store, "app/http/index.ts")).toBe("export const server = true;");
    expect(res.written.sort()).toEqual([
      "/workspace/generated/app/domain/product.ts",
      "/workspace/generated/app/http/index.ts",
    ]);
    expect(res.conflicted).toEqual([]);
  });

  it("regenerate takes new output for files the user didn't touch", async () => {
    await applyGeneratedTree(store, [gen("a.ts", "v1")]);
    const res = await applyGeneratedTree(store, [gen("a.ts", "v2")]);
    expect(await read(store, "a.ts")).toBe("v2");
    expect(res.written).toContain("/workspace/generated/a.ts");
    expect(res.conflicted).toEqual([]);
  });

  it("keeps a hand edit when the generator output is unchanged", async () => {
    await applyGeneratedTree(store, [gen("a.ts", "gen-v1")]);
    // user hand-edits the generated file
    await store.writeFile(GENERATED_PREFIX + "a.ts", "hand-edited");
    // regenerate with the SAME output as before
    const res = await applyGeneratedTree(store, [gen("a.ts", "gen-v1")]);
    expect(await read(store, "a.ts")).toBe("hand-edited");
    expect(res.preserved).toContain("/workspace/generated/a.ts");
    expect(res.conflicted).toEqual([]);
  });

  it("conflict-marks a file the user AND the generator both changed", async () => {
    await applyGeneratedTree(store, [gen("a.ts", "base")]);
    await store.writeFile(GENERATED_PREFIX + "a.ts", "user version");
    const res = await applyGeneratedTree(store, [gen("a.ts", "regenerated version")]);
    expect(res.conflicted).toEqual(["/workspace/generated/a.ts"]);
    const merged = (await read(store, "a.ts"))!;
    expect(merged).toContain("<<<<<<< your edits");
    expect(merged).toContain("user version");
    expect(merged).toContain("=======");
    expect(merged).toContain("regenerated version");
    expect(merged).toContain(">>>>>>> regenerated");
  });

  it("deletes an untouched file the generator stops emitting", async () => {
    await applyGeneratedTree(store, [gen("keep.ts", "k"), gen("gone.ts", "g")]);
    const res = await applyGeneratedTree(store, [gen("keep.ts", "k")]);
    expect(await read(store, "gone.ts")).toBeUndefined();
    expect(res.deleted).toEqual(["/workspace/generated/gone.ts"]);
    expect(await read(store, "keep.ts")).toBe("k");
  });

  it("keeps a hand-edited file the generator stops emitting", async () => {
    await applyGeneratedTree(store, [gen("orphan.ts", "g")]);
    await store.writeFile(GENERATED_PREFIX + "orphan.ts", "adopted by user");
    const res = await applyGeneratedTree(store, []); // generator emits nothing now
    expect(await read(store, "orphan.ts")).toBe("adopted by user");
    expect(res.preserved).toContain("/workspace/generated/orphan.ts");
  });

  it("commits each generate so history accrues", async () => {
    await applyGeneratedTree(store, [gen("a.ts", "v1")]);
    await applyGeneratedTree(store, [gen("a.ts", "v2")]);
    const log = await store.log();
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[0].message).toContain("regenerate");
  });

  it("advances the base so the next regenerate diffs against the latest output", async () => {
    // gen v1, user edits, regen v2 (conflict), resolve, regen v2 again →
    // now base is v2 so an untouched file takes the newest output cleanly.
    await applyGeneratedTree(store, [gen("a.ts", "v1")]);
    await applyGeneratedTree(store, [gen("a.ts", "v2")]); // base advances to v2
    // user has NOT touched it; regen v3 should take v3 (proves base==v2,
    // not still v1 — otherwise this would be a false conflict).
    const res = await applyGeneratedTree(store, [gen("a.ts", "v3")]);
    expect(await read(store, "a.ts")).toBe("v3");
    expect(res.conflicted).toEqual([]);
    expect(res.written).toContain("/workspace/generated/a.ts");
  });

  it("readGeneratedTree returns the merged tree (incl. hand edits) as relative files", async () => {
    await applyGeneratedTree(store, [gen("a.ts", "gen-a"), gen("b.ts", "gen-b")]);
    // hand-edit one generated file
    await store.writeFile(GENERATED_PREFIX + "a.ts", "hand-edited-a");
    const tree = await readGeneratedTree(store);
    const byPath = Object.fromEntries(tree.map((f) => [f.path, f.content]));
    expect(byPath["a.ts"]).toBe("hand-edited-a"); // edit reflected
    expect(byPath["b.ts"]).toBe("gen-b");
    // paths are project-relative (no /workspace/generated/ prefix)
    expect(tree.every((f) => !f.path.startsWith("/"))).toBe(true);
  });

  it("does not commit when commit:false", async () => {
    await applyGeneratedTree(store, [gen("a.ts", "v1")], { commit: false });
    // working tree has the file, but no commit was made
    expect(await read(store, "a.ts")).toBe("v1");
    await expect(store.log()).rejects.toBeTruthy(); // no HEAD/commits yet
  });
});
