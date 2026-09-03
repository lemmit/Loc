/** Imperative handle for pushing source into the live editor from a
 *  non-editor origin (the visual Builder, the agent, a history restore) —
 *  and, since M-T8.17, for reaching the editor's UNDO STACK from those same
 *  surfaces.  Every pane write lands as one undoable edit (Monaco:
 *  `pushEditOperations`; the mobile textarea: an `insertText` / `setRangeText`
 *  the native stack keeps), so `undo()` from a pane's chrome reverts exactly
 *  the Apply / Delete / Save the user just made.
 *
 *  Lives in its own module — free of any `monaco-editor` import — because both
 *  editors implement it (`LoomEditor` on desktop, `PlainEditor` on mobile) and
 *  `App.tsx` holds the ref.  Declaring it in `LoomEditor.tsx` meant every
 *  consumer of the TYPE sat one careless `import` away from the 9.56 MB
 *  editor.  See M-T8.15. */
export interface EditorHandle {
  setSource: (text: string) => void;
  /** Revert the most recent edit on the editor's own undo stack.  The editor
   *  reports the change back through its normal `onChange` path, so the app
   *  (and every pane) follows it like a keystroke. */
  undo: () => void;
  redo: () => void;
  /** Whether there is anything to undo / redo — drives the chrome buttons'
   *  disabled state.  A stand-in that cannot know answers `false`. */
  canUndo: () => boolean;
  canRedo: () => boolean;
}
