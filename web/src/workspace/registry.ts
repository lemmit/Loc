// ---------------------------------------------------------------------------
// Workspace registry — the list of named workspaces and which one is
// active.  This is the cross-workspace metadata that can't live inside any
// single workspace's git store, so it persists separately (localStorage).
//
// Storage model: each workspace is its own isolated, IndexedDB-backed git
// repo (one LightningFS DB per workspace, via `openGitFs(gitDb)`).  Content
// inside every workspace still lives at `/workspace/...`, so none of the
// existing path-based call sites change — switching workspaces just opens a
// different store.  The registry maps a stable workspace id → its git DB
// name + display name.
//
// The "default" workspace deliberately keeps the legacy `DEFAULT_GIT_DB`
// name so a user who already has autosaved content keeps it: on first run
// with this feature, their existing store simply becomes "My workspace".
//
// The pure functions (`defaultRegistry`, `addWorkspace`, …) take and return
// plain objects so the state transitions are unit-testable without touching
// localStorage; `loadRegistry`/`saveRegistry` are the thin persistence shell.
// ---------------------------------------------------------------------------

import { DEFAULT_GIT_DB } from "./git/index.js";

export interface WorkspaceMeta {
  /** Stable identity, used in URLs/state and to derive `gitDb`. */
  id: string;
  /** User-facing name shown in the switcher. */
  name: string;
  /** IndexedDB database name backing this workspace's git store. */
  gitDb: string;
  /** Creation timestamp (ms) — drives stable ordering in the switcher. */
  createdAt: number;
}

export interface WorkspaceRegistry {
  workspaces: WorkspaceMeta[];
  activeId: string;
}

/** localStorage key.  Versioned so a future shape change can migrate
 *  rather than silently mis-parse an old payload. */
export const REGISTRY_KEY = "loom.workspaces.v1";

/** The stable id of the migrated legacy workspace. */
export const DEFAULT_WORKSPACE_ID = "default";

/** Generate a short, collision-resistant workspace id.  Prefers
 *  `crypto.randomUUID` (every browser the playground targets); falls back
 *  to a random base36 string under test/SSR where `crypto` may be absent. */
export function genWorkspaceId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

/** The git DB name for a workspace id.  The default workspace maps to the
 *  legacy DB so pre-feature content is preserved; everything else gets a
 *  namespaced DB. */
export function gitDbForId(id: string): string {
  return id === DEFAULT_WORKSPACE_ID ? DEFAULT_GIT_DB : `loom-ws-${id}`;
}

/** The registry a brand-new user starts with: a single "My workspace"
 *  backed by the legacy git DB. */
export function defaultRegistry(now: number = Date.now()): WorkspaceRegistry {
  return {
    workspaces: [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "My workspace",
        gitDb: gitDbForId(DEFAULT_WORKSPACE_ID),
        createdAt: now,
      },
    ],
    activeId: DEFAULT_WORKSPACE_ID,
  };
}

/** Normalise a user-supplied name; empty/whitespace falls back to a
 *  default so a workspace always has a label. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Untitled workspace";
}

/** Append a new workspace and make it active.  Returns the next registry
 *  plus the created meta (the caller needs its `gitDb`/`id`). */
export function addWorkspace(
  reg: WorkspaceRegistry,
  name: string,
  now: number = Date.now(),
): { reg: WorkspaceRegistry; meta: WorkspaceMeta } {
  let id = genWorkspaceId();
  const taken = new Set(reg.workspaces.map((w) => w.id));
  while (taken.has(id) || id === DEFAULT_WORKSPACE_ID) id = genWorkspaceId();
  const meta: WorkspaceMeta = {
    id,
    name: cleanName(name),
    gitDb: gitDbForId(id),
    createdAt: now,
  };
  return {
    reg: { workspaces: [...reg.workspaces, meta], activeId: id },
    meta,
  };
}

/** Rename a workspace by id (no-op for an unknown id). */
export function renameWorkspace(
  reg: WorkspaceRegistry,
  id: string,
  name: string,
): WorkspaceRegistry {
  return {
    ...reg,
    workspaces: reg.workspaces.map((w) =>
      w.id === id ? { ...w, name: cleanName(name) } : w,
    ),
  };
}

/** Remove a workspace by id.  Refuses to remove the last remaining
 *  workspace (there must always be one).  If the removed workspace was
 *  active, the active pointer moves to the first survivor. */
export function removeWorkspace(reg: WorkspaceRegistry, id: string): WorkspaceRegistry {
  if (reg.workspaces.length <= 1) return reg;
  const workspaces = reg.workspaces.filter((w) => w.id !== id);
  if (workspaces.length === reg.workspaces.length) return reg; // unknown id
  const activeId = reg.activeId === id ? workspaces[0].id : reg.activeId;
  return { workspaces, activeId };
}

/** Point the active pointer at `id` (no-op for an unknown id). */
export function setActive(reg: WorkspaceRegistry, id: string): WorkspaceRegistry {
  if (!reg.workspaces.some((w) => w.id === id)) return reg;
  return { ...reg, activeId: id };
}

/** The active workspace's meta, or the first one if the pointer is stale. */
export function activeWorkspace(reg: WorkspaceRegistry): WorkspaceMeta {
  return reg.workspaces.find((w) => w.id === reg.activeId) ?? reg.workspaces[0];
}

/** Coerce an arbitrary parsed value into a valid registry, falling back to
 *  the default when the shape is wrong.  Guarantees at least one workspace
 *  and an `activeId` that actually exists. */
export function sanitizeRegistry(value: unknown): WorkspaceRegistry {
  if (typeof value !== "object" || value === null) return defaultRegistry();
  const raw = value as Partial<WorkspaceRegistry>;
  if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) {
    return defaultRegistry();
  }
  const workspaces: WorkspaceMeta[] = [];
  for (const w of raw.workspaces) {
    if (
      typeof w?.id === "string" &&
      typeof w?.name === "string" &&
      typeof w?.gitDb === "string"
    ) {
      workspaces.push({
        id: w.id,
        name: w.name,
        gitDb: w.gitDb,
        createdAt: typeof w.createdAt === "number" ? w.createdAt : Date.now(),
      });
    }
  }
  if (workspaces.length === 0) return defaultRegistry();
  const activeId =
    typeof raw.activeId === "string" && workspaces.some((w) => w.id === raw.activeId)
      ? raw.activeId
      : workspaces[0].id;
  return { workspaces, activeId };
}

/** Read the persisted registry, sanitising or defaulting on any problem. */
export function loadRegistry(): WorkspaceRegistry {
  if (typeof localStorage === "undefined") return defaultRegistry();
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return defaultRegistry();
    return sanitizeRegistry(JSON.parse(raw));
  } catch {
    return defaultRegistry();
  }
}

/** Persist the registry.  Best-effort: a hostile-storage failure is
 *  swallowed (the in-memory registry still drives the session). */
export function saveRegistry(reg: WorkspaceRegistry): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
  } catch {
    /* ignore quota / private-mode errors */
  }
}
