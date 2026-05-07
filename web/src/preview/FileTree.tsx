import { useState } from "react";
import { Box, Text } from "@mantine/core";
import type { TreeFolder, TreeNode } from "./file-tree";

interface FileTreeProps {
  root: TreeFolder;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

// Visual constants tuned by hand against a 240px pane width:
//   - 16px per nesting level (deep enough to read at a glance)
//   - 8px gutter on the left so depth=0 isn't flush against the
//     scroll-area border
//   - 14px reserved for the chevron / file-bullet glyph
const INDENT_STEP = 16;
const GUTTER = 8;
const CHEVRON_WIDTH = 14;

const baseRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  width: "100%",
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  padding: "2px 4px",
  fontFamily: "inherit",
  color: "inherit",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
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
  const [hover, setHover] = useState(false);
  // The chevron occupies CHEVRON_WIDTH; files (no chevron) get the
  // same offset on top of paddingLeft so file names line up with
  // their parent folder's name.
  const paddingLeft = GUTTER + depth * INDENT_STEP;

  if (node.kind === "folder") {
    return (
      <Box>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            ...baseRowStyle,
            paddingLeft,
            background: hover ? "var(--mantine-color-dark-6)" : "transparent",
          }}
        >
          <span
            style={{
              width: CHEVRON_WIDTH,
              display: "inline-block",
              fontSize: 10,
              color: "var(--mantine-color-dimmed)",
              flex: "0 0 auto",
            }}
          >
            {open ? "▾" : "▸"}
          </span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{node.name}</span>
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...baseRowStyle,
        paddingLeft,
        background: selected
          ? "var(--mantine-color-blue-9)"
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
          fontSize: 10,
          color: selected ? "rgba(255,255,255,0.6)" : "var(--mantine-color-dimmed)",
          flex: "0 0 auto",
        }}
      >
        ·
      </span>
      <span style={{ fontSize: 13, fontFamily: "var(--mantine-font-family-monospace)" }}>
        {node.name}
      </span>
    </button>
  );
}
