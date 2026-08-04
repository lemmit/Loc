/** Imperative handle for pushing source into the live editor from a
 *  non-editor origin (the visual Builder, the agent, a history restore).
 *
 *  Lives in its own module — free of any `monaco-editor` import — because both
 *  editors implement it (`LoomEditor` on desktop, `PlainEditor` on mobile) and
 *  `App.tsx` holds the ref.  Declaring it in `LoomEditor.tsx` meant every
 *  consumer of the TYPE sat one careless `import` away from the 9.56 MB
 *  editor.  See M-T8.15. */
export interface EditorHandle {
  setSource: (text: string) => void;
}
