import { useState } from "react";
import { Box, Text } from "@mantine/core";
import type { TreeFolder, TreeNode } from "./file-tree";

interface FileTreeProps {
  root: TreeFolder;
  selectedPath: string | null;
  onSelect: (path: string) => void;
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

export function FileTree({ root, selectedPath, onSelect }: FileTreeProps): JSX.Element {
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
}

function NodeRow({ node, depth, selectedPath, onSelect }: NodeRowProps): JSX.Element {
  // Folders default to expanded — users want the whole layout
  // visible so they can spot which file they care about quickly.
  const [open, setOpen] = useState(true);
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
            />
          ))}
      </Box>
    );
  }
  const selected = selectedPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
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
      <span style={{ fontSize: 14, fontFamily: "var(--mantine-font-family-monospace)" }}>
        {node.name}
      </span>
    </button>
  );
}
