import { useState, type ReactNode } from "react";
import { Box, Text } from "@mantine/core";
import type { TreeFolder, TreeNode } from "./file-tree";

interface FileTreeProps {
  root: TreeFolder;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Optional per-file inline action slot — typically a delete `×`
   *  button.  Renders to the right of the file name; not called for
   *  folder rows.  Used by the source-files tree to attach a
   *  delete affordance without forking the renderer; defaults to
   *  nothing for the generated-output use case. */
  rowActions?: (filePath: string) => ReactNode;
  /** Initial open state for folders.  Defaults to `true` —
   *  generated-output uses want every level visible at a glance.
   *  Source-files use sometimes wants nested folders expanded by
   *  default too; pass `false` for "all folders start collapsed". */
  defaultFolderOpen?: boolean;
  /** Optional filter — return `false` to hide a file from the
   *  rendered tree (the folder it lives in still renders, but the
   *  file row doesn't).  Used by the source-files tree to hide
   *  the in-memory `.empty-folder` shim entries that exist only to
   *  make `buildTree` materialise an empty folder node.  Not
   *  consulted for folder rows. */
  shouldRenderFile?: (filePath: string) => boolean;
  /** Optional right-click handler per row.  Fired for both file and
   *  folder rows with the row's path + kind and the raw event (so the
   *  caller can position a context menu at the cursor).  The renderer
   *  calls `preventDefault` before invoking it, suppressing the native
   *  browser menu.  Used by the source-files tree for its create /
   *  rename / delete context menu; unset for the generated-output
   *  pane (no native menu suppression there). */
  onContextMenu?: (path: string, kind: "file" | "folder", e: React.MouseEvent) => void;
}

// Visual constants tuned by hand against a 240 px pane width:
//   - 16 px per nesting level (deep enough to read at a glance)
//   - 8 px gutter on the left so depth=0 isn't flush against the
//     scroll-area border
//   - 14 px reserved for the chevron / file-bullet glyph
//
// Row height is min 36 px so touch users can land a finger on a row
// without misfiring on the neighbour.  The iOS HIG nominal of 44 px
// would push the file tree into "too sparse" on desktop where mouse
// targeting is precise, so 36 px is a deliberate middle ground —
// still well above the 2 × 4 padding the rows used to have.
const INDENT_STEP = 16;
const GUTTER = 8;
const CHEVRON_WIDTH = 14;
const ROW_MIN_HEIGHT = 36;

const baseRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  padding: "6px 8px",
  minHeight: ROW_MIN_HEIGHT,
  fontFamily: "inherit",
  color: "inherit",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  // Suppress the iOS tap highlight overlay — we render our own
  // pressed state and the default grey blob looks misplaced.
  WebkitTapHighlightColor: "transparent",
};

export function FileTree({
  root,
  selectedPath,
  onSelect,
  rowActions,
  defaultFolderOpen = true,
  shouldRenderFile,
  onContextMenu,
}: FileTreeProps): JSX.Element {
  if (root.children.length === 0) {
    return (
      <Text size="sm" c="dimmed" p="sm">
        No files yet — click Generate.
      </Text>
    );
  }
  return (
    <Box py={4} style={{ minWidth: "fit-content" }}>
      {root.children.map((c) => (
        <NodeRow
          key={c.path}
          node={c}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          rowActions={rowActions}
          defaultFolderOpen={defaultFolderOpen}
          shouldRenderFile={shouldRenderFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </Box>
  );
}

interface NodeRowProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  rowActions?: (filePath: string) => ReactNode;
  defaultFolderOpen: boolean;
  shouldRenderFile?: (filePath: string) => boolean;
  onContextMenu?: (path: string, kind: "file" | "folder", e: React.MouseEvent) => void;
}

function NodeRow({
  node,
  depth,
  selectedPath,
  onSelect,
  rowActions,
  defaultFolderOpen,
  shouldRenderFile,
  onContextMenu,
}: NodeRowProps): JSX.Element | null {
  // File-row filter — used by the source-files tree to hide the
  // in-memory empty-folder shim entries while still letting their
  // parent folder render.
  if (node.kind === "file" && shouldRenderFile && !shouldRenderFile(node.path)) {
    return null;
  }
  // Folders default to the parent-chosen state — usually expanded.
  const [open, setOpen] = useState(defaultFolderOpen);
  // Hover covers mouse; pressed covers touch (where hover is meaningless).
  // Together they give every input modality some feedback before the
  // tap is committed.
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const paddingLeft = GUTTER + depth * INDENT_STEP;

  const rowEvents = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => {
      setHover(false);
      setPressed(false);
    },
    onPointerDown: () => setPressed(true),
    onPointerUp: () => setPressed(false),
    onPointerCancel: () => setPressed(false),
  };

  if (node.kind === "folder") {
    return (
      <Box>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onContextMenu={
            onContextMenu
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onContextMenu(node.path, "folder", e);
                }
              : undefined
          }
          {...rowEvents}
          style={{
            ...baseRowStyle,
            paddingLeft,
            background: pressed
              ? "var(--mantine-color-dark-5)"
              : hover
                ? "var(--mantine-color-dark-6)"
                : "transparent",
          }}
        >
          <span
            style={{
              width: CHEVRON_WIDTH,
              display: "inline-block",
              fontSize: 11,
              color: "var(--mantine-color-dimmed)",
              flex: "0 0 auto",
            }}
          >
            {open ? "▾" : "▸"}
          </span>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{node.name}</span>
        </button>
        {open &&
          node.children.map((c) => (
            <NodeRow
              key={c.path}
              node={c}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              rowActions={rowActions}
              defaultFolderOpen={defaultFolderOpen}
              shouldRenderFile={shouldRenderFile}
              onContextMenu={onContextMenu}
            />
          ))}
      </Box>
    );
  }
  const selected = selectedPath === node.path;
  const action = rowActions?.(node.path);
  // Use a div instead of a button when actions are present so the
  // inner action button has unambiguous click handling (a button
  // inside a button is non-conforming HTML and triggers both
  // handlers on touch).  Click events still drive `onSelect`; the
  // action slot stops propagation for its own clicks.
  const Wrapper = action ? "div" : "button";
  return (
    <Wrapper
      type={action ? undefined : "button"}
      role={action ? "button" : undefined}
      tabIndex={action ? 0 : undefined}
      onClick={() => onSelect(node.path)}
      onContextMenu={
        onContextMenu
          ? (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(node.path, "file", e);
            }
          : undefined
      }
      onKeyDown={
        action
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(node.path);
              }
            }
          : undefined
      }
      {...rowEvents}
      style={{
        ...baseRowStyle,
        paddingLeft,
        background: selected
          ? "var(--mantine-color-blue-9)"
          : pressed
            ? "var(--mantine-color-dark-5)"
            : hover
              ? "var(--mantine-color-dark-6)"
              : "transparent",
        color: selected ? "white" : "inherit",
        borderRadius: 0,
      }}
    >
      <span
        style={{
          width: CHEVRON_WIDTH,
          display: "inline-block",
          fontSize: 11,
          color: selected ? "rgba(255,255,255,0.6)" : "var(--mantine-color-dimmed)",
          flex: "0 0 auto",
        }}
      >
        ·
      </span>
      <span
        style={{
          fontSize: 14,
          fontFamily: "var(--mantine-font-family-monospace)",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {node.name}
      </span>
      {action && (
        <span
          style={{ flex: "0 0 auto", marginLeft: 4 }}
          onClick={(e) => e.stopPropagation()}
        >
          {action}
        </span>
      )}
    </Wrapper>
  );
}
