import { useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { PackPicker } from "../workspace/PackPicker";
import { WorkspaceDrawer } from "../workspace/WorkspaceDrawer";
import { WorkspaceSwitcher } from "../workspace/WorkspaceSwitcher";
import { WorkspaceTree } from "../workspace/WorkspaceTree";
import type { LayoutCtx } from "./ctx";
import { WorkspaceLockBanner } from "./WorkspaceLockBanner";
import { PipelineDots, PipelineStrip } from "./PipelineStrip";
import { AUTO_RUN, AUTO_RUN_HINT, RUN } from "./vocabulary";

interface Props {
  ctx: LayoutCtx;
}

// Desktop header — workspace controls on the left, the pipeline strip on
// the right.
export function DesktopHeader({ ctx }: Props): JSX.Element {
  const {
    augmentedExamplesList,
    createWorkspaceFromExample,
    copyShareLink,
    copied,
    workspace,
    buildClient,
    scheduleAutoGenerate,
  } = ctx;
  return (
    <Group h="100%" px="md" justify="space-between" wrap="wrap" gap="xs">
      <Group gap="md" wrap="wrap">
        <Title order={5}>Loom Playground</Title>
        {/* Workspaces own content; you pick a starting example when you
            create one (the "+" popover) — no separate always-on example
            dropdown that destructively overwrites the active workspace. */}
        <WorkspaceSwitcher
          workspace={workspace}
          examples={augmentedExamplesList}
          onCreateFromExample={createWorkspaceFromExample}
          size="xs"
        />
        {/* Only rendered while another tab owns the writer lock. */}
        <WorkspaceLockBanner
          reason={workspace.readOnlyReason}
          onTakeOver={workspace.takeOver}
        />
        <Button
          size="xs"
          variant="default"
          onClick={copyShareLink}
          data-testid="btn-share"
          title="Copy a link that loads the current source — works for any other user / browser."
        >
          {copied ? "✓ Copied" : "Share link"}
        </Button>
        <PackPicker
          workspaceStore={workspace.store}
          buildClient={buildClient}
          onImported={() => scheduleAutoGenerate()}
          onError={(err) => {
            // eslint-disable-next-line no-console
            console.warn("pack import:", err.message);
          }}
        />
        <WorkspaceTree workspaceStore={workspace.store} buildClient={buildClient} />
      </Group>
      {/* The pipeline strip IS the Generate / Bundle / Boot controls plus
          their state — one widget on both shells (audit H1). */}
      <PipelineStrip ctx={ctx} />
    </Group>
  );
}

// Mobile header — a 48 px row (workspace button, primary **Run**, kebab)
// plus the pipeline strip as four labelled dots under it.  Everything
// secondary (Share, Pack import, Workspace tree, the auto-run toggle)
// collapses into the menu so the top row never wraps.
export function MobileHeader({ ctx }: Props): JSX.Element {
  const {
    augmentedExamplesList,
    createWorkspaceFromExample,
    copyShareLink,
    copied,
    workspace,
    buildClient,
    scheduleAutoGenerate,
    runFull,
    pipeline,
    errorCount,
    liveMode,
    setLiveMode,
  } = ctx;
  // Spans Generate → Bundle → Boot.  Without it the spinner only
  // showed during the (often instant) Generate step, leaving the
  // user staring at an enabled-looking button for ~10 s while the
  // bundler crunched.  This was the root cause of the "Run does
  // nothing" complaint.
  const runLoading = pipeline.generating || pipeline.bundling || pipeline.booting;
  const [wsDrawerOpen, setWsDrawerOpen] = useState(false);
  return (
    <Stack h="100%" px="sm" gap={2} justify="center">
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Title order={6} style={{ flexShrink: 0 }}>Loom</Title>
        {/* Workspaces are the primary concept on mobile too: a single
            button shows the active workspace and opens the drawer that
            owns switch / new / rename / delete + example import.  This
            replaces the cramped top-row example Select and the fragile
            nested Select/Menu that used to live in the overflow kebab. */}
        <Button
          size="sm"
          variant="default"
          onClick={() => setWsDrawerOpen(true)}
          data-testid="mobile-workspace-button"
          aria-label={`Workspace: ${workspace.activeName} — switch or import an example`}
          styles={{ root: { minHeight: 36 }, label: { overflow: "hidden", textOverflow: "ellipsis" } }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Text size="sm" truncate>
            {workspace.activeName}
          </Text>
        </Button>
        <WorkspaceLockBanner
          reason={workspace.readOnlyReason}
          onTakeOver={workspace.takeOver}
          size="sm"
        />
      </Group>
      <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
        <Button
          size="sm"
          onClick={runFull}
          loading={runLoading}
          disabled={errorCount > 0}
          variant="filled"
          // The `Run` testid is what mobile e2e checks; keep
          // `btn-generate` on a hidden alias so legacy desktop
          // selectors keep matching when we revisit them.
          data-testid="btn-run"
          // Tighter padding so a 44 px-tall control still fits a 48 px
          // header without crowding the kebab.
          px={12}
          title="Generate → Bundle → Boot in one tap, then jump to Preview."
        >
          {RUN}
        </Button>
        <Menu shadow="md" position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon size="lg" variant="default" aria-label="More actions" data-testid="header-menu">
              {/* Plain unicode glyph — avoids pulling in an icon
                  library for one button (same rationale as PackPicker). */}
              ⋮
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {/* Bundle is not offered here — Run covers it (audit M3); the
                strip's dots under the row carry the per-stage state. */}
            <Menu.Item
              onClick={copyShareLink}
              data-testid="btn-share"
            >
              {copied ? "✓ Copied share link" : "Copy share link"}
            </Menu.Item>
            <Menu.Divider />
            <Box px="sm" py={6}>
              <Switch
                size="sm"
                checked={liveMode}
                onChange={(e) => setLiveMode(e.currentTarget.checked)}
                label={AUTO_RUN}
                data-testid="live-mode"
              />
              <Text size="xs" c="dimmed" mt={4}>
                {AUTO_RUN_HINT}
              </Text>
            </Box>
            <Menu.Divider />
            {/* Workspace switch / create / rename / delete + example
                import live in the WorkspaceDrawer (opened from the
                top-row button), not nested in this menu. */}
            <Box px="sm" py={6}>
              <PackPicker
                workspaceStore={workspace.store}
                buildClient={buildClient}
                onImported={() => scheduleAutoGenerate()}
                onError={(err) => {
                  // eslint-disable-next-line no-console
                  console.warn("pack import:", err.message);
                }}
              />
            </Box>
            <Box px="sm" py={6}>
              <WorkspaceTree workspaceStore={workspace.store} buildClient={buildClient} />
            </Box>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <WorkspaceDrawer
        opened={wsDrawerOpen}
        onClose={() => setWsDrawerOpen(false)}
        workspace={workspace}
        examples={augmentedExamplesList}
        onCreateFromExample={createWorkspaceFromExample}
      />
    </Group>
    <PipelineDots ctx={ctx} />
    </Stack>
  );
}
