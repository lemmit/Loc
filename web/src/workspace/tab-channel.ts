// ---------------------------------------------------------------------------
// Per-workspace BROADCAST CHANNEL — the liveness half of multi-tab
// coordination (mission M-T8.12, phase 2).
//
// Phase 1's writer lock makes exactly one tab able to write; this makes the
// OTHER tabs stay true.  Without it a passive tab keeps a stale
// `WorkspaceSourcesController` snapshot and a stale Monaco buffer, so the
// moment it becomes the writer (take-over, or the owner's tab closing) its
// first keystroke writes yesterday's text back over the other tab's file.
//
// This is a TRANSPORT, not new UI machinery: received messages feed back into
// the store's EXISTING fan-out (`GitStore.applyRemote` / `applyRemoteCommit`),
// so `WorkspaceSourcesController.refresh` runs unchanged, the external-content
// `epoch` bumps (it already documents "another tab" as its case), the editor
// remounts on fresh content, and History reloads on the commit channel.
//
// No echo loops by construction, twice over: `BroadcastChannel` never delivers
// a message to the context that posted it, and the `applyRemote*` entry points
// deliberately bypass the publisher so a REFRESH can never re-broadcast.
//
// Framework-free and node-testable — the channel factory is injected because
// `BroadcastChannel` semantics under vitest are not the browser's.  An absent
// `BroadcastChannel` degrades to a silent no-op channel (`supported: false`),
// matching `tab-lock.ts`'s stance: the support floor for both APIs is the same
// (Chrome 69 / Firefox 96 / Safari 15.4), so a browser without one has neither,
// and the fallback must be ONE coherent stance rather than two.
// ---------------------------------------------------------------------------

/** Channel name for a workspace's git DB. */
export const workspaceChannelName = (gitDb: string): string => `loom.workspace.${gitDb}`;

/** Cross-tab invalidation signals.  Deliberately carries no CONTENT — every
 *  message is "re-read the store", so a receiver can never apply a payload
 *  that lost a race with the durable tree. */
export type WorkspaceTabMessage =
  /** Working-tree paths another tab wrote / deleted. */
  | { kind: "files"; paths: string[] }
  /** A commit landed (History reloads off this). */
  | { kind: "commit"; oid: string }
  /** The sender's writer-ownership flipped — receivers re-read, since the
   *  new owner may have taken over mid-edit. */
  | { kind: "role"; owner: boolean }
  /** The workspace's IndexedDB is about to be deleted; drop your connection
   *  or `indexedDB.deleteDatabase` only ever fires `blocked`. */
  | { kind: "deleted" };

/** Structural stand-in for `BroadcastChannel`. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Opens a channel by name, or returns `null` when unsupported. */
export type ChannelFactory = (name: string) => BroadcastChannelLike | null;

export function defaultChannelFactory(name: string): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(name) as unknown as BroadcastChannelLike;
}

export interface WorkspaceTabChannel {
  readonly gitDb: string;
  /** False when the platform has no `BroadcastChannel` — `post` no-ops and
   *  nothing is ever received. */
  readonly supported: boolean;
  post(message: WorkspaceTabMessage): void;
  close(): void;
}

export interface WorkspaceChannelOptions {
  onMessage(message: WorkspaceTabMessage): void;
  /** Injected for tests; defaults to a real `BroadcastChannel`. */
  factory?: ChannelFactory;
}

/** Narrow an untrusted `MessageEvent.data` to a known message.  A tab from a
 *  different playground build can put anything on this channel. */
export function parseWorkspaceTabMessage(data: unknown): WorkspaceTabMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const kind = (data as { kind?: unknown }).kind;
  if (kind === "files") {
    const paths = (data as { paths?: unknown }).paths;
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) return null;
    return { kind: "files", paths: paths as string[] };
  }
  if (kind === "commit") {
    const oid = (data as { oid?: unknown }).oid;
    return typeof oid === "string" ? { kind: "commit", oid } : null;
  }
  if (kind === "role") {
    const owner = (data as { owner?: unknown }).owner;
    return typeof owner === "boolean" ? { kind: "role", owner } : null;
  }
  if (kind === "deleted") return { kind: "deleted" };
  return null;
}

export function openWorkspaceChannel(
  gitDb: string,
  opts: WorkspaceChannelOptions,
): WorkspaceTabChannel {
  const factory = opts.factory ?? defaultChannelFactory;
  let channel: BroadcastChannelLike | null = null;
  try {
    channel = factory(workspaceChannelName(gitDb));
  } catch {
    // A hostile storage/partitioning policy can throw on construction; the
    // playground must still open the workspace.
    channel = null;
  }
  if (channel !== null) {
    channel.onmessage = (event) => {
      const message = parseWorkspaceTabMessage(event.data);
      if (message !== null) opts.onMessage(message);
    };
  }
  let closed = false;
  return {
    gitDb,
    supported: channel !== null,
    post(message: WorkspaceTabMessage): void {
      if (closed || channel === null) return;
      try {
        channel.postMessage(message);
      } catch {
        /* a message that can't be structured-cloned must never break a write */
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (channel === null) return;
      channel.onmessage = null;
      channel.close();
      channel = null;
    },
  };
}

/** One-shot post for a workspace this tab has no open channel on — the
 *  `deleted` broadcast, which `deleteWorkspace` may fire for a NON-active
 *  workspace.  The close is deferred a macrotask because `postMessage`
 *  delivery is queued, not synchronous. */
export function postWorkspaceMessage(
  gitDb: string,
  message: WorkspaceTabMessage,
  factory: ChannelFactory = defaultChannelFactory,
): void {
  const channel = openWorkspaceChannel(gitDb, { onMessage: () => {}, factory });
  channel.post(message);
  setTimeout(() => channel.close(), 0);
}
