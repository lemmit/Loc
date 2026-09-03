// The Model pane's detail switch — Names / Fields / Everything (M-T8.21
// slice 4; dbdiagram's three-position control).
//
// A drilled view can carry a lot per node: a projection's `from`/`join`/
// `select` summary, a field's five modifier clauses behind its toggle, the
// authorization chips, a deployable's binding multi-selects.  Reading the
// SHAPE of a context — what is there, how it connects — wants none of that;
// editing one member wants all of it.  The level is a pure FILTER over the
// node data the pane already derives (nothing is re-derived), persisted per
// view path in localStorage like the hand-dragged positions
// (`persisted-positions.ts`), so a view you set to Names stays Names.
//
//   names       — kind + name only
//   fields      — + the read-only summary lines (a field's type, a
//                 projection's select, a channel's events)
//   everything  — + badges, inline selects / inputs / multi-selects, the
//                 collapsed-detail and expression-editor toggles (the default —
//                 today's rendering)

import type { DetailLevel } from "../../layout/vocabulary";
import type { ConstructNodeData } from "./ConstructNode";
import { pathHash } from "./persisted-positions";
import type { ViewPath } from "./view-graph";

export type { DetailLevel } from "../../layout/vocabulary";

export const DETAIL_LEVELS: readonly DetailLevel[] = ["names", "fields", "everything"];

const KEY_PREFIX = "loom-v2-detail-";

export function detailStorageKey(path: ViewPath): string {
  return `${KEY_PREFIX}${pathHash(path)}`;
}

export function isDetailLevel(v: unknown): v is DetailLevel {
  return typeof v === "string" && (DETAIL_LEVELS as readonly string[]).includes(v);
}

/** The persisted level for `path`, or `everything` (today's rendering) when
 *  none is stored, storage is unavailable, or the stored value is junk. */
export function loadDetailLevel(path: ViewPath, storage: Pick<Storage, "getItem"> | null = safeStorage()): DetailLevel {
  try {
    const raw = storage?.getItem(detailStorageKey(path));
    return isDetailLevel(raw) ? raw : "everything";
  } catch {
    return "everything";
  }
}

/** Persist `level` for `path`; `everything` (the default) clears the entry so
 *  storage only holds deliberate departures from it. */
export function saveDetailLevel(
  path: ViewPath,
  level: DetailLevel,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
  try {
    if (level === "everything") storage?.removeItem(detailStorageKey(path));
    else storage?.setItem(detailStorageKey(path), level);
  } catch {
    // Quota / private mode — the level still applies for this session.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reduce one node's data to what `level` shows.  `everything` returns the
 *  input unchanged (same reference — no churn for the default).  The root
 *  banner always keeps its full data: it is the view's title, and its detail
 *  block is how the container itself is edited. */
export function applyDetailLevel(data: ConstructNodeData, level: DetailLevel): ConstructNodeData {
  if (level === "everything" || data.isRoot) return data;
  const {
    multiSelects: _ms,
    inputs: _in,
    selects: _se,
    actions: _ac,
    detailsLabel: _dl,
    detailsOpen: _do,
    onToggleDetails: _otd,
    expressionEditor: _ee,
    onToggleExpression: _ote,
    badges: _b,
    summary,
    ...rest
  } = data;
  return level === "fields" && summary && summary.length > 0 ? { ...rest, summary } : rest;
}

/** `applyDetailLevel` over the pane's whole node-data map. */
export function applyDetailLevelToAll(
  data: ReadonlyMap<string, ConstructNodeData>,
  level: DetailLevel,
): Map<string, ConstructNodeData> {
  if (level === "everything") return new Map(data);
  const out = new Map<string, ConstructNodeData>();
  for (const [id, d] of data) out.set(id, applyDetailLevel(d, level));
  return out;
}
