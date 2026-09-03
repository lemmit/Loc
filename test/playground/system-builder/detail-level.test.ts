import { describe, expect, it } from "vitest";
import type { ConstructNodeData } from "../../../web/src/builder/system-v2/ConstructNode.js";
import {
  applyDetailLevel,
  applyDetailLevelToAll,
  detailStorageKey,
  loadDetailLevel,
  saveDetailLevel,
} from "../../../web/src/builder/system-v2/detail-level.js";

// The Model pane's Names / Fields / Everything switch (M-T8.21 slice 4): a
// pure filter over the derived node data, persisted per view path.

const full: ConstructNodeData = {
  kind: "projection",
  name: "OrderTotals",
  color: "c",
  drillable: false,
  summary: ["from Order as o", "select o.total"],
  badges: [{ label: "requires", detail: "admin" }],
  inputs: [{ label: "requires", value: "", testid: "t", onCommit: () => {} }],
  selects: [{ label: "for", data: [], value: null, testid: "s", onChange: () => {} }],
  multiSelects: [{ label: "modules", data: [], value: [], testid: "m", onChange: () => {} }],
  actions: [{ label: "+ param", testid: "a", onClick: () => {} }],
  detailsLabel: "clauses",
  detailsOpen: true,
  onToggleDetails: () => {},
  expressionEditor: null,
  onToggleExpression: () => {},
  onRename: () => {},
  onDelete: () => {},
};

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe("applyDetailLevel", () => {
  it("everything is the identity — same reference, no churn", () => {
    expect(applyDetailLevel(full, "everything")).toBe(full);
  });

  it("names keeps kind + name + the edit handlers, drops every detail surface", () => {
    const out = applyDetailLevel(full, "names");
    expect(out.name).toBe("OrderTotals");
    expect(out.kind).toBe("projection");
    expect(out.onRename).toBe(full.onRename);
    expect(out.onDelete).toBe(full.onDelete);
    for (const k of [
      "summary",
      "badges",
      "inputs",
      "selects",
      "multiSelects",
      "actions",
      "detailsLabel",
      "detailsOpen",
      "onToggleDetails",
      "expressionEditor",
      "onToggleExpression",
    ] as const) {
      expect(out[k], k).toBeUndefined();
    }
  });

  it("fields keeps the summary lines and nothing else of the detail", () => {
    const out = applyDetailLevel(full, "fields");
    expect(out.summary).toEqual(["from Order as o", "select o.total"]);
    expect(out.badges).toBeUndefined();
    expect(out.inputs).toBeUndefined();
    expect(out.detailsLabel).toBeUndefined();
  });

  it("the root banner keeps everything at every level", () => {
    const root = { ...full, isRoot: true };
    expect(applyDetailLevel(root, "names")).toBe(root);
  });

  it("maps a whole node-data map", () => {
    const m = new Map([["a", full]]);
    expect(applyDetailLevelToAll(m, "names").get("a")?.summary).toBeUndefined();
    expect(applyDetailLevelToAll(m, "everything").get("a")).toBe(full);
  });
});

describe("persistence per view path", () => {
  const path = [{ kind: "context" as const, name: "Sales" }];

  it("defaults to everything; stores a departure; clears on everything", () => {
    const s = memStorage();
    expect(loadDetailLevel(path, s)).toBe("everything");
    saveDetailLevel(path, "names", s);
    expect(loadDetailLevel(path, s)).toBe("names");
    expect(s.getItem(detailStorageKey(path))).toBe("names");
    // A different view is untouched.
    expect(loadDetailLevel([], s)).toBe("everything");
    saveDetailLevel(path, "everything", s);
    expect(s.getItem(detailStorageKey(path))).toBeNull();
  });

  it("ignores junk and a missing storage", () => {
    const s = memStorage();
    s.setItem(detailStorageKey(path), "verbose");
    expect(loadDetailLevel(path, s)).toBe("everything");
    expect(loadDetailLevel(path, null)).toBe("everything");
    expect(() => saveDetailLevel(path, "names", null)).not.toThrow();
  });
});
