// Per-view persisted node positions for the Model builder v2.
//
// View-graph layout is otherwise a pure derivation (`view-graph.ts`),
// re-computed on every render. Without persistence, any hand-drag snaps back on
// the next source edit / reload. This module owns the localStorage map keyed
// by view-path + node-id and the merge step at the React Flow boundary in the
// pane.
//
// The pane never re-reads `view-graph`'s `x/y`; it just spreads VNodes into
// React Flow `Node`s, optionally overriding `position` from the persisted map
// for the current view.

import type { ViewPath } from "./view-graph";

export interface Pos {
  x: number;
  y: number;
}

/** Per-view storage key. Keys land in localStorage as
 *  `loom-v2-pos-${pathHash}`; total per-key payload is small (one entry per
 *  hand-dragged node). */
const KEY_PREFIX = "loom-v2-pos-";

/** Stable per-session string for a `ViewPath`. `JSON.stringify` is sufficient
 *  — `ViewPath` is `{kind, name}[]`, which round-trips losslessly and shares
 *  identity across renders. */
export function pathHash(path: ViewPath): string {
  return JSON.stringify(path);
}

export function storageKey(path: ViewPath): string {
  return `${KEY_PREFIX}${pathHash(path)}`;
}

export type PositionMap = Record<string, Pos>;

/** Parse stored JSON back to a positions object, dropping anything malformed.
 *  Returns `{}` on null / unparseable / wrong-shape input so callers can spread
 *  the result without null checks. */
export function parsePositions(json: string | null): PositionMap {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: PositionMap = {};
    for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const { x, y } = v as Record<string, unknown>;
        if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
          out[id] = { x, y };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Read the persisted positions for one view-path. `{}` when none stored or
 *  localStorage is unavailable (SSR / private mode / quota-exceeded reads). */
export function loadPersisted(path: ViewPath): PositionMap {
  if (typeof localStorage === "undefined") return {};
  try {
    return parsePositions(localStorage.getItem(storageKey(path)));
  } catch {
    return {};
  }
}

/** Write the per-view map. Empty map → remove the key (keeps storage tidy).
 *  Swallows quota / disabled-storage errors silently (positions just won't
 *  persist this session). After every write, prune older keys if total
 *  `loom-v2-pos-*` payload exceeds the soft cap. */
export function savePersisted(path: ViewPath, map: PositionMap): void {
  if (typeof localStorage === "undefined") return;
  const key = storageKey(path);
  try {
    if (Object.keys(map).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(map));
    }
    pruneIfOversized();
  } catch {
    // Quota exceeded or storage disabled — leave the in-memory state alone.
  }
}

/** Clear the persisted positions for one view-path. Used by the "Reset
 *  layout" button so subsequent renders fall through to the derived layout. */
export function clearPersisted(path: ViewPath): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(storageKey(path));
  } catch {
    // Ignore — nothing reasonable to do on a remove failure.
  }
}

/** Pure helper: clone `nodes` with `position` overridden from `persisted`
 *  where the node's id has an entry. Stable and side-effect-free — the unit
 *  test imports this directly. Empty `persisted` is a no-op clone. */
export function mergePersistedPositions<N extends { id: string; position: Pos }>(
  nodes: N[],
  persisted: PositionMap,
): N[] {
  if (Object.keys(persisted).length === 0) return nodes.map((n) => ({ ...n }));
  return nodes.map((n) => {
    const p = persisted[n.id];
    if (!p) return { ...n };
    return { ...n, position: { x: p.x, y: p.y } };
  });
}

/** Soft cap on total bytes across all `loom-v2-pos-*` keys before pruning
 *  the oldest entries. Hand-dragged positions are tiny (each ~25 bytes), so
 *  100 KB lasts ~thousands of nodes spread across many views. */
const PRUNE_SOFT_CAP_BYTES = 100_000;

/** Walk every `loom-v2-pos-*` key and, if total payload exceeds the soft cap,
 *  drop the oldest keys by insertion order until under cap. localStorage
 *  iteration order is insertion order in practice across browsers, so this is
 *  a "drop the stalest views first" heuristic without needing a separate LRU
 *  index. Best-effort: any storage error short-circuits. */
function pruneIfOversized(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const keys: string[] = [];
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      const v = localStorage.getItem(k);
      if (v == null) continue;
      keys.push(k);
      // Per the storage spec, both key and value are stored — approximate the
      // bookkeeping by counting both.
      total += k.length + v.length;
    }
    if (total <= PRUNE_SOFT_CAP_BYTES) return;
    // Drop from the front (oldest insertions) until under cap.
    for (const k of keys) {
      if (total <= PRUNE_SOFT_CAP_BYTES) break;
      const v = localStorage.getItem(k);
      localStorage.removeItem(k);
      total -= k.length + (v?.length ?? 0);
    }
  } catch {
    // Ignore — pruning is opportunistic.
  }
}
