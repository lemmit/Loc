// ---------------------------------------------------------------------------
// Editor seed precedence — which text Monaco mounts against for the
// active `.ddd` path.
//
// Pure, so the rule can be tested without rendering App.  It exists as
// its own module because getting it wrong is silent: the editor holds
// (and on the next keystroke writes back) whatever it was seeded with,
// so a stale seed doesn't just LOOK wrong, it overwrites the store.
// ---------------------------------------------------------------------------

import { DEFAULT_PATH } from "./workspace-sources.js";

/** Body a newly-created `.ddd` source starts with — also the seed for a
 *  non-main active path with nothing in the VFS yet.  The two must agree
 *  or the first keystroke rewrites the file with different content. */
export const NEW_FILE_SEED = "// New file — declare a context, valueobject, or enum here.\n";

export interface InitialSourceInput {
  /** The sources controller's resident snapshot of `/workspace/**.ddd`. */
  files: ReadonlyMap<string, string>;
  activePath: string;
  /** Whether the controller has completed its first store read. */
  hydrated: boolean;
  /** `/workspace/main.ddd` as read ONCE at store-open (`useWorkspace`).
   *  Never refreshed — see below. */
  persistedSource: string | null;
  /** Content of the last-imported example. */
  exampleSource: string;
}

/** Seed text for `activePath`.  Precedence:
 *
 *   1. The controller's snapshot for that path — the live store.
 *   2. `main.ddd` only, and only BEFORE the controller has hydrated:
 *      the open-time `persistedSource` read, which bridges the async gap
 *      on a workspace switch.
 *   3. The chosen example (`main.ddd`) / a stub comment (anything else).
 *
 * Step 2's hydration guard is the load-bearing part.  `persistedSource`
 * is captured once when the store opens and never re-read, so after a
 * history restore (or another tab) DELETES `main.ddd`, falling back to it
 * would reseed the editor with pre-restore text — which the next
 * keystroke then writes back over the restored tree.  Once the controller
 * has hydrated, its snapshot IS the store: an absent file there means
 * deleted, not "not loaded yet", so we fall through to the example — the
 * same seed a brand-new empty workspace gets.
 */
export function pickInitialSource(input: InitialSourceInput): string {
  const persisted = input.files.get(input.activePath);
  if (persisted !== undefined) return persisted;
  if (input.activePath === DEFAULT_PATH) {
    if (!input.hydrated) return input.persistedSource ?? input.exampleSource;
    return input.exampleSource;
  }
  return NEW_FILE_SEED;
}
