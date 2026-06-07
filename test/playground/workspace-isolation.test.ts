import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { GitStore, openGitFs } from "../../web/src/workspace/git/index.js";
import { gitDbForId } from "../../web/src/workspace/registry.js";

// ---------------------------------------------------------------------------
// The multi-workspace feature rests on one property: each workspace is a
// fully isolated, IndexedDB-backed git store keyed by DB name, and content
// inside every one still lives at /workspace/...  Switching workspaces is
// "open a different store" — so two stores must never see each other's
// files, and reopening a store by the same name must restore its content.
// This pins that contract at the storage layer (the React hook is a thin
// shell over exactly this).
// ---------------------------------------------------------------------------

async function open(id: string): Promise<GitStore> {
  return new GitStore(await openGitFs(gitDbForId(id)));
}

describe("workspace store isolation", () => {
  it("keeps two workspaces' /workspace/main.ddd independent", async () => {
    const a = await open("ws-a");
    const b = await open("ws-b");

    await a.writeFile("/workspace/main.ddd", "context A {}");
    await b.writeFile("/workspace/main.ddd", "context B {}");

    expect(await a.readFile("/workspace/main.ddd")).toBe("context A {}");
    expect(await b.readFile("/workspace/main.ddd")).toBe("context B {}");
  });

  it("a workspace doesn't see another's companion files", async () => {
    const a = await open("ws-c");
    const b = await open("ws-d");
    await a.writeFile("/workspace/shared/money.ddd", "valueobject Money {}");

    expect(await a.list("/workspace/")).toContain("/workspace/shared/money.ddd");
    expect(await b.list("/workspace/")).not.toContain("/workspace/shared/money.ddd");
  });

  it("reopening a workspace by id restores its persisted content", async () => {
    const first = await open("ws-persist");
    await first.writeFile("/workspace/main.ddd", "context Persisted {}");

    // Reopen the same DB name — simulates a workspace switch away and back,
    // or a page reload.  openGitFs is idempotent and reattaches the repo.
    const again = await open("ws-persist");
    expect(await again.readFile("/workspace/main.ddd")).toBe("context Persisted {}");
  });
});
