import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import type { ChangeStatus } from "../build/output-diff";
import type { TreeNode } from "./file-tree";

/** Per-row decoration the generated tree paints on top of the file name.
 *
 *  Two independent signals, deliberately in one map so a row can carry both:
 *  what CHANGED in this generate (M-T8.20 slice 2) and what the declaration
 *  under the cursor PRODUCED (slice 3). */
export interface RowMark {
  /** Added / changed / removed since the previous generate. */
  status?: ChangeStatus;
  /** This file is part of the hovered declaration's output. */
  corresponds?: boolean;
  /** Hue of the construct that produced it, when the colour map is on. */
  hue?: number;
}

interface Props {
  nodes: TreeNode[];
  selectedPath: string | null;
  onActivateFile: (path: string) => void;
  emptyHint: string;
  /** Path → decoration.  Empty (the default) renders exactly the tree that
   *  shipped before M-T8.20. */
  marks?: ReadonlyMap<string, RowMark>;
  /** Report the row under the pointer, `null` on leave — the generated half
   *  of the correspondence hover. */
  onHoverFile?: (path: string | null) => void;
}

// Decoration is read through a context rather than passed down: react-arborist
// renders rows through a `children` component it calls with its OWN props
// (`NodeRendererProps`), so there is no prop channel from here to a row.
const MarkContext = createContext<{
  marks?: ReadonlyMap<string, RowMark>;
  onHoverFile?: (path: string | null) => void;
}>({});

const STATUS_GLYPH: Record<ChangeStatus, string> = { added: "A", changed: "M", removed: "D" };
const STATUS_COLOR: Record<ChangeStatus, string> = {
  added: "var(--mantine-color-green-4)",
  changed: "var(--mantine-color-yellow-4)",
  removed: "var(--mantine-color-red-4)",
};

// Explorer tree backed by react-arborist — virtualized rows, keyboard
// navigation, and a single component shared by the "User code" and
// "Generated" views (both project into the same `TreeNode` shape).
//
// Read-only for now: drag, in-place rename, and drop are disabled.
// They become meaningful once the editable-workspace model lands, at
// which point the User-code view wires onMove/onRename/onCreate/onDelete
// into the VFS — the seam is already here.
export function ExplorerTree({
  nodes,
  selectedPath,
  onActivateFile,
  emptyHint,
  marks,
  onHoverFile,
}: Props): JSX.Element {
  const { ref, width, height } = useFillSize();

  return (
    <MarkContext.Provider value={{ marks, onHoverFile }}>
      <Box
        ref={ref}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        data-testid="explorer-tree"
        onMouseLeave={() => onHoverFile?.(null)}
      >
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
    </MarkContext.Provider>
  );
}

function Row({ node, style, dragHandle }: NodeRendererProps<TreeNode>): JSX.Element {
  const { marks, onHoverFile } = useContext(MarkContext);
  const isFolder = node.data.kind === "folder";
  const selected = node.isSelected && node.isLeaf;
  const mark = marks?.get(node.data.path);
  // Correspondence wins the row background over selection: the highlight is
  // transient and answers the question the user is asking right now.
  const corrBg =
    mark?.corresponds === true
      ? `hsla(${mark.hue ?? 200}, 70%, 55%, ${selected ? 0.55 : 0.22})`
      : null;
  return (
    <Box
      ref={dragHandle}
      data-testid={node.isLeaf ? "explorer-row" : undefined}
      data-path={node.data.path}
      data-status={mark?.status}
      data-corresponds={mark?.corresponds ? "1" : undefined}
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: "100%",
        paddingRight: 8,
        cursor: "pointer",
        whiteSpace: "nowrap",
        background: corrBg ?? (selected ? "var(--mantine-color-blue-9)" : "transparent"),
        color: selected ? "white" : undefined,
      }}
      onMouseEnter={() => {
        if (node.isLeaf) onHoverFile?.(node.data.path);
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
      {mark?.status && (
        <Text
          size="xs"
          fw={700}
          ff="monospace"
          title={mark.status}
          data-testid="explorer-row-status"
          style={{ marginLeft: "auto", color: STATUS_COLOR[mark.status] }}
        >
          {STATUS_GLYPH[mark.status]}
        </Text>
      )}
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
