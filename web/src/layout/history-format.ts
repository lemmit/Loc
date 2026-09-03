// ---------------------------------------------------------------------------
// Pure formatting helpers for the History view — extracted so they're
// unit-testable without rendering React.
// ---------------------------------------------------------------------------

/** Coarse classification of a workspace commit by its message.  The git
 *  store writes `autosave workspace` (debounced edits), `regenerate`
 *  (intentional generate), and `import legacy workspace` (first boot);
 *  everything that isn't an autosave is a user-meaningful "milestone".
 *
 *  M-T8.19 slice 4 adds two NAMED authors on top of that: an agent turn
 *  commits `agent: <first line of the ask>` and a visual Apply commits
 *  `builder: <what was applied>`, so the timeline says who moved the model
 *  rather than showing a wall of identical autosaves. */
export type CommitKind = "milestone" | "autosave" | "agent" | "builder";

export function classifyCommit(message: string): CommitKind {
  const m = message.trim().toLowerCase();
  if (m.startsWith("autosave")) return "autosave";
  if (m.startsWith("agent:")) return "agent";
  if (m.startsWith("builder:")) return "builder";
  return "milestone";
}

/** Badge text + tint for each kind — one place, so the History rows and any
 *  later timeline view cannot disagree about what a commit is called. */
export const COMMIT_KIND_LABEL: Record<CommitKind, string> = {
  autosave: "autosave",
  milestone: "milestone",
  agent: "agent",
  builder: "builder",
};

export const COMMIT_KIND_COLOR: Record<CommitKind, string> = {
  autosave: "gray",
  milestone: "blue",
  agent: "grape",
  builder: "teal",
};

/** Short, human relative time from a commit's epoch-**seconds** timestamp.
 *  `now` is injectable for testing. */
export function formatRelativeTime(epochSeconds: number, now: number = Date.now()): string {
  const delta = Math.max(0, Math.floor(now / 1000 - epochSeconds));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const min = Math.floor(delta / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** First 7 chars of a commit oid — the conventional short hash. */
export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}
