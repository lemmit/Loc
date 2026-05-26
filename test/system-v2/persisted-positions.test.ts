import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPersisted,
  loadPersisted,
  mergePersistedPositions,
  type PositionMap,
  parsePositions,
  pathHash,
  savePersisted,
  storageKey,
} from "../../web/src/builder/system-v2/persisted-positions.js";
import type { ViewPath } from "../../web/src/builder/system-v2/view-graph.js";

/** In-memory localStorage shim — node's vitest env doesn't ship one by
 *  default for the project's config, and we want a fresh store per test. */
function installLocalStorage(): Storage {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = store;
  return store;
}

describe("persisted-positions — pure helpers", () => {
  beforeEach(() => {
    installLocalStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    vi.restoreAllMocks();
  });

  it("pathHash is stable across calls with structurally equal paths", () => {
    const a: ViewPath = [
      { kind: "system", name: "S" },
      { kind: "module", name: "M" },
    ];
    const b: ViewPath = [
      { kind: "system", name: "S" },
      { kind: "module", name: "M" },
    ];
    expect(pathHash(a)).toBe(pathHash(b));
  });

  it("pathHash distinguishes different paths", () => {
    expect(pathHash([{ kind: "system", name: "A" }])).not.toBe(
      pathHash([{ kind: "system", name: "B" }]),
    );
  });

  it("storageKey carries the loom-v2-pos- prefix", () => {
    expect(storageKey([{ kind: "system", name: "S" }])).toMatch(/^loom-v2-pos-/);
  });

  it("parsePositions returns {} on null / malformed / wrong-shape input", () => {
    expect(parsePositions(null)).toEqual({});
    expect(parsePositions("")).toEqual({});
    expect(parsePositions("not-json")).toEqual({});
    expect(parsePositions("123")).toEqual({});
    // Wrong shapes are filtered, not surfaced as errors.
    expect(parsePositions('{"a": {"x": "not-a-number", "y": 0}}')).toEqual({});
    expect(parsePositions('{"a": {"x": 1}}')).toEqual({});
    expect(parsePositions('{"a": null}')).toEqual({});
  });

  it("parsePositions keeps well-formed entries", () => {
    expect(parsePositions('{"foo": {"x": 1, "y": 2}, "bar": {"x": -3.5, "y": 4}}')).toEqual({
      foo: { x: 1, y: 2 },
      bar: { x: -3.5, y: 4 },
    });
  });

  it("parsePositions rejects non-finite coordinates", () => {
    expect(parsePositions(`{"a": {"x": ${Number.MAX_SAFE_INTEGER}, "y": 0}}`)).toEqual({
      a: { x: Number.MAX_SAFE_INTEGER, y: 0 },
    });
    // NaN / Infinity don't survive JSON round-trip (become `null`) — covered by
    // the wrong-shape filter above.
  });

  it("save / load / clear round-trip for one view-path", () => {
    const path: ViewPath = [{ kind: "context", name: "Ctx" }];
    expect(loadPersisted(path)).toEqual({});
    savePersisted(path, { n1: { x: 10, y: 20 } });
    expect(loadPersisted(path)).toEqual({ n1: { x: 10, y: 20 } });
    clearPersisted(path);
    expect(loadPersisted(path)).toEqual({});
  });

  it("save with an empty map removes the key", () => {
    const path: ViewPath = [{ kind: "system", name: "S" }];
    savePersisted(path, { n1: { x: 1, y: 2 } });
    expect(localStorage.getItem(storageKey(path))).not.toBeNull();
    savePersisted(path, {});
    expect(localStorage.getItem(storageKey(path))).toBeNull();
  });

  it("different view-paths are stored under different keys", () => {
    const a: ViewPath = [{ kind: "module", name: "A" }];
    const b: ViewPath = [{ kind: "module", name: "B" }];
    savePersisted(a, { n1: { x: 1, y: 1 } });
    savePersisted(b, { n1: { x: 9, y: 9 } });
    expect(loadPersisted(a)).toEqual({ n1: { x: 1, y: 1 } });
    expect(loadPersisted(b)).toEqual({ n1: { x: 9, y: 9 } });
  });

  it("load / save are no-ops when localStorage is unavailable", () => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    const path: ViewPath = [{ kind: "system", name: "S" }];
    expect(loadPersisted(path)).toEqual({});
    // Should not throw.
    expect(() => savePersisted(path, { n: { x: 1, y: 2 } })).not.toThrow();
    expect(() => clearPersisted(path)).not.toThrow();
  });
});

describe("mergePersistedPositions — pure helper", () => {
  type N = { id: string; position: { x: number; y: number }; meta?: string };

  it("returns cloned nodes unchanged when persisted is empty", () => {
    const nodes: N[] = [{ id: "a", position: { x: 1, y: 2 } }];
    const out = mergePersistedPositions(nodes, {});
    expect(out).toEqual(nodes);
    expect(out[0]).not.toBe(nodes[0]);
  });

  it("overrides only nodes that have a persisted entry", () => {
    const nodes: N[] = [
      { id: "a", position: { x: 0, y: 0 } },
      { id: "b", position: { x: 10, y: 10 } },
      { id: "c", position: { x: 20, y: 20 } },
    ];
    const persisted: PositionMap = { b: { x: 99, y: 88 } };
    const out = mergePersistedPositions(nodes, persisted);
    expect(out[0].position).toEqual({ x: 0, y: 0 });
    expect(out[1].position).toEqual({ x: 99, y: 88 });
    expect(out[2].position).toEqual({ x: 20, y: 20 });
  });

  it("preserves other node properties when overriding position", () => {
    const nodes: N[] = [{ id: "a", position: { x: 0, y: 0 }, meta: "hello" }];
    const out = mergePersistedPositions(nodes, { a: { x: 5, y: 5 } });
    expect(out[0]).toEqual({ id: "a", position: { x: 5, y: 5 }, meta: "hello" });
  });

  it("ignores persisted entries whose id isn't in the node list", () => {
    const nodes: N[] = [{ id: "a", position: { x: 0, y: 0 } }];
    const out = mergePersistedPositions(nodes, { z: { x: 99, y: 99 } });
    expect(out[0].position).toEqual({ x: 0, y: 0 });
  });

  it("does not mutate input nodes or positions", () => {
    const orig = { id: "a", position: { x: 0, y: 0 } };
    const nodes: N[] = [orig];
    mergePersistedPositions(nodes, { a: { x: 5, y: 5 } });
    expect(orig.position).toEqual({ x: 0, y: 0 });
  });
});
