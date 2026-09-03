// The visual panes' Undo / Redo chrome (M-T8.17 slice 2, audit H9).
//
// Every pane edit — a Builder Apply, a canvas delete, a requirements Save —
// reaches the editor through `EditorHandle.setSource`, which on Monaco is a
// `pushEditOperations` and so already sits on the model's undo stack.  The
// stack was correct and UNREACHABLE: the only way to undo a visual edit was
// to switch to Source and press ⌘Z there.  These two buttons (and the key
// handler the pane root spreads) make it reachable from where the edit was
// made.  The editor answers the change like any keystroke (`onDidChangeContent`
// → `onSourceChange(…, "editor")`), so the pane re-derives through the same
// live tick it already listens to.

import { ActionIcon, Group, Tooltip } from "@mantine/core";
import type { KeyboardEvent, MutableRefObject } from "react";
import type { EditorHandle } from "../editor/editor-handle";
import { isTextEntryTag, undoKeyAction } from "./undo-keys";

interface Props {
  handleRef: MutableRefObject<EditorHandle | null>;
  /** `${prefix}-undo` / `${prefix}-redo` test ids. */
  testidPrefix: string;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

/** Two icon buttons.  Enabled state is read off the handle at render time —
 *  the panes re-render on every source tick, which is exactly when the stack
 *  moved.  An editor that cannot report (the pre-mount placeholder, or none
 *  at all) renders both disabled rather than promising an undo it can't do. */
export function UndoRedo({ handleRef, testidPrefix }: Props): JSX.Element {
  const h = handleRef.current;
  const canUndo = h?.canUndo() ?? false;
  const canRedo = h?.canRedo() ?? false;
  return (
    <Group gap={2} wrap="nowrap" data-testid={`${testidPrefix}-undo-redo`}>
      <Tooltip label={`Undo the last source edit (${MOD}Z)`} withArrow openDelay={400}>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label="Undo"
          disabled={!canUndo}
          data-testid={`${testidPrefix}-undo`}
          onClick={() => handleRef.current?.undo()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </ActionIcon>
      </Tooltip>
      <Tooltip label={`Redo (${MOD}⇧Z)`} withArrow openDelay={400}>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label="Redo"
          disabled={!canRedo}
          data-testid={`${testidPrefix}-redo`}
          onClick={() => handleRef.current?.redo()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/** Keydown handler for a pane's root element (give the root `tabIndex={-1}`
 *  so a click anywhere inside focuses it and the keys route here).  Text
 *  controls keep their own native undo. */
export function paneUndoKeyHandler(
  handleRef: MutableRefObject<EditorHandle | null>,
): (e: KeyboardEvent<HTMLElement>) => void {
  return (e) => {
    const target = e.target as HTMLElement | null;
    const isText = target ? isTextEntryTag(target.tagName, target.getAttribute("contenteditable")) : false;
    const action = undoKeyAction(e, isText);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "undo") handleRef.current?.undo();
    else handleRef.current?.redo();
  };
}
