import type { SerializedNodes } from "@craftjs/core";

// ---------------------------------------------------------------------------
// Selection-preservation helpers for the page-builder's live re-seed
// (text → canvas).  When the source changes (the user is typing in Monaco)
// the canvas re-seeds via `actions.deserialize(...)`; the craft node ids in
// the new seed don't match the old ones, so we map the previously-selected
// node to the new seed by its **structural path** — the chain of child
// indices from `ROOT` down to it.  A path that doesn't resolve any more
// (because the source change moved or removed the node) yields `null`, and
// the caller clears the selection.
// ---------------------------------------------------------------------------

/** Minimal shape we read from a `SerializedNodes` entry.  Craft's own type
 *  exposes the same fields with extra craft-internal ones we don't need. */
interface SerializedNodeLike {
  nodes?: string[];
  parent?: string | null;
}

type Seed = Readonly<Record<string, SerializedNodeLike>>;

/** Walk from `ROOT` following `path` (each entry is the child index at that
 *  level) and return the resolved node id, or `null` if the path runs off
 *  the end of the tree.  An empty path resolves to `"ROOT"`. */
export function findNodeAtPath(seed: Seed, path: readonly number[]): string | null {
  let id: string = "ROOT";
  for (const idx of path) {
    const node: SerializedNodeLike | undefined = seed[id];
    const kids: string[] | undefined = node?.nodes;
    if (!kids || idx < 0 || idx >= kids.length) return null;
    id = kids[idx];
  }
  return id;
}

/** Walk up from `id` to `ROOT` recording each step's index in its parent's
 *  `nodes` array; the returned array reads root-to-leaf.  Returns `null` if
 *  `id` isn't in `seed` or any parent link is broken (a malformed seed). */
export function pathOfNode(seed: Seed, id: string): number[] | null {
  if (id === "ROOT") return [];
  if (!seed[id]) return null;
  const path: number[] = [];
  let cur = id;
  // Guard against pathological cycles in a malformed seed.
  for (let hop = 0; hop < 10_000; hop++) {
    const node = seed[cur];
    if (!node) return null;
    const parent = node.parent;
    if (parent == null) return null; // ROOT has parent: null, but we returned above
    const parentNode = seed[parent];
    const kids = parentNode?.nodes;
    if (!kids) return null;
    const idx = kids.indexOf(cur);
    if (idx < 0) return null;
    path.unshift(idx);
    if (parent === "ROOT") return path;
    cur = parent;
  }
  return null;
}
