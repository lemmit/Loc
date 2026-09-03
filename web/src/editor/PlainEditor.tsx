import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { Box } from "@mantine/core";
import type { EditorHandle } from "./editor-handle";
import { applyTextEdits, selectionFor } from "./apply-edits";

export interface PlainEditorProps {
  initialValue: string;
  /** Same imperative handle the Monaco editor exposes, so non-editor writers
   *  (the agent, a history restore) work identically on both surfaces. */
  handleRef?: MutableRefObject<EditorHandle | null>;
  onChange?: (value: string) => void;
  /** A `#view=1` render: the textarea refuses typing (M-T8.23 slice 2).  The
   *  imperative `handleRef` writes still land — a read-only VIEW is about the
   *  user not editing, not about the app being unable to show a restore. */
  readOnly?: boolean;
}

/** The MOBILE `.ddd` editor: a textarea with a scroll-synced line-number
 *  gutter.  No Monaco, no language client, no worker.
 *
 *  Monaco costs 9.56 MB of eager JS and three worker realms, and its whole
 *  value — minimap, multi-cursor, hover, completion, peek — is unreachable
 *  behind a soft keyboard on a 375 px screen.  What a phone edit actually is:
 *  fix a typo, retype a field, paste a block.  A textarea does that, and the
 *  memory it doesn't hold is memory the PGlite boot can use (M-T8.15).
 *
 *  Diagnostics still arrive — mobile gets them from `generate`, which reports
 *  `file:line`, and the gutter is what makes a line number actionable. */
export function PlainEditor({
  initialValue,
  handleRef,
  onChange,
  readOnly = false,
}: PlainEditorProps): JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [lineCount, setLineCount] = useState(() => countLines(initialValue));

  // Publish the imperative handle for the whole lifetime of the component —
  // an agent/builder write that lands before mount must not be dropped.
  useLayoutEffect(() => {
    const holder = handleRef;
    if (!holder) return;
    const handle: EditorHandle = {
      setSource: (text: string) => {
        const area = areaRef.current;
        if (area) replaceValue(area, text);
        setLineCount(countLines(text));
      },
      // The textarea has no edit model: apply the edits to its text and write
      // the result back through the undoable path, then dispatch like a
      // keystroke so the app (and mobile's generate-fed Problems) follow.
      applyEdits: (edits) => {
        const area = areaRef.current;
        if (!area || edits.length === 0) return;
        const next = applyTextEdits(area.value, edits);
        if (next === area.value) return;
        replaceValue(area, next);
        setLineCount(countLines(next));
        onChangeRef.current?.(next);
      },
      revealRange: (range) => {
        const area = areaRef.current;
        if (!area) return;
        const sel = selectionFor(area.value, range);
        area.focus();
        area.setSelectionRange(sel.start, sel.end);
        // Line-height arithmetic: no layout API tells a textarea where a
        // line is, and the gutter shares these metrics exactly.
        area.scrollTop = Math.max(0, (range.startLineNumber - 3) * LINE_H);
      },
      // The textarea's NATIVE stack.  `execCommand` only acts on the focused
      // element, so undo/redo focus it first — on a phone that is the
      // surface the user is looking at anyway.  The resulting `input` event
      // runs `onChange` below, which is how the app learns the source moved.
      undo: () => {
        const area = areaRef.current;
        if (!area) return;
        area.focus();
        document.execCommand("undo");
      },
      redo: () => {
        const area = areaRef.current;
        if (!area) return;
        area.focus();
        document.execCommand("redo");
      },
      // The DOM exposes no "is the native stack non-empty" — answer true
      // once mounted and let `execCommand` no-op on an empty stack.
      canUndo: () => areaRef.current !== null,
      canRedo: () => areaRef.current !== null,
    };
    holder.current = handle;
    return () => {
      if (holder.current === handle) holder.current = null;
    };
  }, [handleRef]);

  // Automation seam, same names the Monaco editor publishes — an e2e or manual
  // harness must be able to drive either surface identically.
  useEffect(() => {
    const w = window as unknown as {
      __loomSetSource?: (t: string) => void;
      __loomGetSource?: () => string;
    };
    w.__loomSetSource = (text: string) => {
      const area = areaRef.current;
      if (!area) return;
      replaceValue(area, text);
      setLineCount(countLines(text));
      onChangeRef.current?.(text);
    };
    w.__loomGetSource = () => areaRef.current?.value ?? "";
    return () => {
      delete w.__loomSetSource;
      delete w.__loomGetSource;
    };
  }, []);

  // Seed once per mount.  `EditorPane` remounts this on a project/file switch
  // via `key`, exactly as it does for the Monaco editor, so a prop-following
  // effect would only fight the user's own typing.
  useEffect(() => {
    const area = areaRef.current;
    if (area && area.value !== initialValue) {
      area.value = initialValue;
      setLineCount(countLines(initialValue));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "var(--loom-bg-sunken)",
        overflow: "hidden",
      }}
      data-testid="plain-editor"
    >
      <Box
        ref={gutterRef}
        aria-hidden
        style={{
          overflow: "hidden",
          padding: `${PAD}px 6px ${PAD}px 8px`,
          textAlign: "right",
          color: "var(--loom-edge)",
          background: "var(--loom-bg)",
          fontFamily: MONO,
          fontSize: FONT,
          lineHeight: `${LINE_H}px`,
          userSelect: "none",
          flexShrink: 0,
          // Widen with the file rather than clipping at four digits.
          minWidth: `${Math.max(2, String(lineCount).length) + 1}ch`,
        }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </Box>
      <textarea
        ref={areaRef}
        defaultValue={initialValue}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        // `off` would still let iOS substitute smart quotes into a `.ddd`
        // string literal; `false` on the writing-suggestions surface is what
        // actually stops the keyboard rewriting source.
        data-gramm="false"
        onScroll={(e) => {
          const g = gutterRef.current;
          if (g) g.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the field — without it the only way
          // to indent on a phone keyboard is spaces, and the only way to move
          // on is to tab out of the editor entirely.
          if (readOnly || e.key !== "Tab") return;
          e.preventDefault();
          const area = e.currentTarget;
          // Through the native edit path, so the indent is itself undoable.
          if (!document.execCommand("insertText", false, "  ")) {
            area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
          }
          setLineCount(countLines(area.value));
          onChangeRef.current?.(area.value);
        }}
        onChange={(e) => {
          setLineCount(countLines(e.currentTarget.value));
          onChangeRef.current?.(e.currentTarget.value);
        }}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          resize: "none",
          padding: `${PAD}px 8px`,
          background: "transparent",
          color: "var(--mantine-color-gray-3)",
          fontFamily: MONO,
          fontSize: FONT,
          lineHeight: `${LINE_H}px`,
          // `pre` + horizontal scroll: `.ddd` is indentation-structured, and
          // soft-wrapping it makes the gutter's line numbers lie.
          whiteSpace: "pre",
          overflowWrap: "normal",
          overflow: "auto",
          tabSize: 2,
        }}
      />
    </Box>
  );
}

// 16px is the threshold below which iOS Safari zooms on focus, which on this
// layout scrolls the tab bar off-screen.  The gutter must use the same metrics
// or its numbers drift from the text they label.
const FONT = 16;
const LINE_H = 24;
const PAD = 8;
const MONO = "var(--mantine-font-family-monospace)";

/** Replace the whole buffer WITHOUT wiping the textarea's native undo stack.
 *  Assigning `textarea.value` resets the stack (audit H9: an agent or Builder
 *  write used to wipe even the user's own Ctrl+Z on mobile).  The edit-path
 *  writes the browser keeps on the stack are `execCommand("insertText")` on
 *  the focused element and, elsewhere, `setRangeText`; `value =` stays only
 *  as the last resort for an environment that supports neither. */
function replaceValue(area: HTMLTextAreaElement, text: string): void {
  if (area.value === text) return;
  if (document.activeElement === area) {
    area.setSelectionRange(0, area.value.length);
    if (document.execCommand("insertText", false, text) && area.value === text) return;
  }
  if (typeof area.setRangeText === "function") {
    area.setRangeText(text, 0, area.value.length, "end");
    if (area.value === text) return;
  }
  area.value = text;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
