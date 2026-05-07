import { useState } from "react";
import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import type { TreeFolder, TreeNode } from "./file-tree";

interface FileTreeProps {
  root: TreeFolder;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function FileTree({ root, selectedPath, onSelect }: FileTreeProps): JSX.Element {
  if (root.children.length === 0) {
    return (
      <Text size="sm" c="dimmed" p="sm">
        No files yet — click Generate.
      </Text>
    );
  }
  return (
    <Box p={4}>
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
  const indent = 8 + depth * 12;

  if (node.kind === "folder") {
    return (
      <Box>
        <UnstyledButton
          onClick={() => setOpen((v) => !v)}
          style={{ width: "100%", display: "block" }}
        >
          <Group gap={4} px={4} py={2} style={{ paddingLeft: indent }} wrap="nowrap">
            <Text size="xs" c="dimmed" style={{ width: 10 }}>
              {open ? "▾" : "▸"}
            </Text>
            <Text size="sm" fw={500}>
              {node.name}
            </Text>
          </Group>
        </UnstyledButton>
        {open && node.children.map((c) => (
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
    <UnstyledButton
      onClick={() => onSelect(node.path)}
      style={{ width: "100%", display: "block" }}
    >
      <Group
        gap={4}
        px={4}
        py={2}
        style={{
          paddingLeft: indent + 14,
          background: selected ? "var(--mantine-color-blue-9)" : "transparent",
          borderRadius: 4,
        }}
        wrap="nowrap"
      >
        <Text size="sm" ff="monospace" c={selected ? "white" : undefined}>
          {node.name}
        </Text>
      </Group>
    </UnstyledButton>
  );
}
