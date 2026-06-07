// ---------------------------------------------------------------------------
// `WorkspaceDrawer` — the mobile-first workspace surface.
//
// On a phone the workspace is the primary organizing concept, but the
// header has no room for the desktop `WorkspaceSwitcher`.  This Drawer
// gives workspaces a first-class, tap-friendly home:
//
//   - switch (tap a row), rename (inline input), delete (confirmed) —
//     proper Mantine controls, no `window.prompt`.
//   - create a NEW workspace and pick the example it starts from.  This
//     is non-destructive (a fresh workspace), which is the intuitive
//     place to choose an example — not a "replace my current files"
//     action.
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
import { defaultExample, type LoomExample } from "../examples";
import type { WorkspaceState } from "../layout/ctx";

interface Props {
  opened: boolean;
  onClose: () => void;
  workspace: WorkspaceState;
  /** Example list for the "start from" picker in the create form. */
  examples: LoomExample[];
  /** Create a new workspace seeded from the chosen example. */
  onCreateFromExample: (name: string, exampleId: string) => void;
}

export function WorkspaceDrawer({
  opened,
  onClose,
  workspace,
  examples,
  onCreateFromExample,
}: Props): JSX.Element {
  const { workspaces, activeId, switchWorkspace, renameWorkspace, deleteWorkspace } = workspace;

  const [newName, setNewName] = useState("");
  const [startExample, setStartExample] = useState<string>(defaultExample.id);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const labelOf = (id: string): string =>
    examples.find((e) => e.id === id)?.label ?? id;

  const beginRename = (id: string, current: string): void => {
    setRenamingId(id);
    setRenameDraft(current);
  };
  const commitRename = (): void => {
    if (renamingId && renameDraft.trim()) renameWorkspace(renamingId, renameDraft.trim());
    setRenamingId(null);
    setRenameDraft("");
  };
  const commitCreate = (): void => {
    const id = startExample || defaultExample.id;
    const name = newName.trim() || labelOf(id);
    onCreateFromExample(name, id);
    setNewName("");
    setStartExample(defaultExample.id);
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

        <Divider label="New workspace" labelPosition="left" />

        <Box>
          <Stack gap={6}>
            <Select
              size="sm"
              label="Start from"
              value={startExample}
              onChange={(v) => setStartExample(v ?? defaultExample.id)}
              data={examples.map((e) => ({ value: e.id, label: e.label }))}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
              styles={{ input: { fontSize: 16, minHeight: 36 } }}
              // Stable accessible name for SR + e2e (same as the desktop
              // example picker).
              aria-label="Choose example"
            />
            <Group gap={6} wrap="nowrap">
              <TextInput
                size="sm"
                style={{ flex: 1 }}
                placeholder={`Name (defaults to “${labelOf(startExample)}”)`}
                value={newName}
                onChange={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreate();
                }}
                data-testid="workspace-new-input"
              />
              <Button
                size="sm"
                variant="filled"
                onClick={commitCreate}
                data-testid="workspace-create"
              >
                Create
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Creates a new workspace seeded from the chosen example — your current
              workspace is untouched.
            </Text>
          </Stack>
        </Box>
      </Stack>
    </Drawer>
  );
}
