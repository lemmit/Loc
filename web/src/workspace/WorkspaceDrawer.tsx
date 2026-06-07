// ---------------------------------------------------------------------------
// `WorkspaceDrawer` — the mobile-first workspace surface.
//
// On a phone the workspace is the primary organizing concept, but the
// header has no room for the desktop `WorkspaceSwitcher` (a Select + a
// nested menu), and cramming it into the overflow kebab nested a Select
// and a Menu inside another Menu — fragile on touch.  This Drawer gives
// workspaces a first-class, tap-friendly home:
//
//   - switch (tap a row), create (inline input), rename (inline input),
//     delete (confirmed) — all with proper Mantine controls, no
//     `window.prompt`.
//   - "Start from an example" imports an example INTO the active
//     workspace (the same action the desktop example picker performs),
//     folded in here so the two related ideas live together.
//
// Desktop keeps the inline `WorkspaceSwitcher` + example picker in the
// header; this Drawer is wired only from the mobile header.
// ---------------------------------------------------------------------------

import { useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { LoomExample } from "../examples";
import type { WorkspaceState } from "../layout/ctx";

interface Props {
  opened: boolean;
  onClose: () => void;
  workspace: WorkspaceState;
  /** Example list for the "start from an example" picker. */
  examples: LoomExample[];
  /** The example last imported into the active workspace (picker value). */
  exampleId: string;
  /** Import an example into the active workspace (overwrites its sources). */
  onImportExample: (id: string) => void;
}

export function WorkspaceDrawer({
  opened,
  onClose,
  workspace,
  examples,
  exampleId,
  onImportExample,
}: Props): JSX.Element {
  const { workspaces, activeId, switchWorkspace, createWorkspace, renameWorkspace, deleteWorkspace } =
    workspace;

  const [newDraft, setNewDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const beginRename = (id: string, current: string): void => {
    setRenamingId(id);
    setRenameDraft(current);
  };
  const commitRename = (): void => {
    if (renamingId && renameDraft.trim()) renameWorkspace(renamingId, renameDraft.trim());
    setRenamingId(null);
    setRenameDraft("");
  };
  const commitNew = (): void => {
    const name = newDraft.trim();
    if (!name) return;
    createWorkspace(name); // also switches to it
    setNewDraft("");
    onClose();
  };
  const onDelete = (id: string, name: string): void => {
    if (workspaces.length <= 1) return;
    if (window.confirm(`Delete workspace "${name}"? Its files are removed.`)) {
      deleteWorkspace(id);
    }
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="auto"
      title="Workspaces"
      data-testid="workspace-drawer"
    >
      <Stack gap="sm">
        <Stack gap={4}>
          {workspaces.map((w) => {
            const active = w.id === activeId;
            if (renamingId === w.id) {
              return (
                <Group key={w.id} gap={6} wrap="nowrap">
                  <TextInput
                    size="sm"
                    autoFocus
                    style={{ flex: 1 }}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                  <Button size="xs" variant="default" onClick={commitRename}>
                    Save
                  </Button>
                </Group>
              );
            }
            return (
              <Group key={w.id} gap={6} wrap="nowrap" align="center">
                <Button
                  size="sm"
                  variant={active ? "filled" : "subtle"}
                  justify="flex-start"
                  style={{ flex: 1, minWidth: 0 }}
                  onClick={() => {
                    if (!active) switchWorkspace(w.id);
                    onClose();
                  }}
                  data-testid="workspace-row"
                >
                  <Text truncate>
                    {active ? "● " : ""}
                    {w.name}
                  </Text>
                </Button>
                <ActionIcon
                  size="lg"
                  variant="subtle"
                  color="gray"
                  aria-label={`Rename ${w.name}`}
                  onClick={() => beginRename(w.id, w.name)}
                >
                  ✎
                </ActionIcon>
                <ActionIcon
                  size="lg"
                  variant="subtle"
                  color="red"
                  aria-label={`Delete ${w.name}`}
                  disabled={workspaces.length <= 1}
                  onClick={() => onDelete(w.id, w.name)}
                >
                  🗑
                </ActionIcon>
              </Group>
            );
          })}
        </Stack>

        <Group gap={6} wrap="nowrap">
          <TextInput
            size="sm"
            style={{ flex: 1 }}
            placeholder="New workspace name"
            value={newDraft}
            onChange={(e) => setNewDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNew();
            }}
            data-testid="workspace-new-input"
          />
          <Button size="sm" variant="default" onClick={commitNew} disabled={!newDraft.trim()}>
            Create
          </Button>
        </Group>

        <Divider />

        <Box>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>
            Start from an example
          </Text>
          <Select
            size="sm"
            value={exampleId}
            onChange={(v) => {
              if (!v) return;
              onImportExample(v);
              onClose();
            }}
            data={examples.map((e) => ({ value: e.id, label: e.label }))}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            styles={{ input: { fontSize: 16, minHeight: 36 } }}
            // Same accessible name the desktop picker uses, so e2e + SR
            // users find the example chooser by one stable name.
            aria-label="Choose example"
            placeholder="Import an example…"
          />
          <Text size="xs" c="dimmed" mt={4}>
            Replaces this workspace's files with the example.
          </Text>
        </Box>
      </Stack>
    </Drawer>
  );
}
