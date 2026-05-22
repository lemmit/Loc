import { useEffect, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import type { TreeNode } from "./file-tree";

interface Props {
  nodes: TreeNode[];
  selectedPath: string | null;
  onActivateFile: (path: string) => void;
  emptyHint: string;
}

// Explorer tree backed by react-arborist — virtualized rows, keyboard
// navigation, and a single component shared by the "User code" and
// "Generated" views (both project into the same `TreeNode` shape).
//
// Read-only for now: drag, in-place rename, and drop are disabled.
// They become meaningful once the editable-workspace model lands, at
// which point the User-code view wires onMove/onRename/onCreate/onDelete
// into the VFS — the seam is already here.
export function ExplorerTree({ nodes, selectedPath, onActivateFile, emptyHint }: Props): JSX.Element {
  const { ref, width, height } = useFillSize();

  return (
    <Box ref={ref} style={{ flex: 1, minHeight: 0, overflow: "hidden" }} data-testid="explorer-tree">
      {nodes.length === 0 ? (
        <Text size="sm" c="dimmed" p="sm">
          {emptyHint}
        </Text>
      ) : width > 0 && height > 0 ? (
        <Tree<TreeNode>
          data={nodes}
          idAccessor={(d) => d.path}
          childrenAccessor={(d) => (d.kind === "folder" ? d.children : null)}
          openByDefault
          selection={selectedPath ?? undefined}
          width={width}
          height={height}
          rowHeight={28}
          indent={14}
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
          onActivate={(node: NodeApi<TreeNode>) => {
            if (node.isLeaf) onActivateFile(node.data.path);
          }}
        >
          {Row}
        </Tree>
      ) : null}
    </Box>
  );
}

function Row({ node, style, dragHandle }: NodeRendererProps<TreeNode>): JSX.Element {
  const isFolder = node.data.kind === "folder";
  const selected = node.isSelected && node.isLeaf;
  return (
    <Box
      ref={dragHandle}
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "100%",
        paddingRight: 8,
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: selected ? "var(--mantine-color-blue-9)" : "transparent",
        color: selected ? "white" : undefined,
      }}
      onClick={() => (isFolder ? node.toggle() : node.activate())}
    >
      <span
        style={{
          width: 14,
          flex: "0 0 auto",
          textAlign: "center",
          fontSize: 11,
          color: selected ? "rgba(255,255,255,0.6)" : "var(--mantine-color-dimmed)",
        }}
      >
        {isFolder ? (node.isOpen ? "▾" : "▸") : "·"}
      </span>
      <Text
        size="sm"
        ff={isFolder ? undefined : "monospace"}
        fw={isFolder ? 500 : undefined}
        c={selected ? "white" : undefined}
        style={{ overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {node.data.name}
      </Text>
    </Box>
  );
}

// Track a container's content-box size so the virtualized Tree (which
// needs explicit pixel width/height) fills its panel and re-flows on
// resize / region collapse-expand.
function useFillSize(): { ref: (el: HTMLDivElement | null) => void; width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const elRef = useRef<HTMLDivElement | null>(null);
  const obsRef = useRef<ResizeObserver | null>(null);

  const ref = (el: HTMLDivElement | null): void => {
    obsRef.current?.disconnect();
    elRef.current = el;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height },
      );
    });
    ro.observe(el);
    obsRef.current = ro;
  };

  useEffect(() => () => obsRef.current?.disconnect(), []);
  return { ref, ...size };
}
