// Persisted manual node positions for the system Model builder.
//
// Layout is otherwise derived (deterministic column-per-kind), and every
// re-seed recomputes it — so without this a user's hand-dragged arrangement
// resets on the next source edit or reload. Positions are keyed by node id
// (`<kind>:<name>`) in a single localStorage map; a node id absent from the
// current graph is simply ignored (and left untouched in storage).

export interface Pos {
  x: number;
  y: number;
}

const KEY = "loom.builder.node-positions";

/** Serialize a position map to its stored JSON form. */
export function serializePositions(map: Map<string, Pos>): string {
  return JSON.stringify(Object.fromEntries(map));
}

/** Parse stored JSON back to a position map, discarding anything malformed. */
export function parsePositions(json: string | null): Map<string, Pos> {
  const out = new Map<string, Pos>();
  if (!json) return out;
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === "object") {
      for (const [id, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v && typeof v === "object") {
          const { x, y } = v as Record<string, unknown>;
          if (typeof x === "number" && typeof y === "number") out.set(id, { x, y });
        }
      }
    }
  } catch {
    // Corrupt entry — fall back to derived layout.
  }
  return out;
}

export function loadPositions(): Map<string, Pos> {
  if (typeof localStorage === "undefined") return new Map();
  return parsePositions(localStorage.getItem(KEY));
}

export function savePositions(map: Map<string, Pos>): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (map.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, serializePositions(map));
  } catch {
    // Storage full / unavailable — positions just won't persist.
  }
}
