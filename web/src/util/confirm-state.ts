// ---------------------------------------------------------------------------
// The confirm layer's PURE half — react-free so `test/playground/confirm.test.ts`
// can pin it without `web/node_modules` (the same split as `pane-write.ts` /
// `pane-harness.ts`).
//
// Two things live here:
//
//   1. `ConfirmSpec` + the `confirmSites` catalog: the copy every destructive
//      site shows — its shape (inline row vs modal), the consequence sentence,
//      the "Yes, …" label, and, for the workspace delete, the type-to-confirm
//      token.  Copy is DATA here so a site can't drift back to a bare "Are you
//      sure?" (or to `window.confirm`, which the test greps for).
//   2. `confirmReduce` + `canConfirm`: the arm → confirm / cancel state
//      machine, including the type-to-confirm gate.
//
// Audit H8 (`docs/audits/playground-ux-review-2026-09.md` §3.2): seven native
// dialogs, three destructive actions with no confirm at all, and a confirm on
// the one cosmetic action (layout reset).  Mission M-T8.17 slice 1.
// ---------------------------------------------------------------------------

export type ConfirmShape = "inline" | "modal";

export interface ConfirmSpec {
  /** `inline`: the trigger is replaced by a consequence + Yes / Cancel row.
   *  `modal`: a Mantine `Modal` with a title — for the actions whose blast
   *  radius is a whole workspace. */
  shape: ConfirmShape;
  /** Modal title (unused inline). */
  title?: string;
  /** One sentence naming WHAT is lost.  Never "Are you sure?". */
  consequence: string;
  /** The affirmative button.  Always names the verb ("Yes, delete"). */
  confirmLabel: string;
  /** Optional list rendered under the consequence (files dropped, …). */
  details?: readonly string[];
  /** When set, the affirmative button stays disabled until the user types
   *  exactly this token — the workspace delete uses the workspace name. */
  typeToConfirm?: string;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Every site's copy, one function each.  Adding a destructive action means
 *  adding a row here — and the unit test pins the rows. */
export const confirmSites = {
  /** Workspace delete (desktop switcher + mobile drawer).  `fileCount` is null
   *  when it isn't cheaply known (a non-active workspace in the drawer). */
  workspaceDelete(name: string, fileCount: number | null): ConfirmSpec {
    const what =
      fileCount === null
        ? "every file in it"
        : plural(fileCount, ".ddd file");
    return {
      shape: "modal",
      title: `Delete workspace “${name}”`,
      consequence: `Deletes ${what} and the workspace's history. This can't be undone.`,
      confirmLabel: "Yes, delete workspace",
      typeToConfirm: name,
    };
  },
  /** A single `.ddd` source file, from the file tree. */
  sourceFileDelete(rel: string): ConfirmSpec {
    return {
      shape: "inline",
      consequence: `Delete ${rel}? The file leaves the workspace; History keeps the last saved version.`,
      confirmLabel: "Yes, delete file",
    };
  },
  /** A folder and everything under it, from the file tree. */
  sourceFolderDelete(rel: string, fileCount: number): ConfirmSpec {
    return {
      shape: "inline",
      consequence: `Delete ${rel}/ and the ${plural(fileCount, "file")} in it?`,
      confirmLabel: "Yes, delete folder",
    };
  },
  /** Importing an example over the active workspace — only asked when files
   *  would actually be dropped (a single-file → single-file switch is silent). */
  exampleImport(label: string, droppedRels: readonly string[]): ConfirmSpec {
    return {
      shape: "modal",
      title: `Load “${label}” into this workspace`,
      consequence: `Replaces this workspace's files. ${plural(droppedRels.length, "file")} will be deleted:`,
      details: droppedRels,
      confirmLabel: "Yes, replace the files",
    };
  },
  /** Runtime tab: drop the persisted database and reboot. */
  clearStoredData(): ConfirmSpec {
    return {
      shape: "inline",
      consequence: "Drops the saved database (every row) and reboots the backend clean.",
      confirmLabel: "Yes, clear data & retry",
    };
  },
  /** Runtime tab: reset database (rows only, schema stays). */
  resetDatabase(): ConfirmSpec {
    return {
      shape: "inline",
      consequence: "Drops every row and re-applies the schema.",
      confirmLabel: "Yes, clear all rows",
    };
  },
  /** A declaration on the model canvas (aggregate / context / field / …). */
  declarationDelete(kind: string, name: string): ConfirmSpec {
    return {
      shape: "inline",
      consequence: `Delete ${kind} ${name} and everything declared inside it?`,
      confirmLabel: "Yes, delete",
    };
  },
  /** A `ui` member from the page-builder chrome (store / menu section / menu
   *  link / state field).  `what` is the noun, `name` the identifier. */
  uiMemberDelete(what: string, name: string): ConfirmSpec {
    return {
      shape: "inline",
      consequence: `Delete ${what} ${name}?`,
      confirmLabel: "Yes, delete",
    };
  },
  /** History: restore a version.  Restore REPLACES the live edits and is
   *  itself recorded as a new commit (history stays linear), which is why
   *  the copy says both. */
  historyRestore(shortOid: string): ConfirmSpec {
    return {
      shape: "inline",
      consequence: `Replaces your current edits with version ${shortOid}. The restore is saved as a new commit, so it can be undone from here.`,
      confirmLabel: "Yes, restore",
    };
  },
  /** Page builder: a dirty canvas is about to be dropped (page switch or a
   *  live re-seed from an external source change). */
  discardCanvasEdits(reason: "switch" | "reseed"): ConfirmSpec {
    return {
      shape: "inline",
      consequence:
        reason === "switch"
          ? "This page has unapplied canvas edits. Switching pages discards them."
          : "The source changed under this page. Reloading the canvas discards your unapplied edits.",
      confirmLabel: reason === "switch" ? "Yes, discard and switch" : "Yes, reload canvas",
    };
  },
  /** Requirements: a modified form is about to be left. */
  discardFormEdits(id: string): ConfirmSpec {
    return {
      shape: "inline",
      consequence: `${id} has unsaved changes. Leaving discards them.`,
      confirmLabel: "Yes, discard changes",
    };
  },
} as const;

export type ConfirmSiteId = keyof typeof confirmSites;

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface ConfirmState {
  /** True between the trigger click and the Yes / Cancel decision. */
  armed: boolean;
  /** What the user has typed into the type-to-confirm box. */
  typed: string;
}

export type ConfirmEvent =
  | { type: "arm" }
  | { type: "cancel" }
  | { type: "type"; value: string }
  | { type: "confirm" };

export const CONFIRM_IDLE: ConfirmState = { armed: false, typed: "" };

/** Arm on the trigger; Cancel and a successful Confirm both return to idle
 *  (a rejected Confirm — see `canConfirm` — is a no-op).  Typing while idle is
 *  ignored: there is no box to type into. */
export function confirmReduce(state: ConfirmState, event: ConfirmEvent): ConfirmState {
  switch (event.type) {
    case "arm":
      return state.armed ? state : { armed: true, typed: "" };
    case "cancel":
      return CONFIRM_IDLE;
    case "type":
      return state.armed ? { ...state, typed: event.value } : state;
    case "confirm":
      return CONFIRM_IDLE;
  }
}

/** Whether the affirmative button is enabled: armed, and — when the spec asks
 *  for a typed token — the token matches exactly (whitespace-trimmed, since a
 *  trailing space is the commonest slip and not a different intent). */
export function canConfirm(state: ConfirmState, spec: Pick<ConfirmSpec, "typeToConfirm">): boolean {
  if (!state.armed) return false;
  if (spec.typeToConfirm === undefined) return true;
  return state.typed.trim() === spec.typeToConfirm;
}
