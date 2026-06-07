import { describe, expect, it } from "vitest";
import { DEFAULT_GIT_DB } from "../../web/src/workspace/git/index.js";
import {
  activeWorkspace,
  addWorkspace,
  DEFAULT_WORKSPACE_ID,
  defaultRegistry,
  gitDbForId,
  removeWorkspace,
  renameWorkspace,
  sanitizeRegistry,
  setActive,
  type WorkspaceRegistry,
} from "../../web/src/workspace/registry.js";

// ---------------------------------------------------------------------------
// The pure registry transitions that back the multi-workspace switcher.
// localStorage is exercised separately via the hook; here we pin the
// state-machine semantics that make workspace switching stable.
// ---------------------------------------------------------------------------

describe("workspace registry", () => {
  it("defaults to a single legacy-backed workspace", () => {
    const reg = defaultRegistry(100);
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.activeId).toBe(DEFAULT_WORKSPACE_ID);
    expect(activeWorkspace(reg).gitDb).toBe(DEFAULT_GIT_DB);
  });

  it("maps only the default id onto the legacy git DB", () => {
    expect(gitDbForId(DEFAULT_WORKSPACE_ID)).toBe(DEFAULT_GIT_DB);
    expect(gitDbForId("abc123")).toBe("loom-ws-abc123");
  });

  it("adds a workspace, makes it active, and gives it a namespaced DB", () => {
    const { reg, meta } = addWorkspace(defaultRegistry(1), "Catalog", 2);
    expect(reg.workspaces).toHaveLength(2);
    expect(reg.activeId).toBe(meta.id);
    expect(meta.name).toBe("Catalog");
    expect(meta.gitDb).toBe(gitDbForId(meta.id));
    expect(meta.id).not.toBe(DEFAULT_WORKSPACE_ID);
  });

  it("blank names fall back to a placeholder", () => {
    const { meta } = addWorkspace(defaultRegistry(1), "   ", 2);
    expect(meta.name).toBe("Untitled workspace");
  });

  it("renames by id and leaves others untouched", () => {
    const { reg, meta } = addWorkspace(defaultRegistry(1), "Catalog", 2);
    const renamed = renameWorkspace(reg, meta.id, "Orders");
    expect(activeWorkspace(renamed).name).toBe("Orders");
    expect(renamed.workspaces[0].name).toBe("My workspace");
  });

  it("removing the active workspace re-points active to a survivor", () => {
    const { reg, meta } = addWorkspace(defaultRegistry(1), "Catalog", 2);
    const after = removeWorkspace(reg, meta.id);
    expect(after.workspaces).toHaveLength(1);
    expect(after.activeId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("refuses to remove the last workspace", () => {
    const reg = defaultRegistry(1);
    expect(removeWorkspace(reg, DEFAULT_WORKSPACE_ID)).toBe(reg);
  });

  it("setActive ignores unknown ids", () => {
    const reg = defaultRegistry(1);
    expect(setActive(reg, "nope")).toBe(reg);
    const { reg: reg2, meta } = addWorkspace(reg, "Catalog", 2);
    expect(setActive(reg2, meta.id).activeId).toBe(meta.id);
  });

  it("sanitizes malformed payloads back to a valid registry", () => {
    // `sanitizeRegistry` stamps `createdAt: Date.now()` for the default
    // workspace it falls back to; comparing against a separately-built
    // `defaultRegistry()` races on that millisecond.  Pin the expected
    // registry to the timestamp the sanitizer actually produced so the
    // assertion is deterministic.
    for (const malformed of [null, { workspaces: [] }, { workspaces: [{ id: "x" }] }]) {
      const reg = sanitizeRegistry(malformed);
      expect(reg).toEqual(defaultRegistry(reg.workspaces[0].createdAt));
    }
  });

  it("sanitizes a stale activeId to a present workspace", () => {
    const malformed: unknown = {
      workspaces: [{ id: "a", name: "A", gitDb: "loom-ws-a", createdAt: 1 }],
      activeId: "gone",
    };
    const reg = sanitizeRegistry(malformed) as WorkspaceRegistry;
    expect(reg.activeId).toBe("a");
  });
});
