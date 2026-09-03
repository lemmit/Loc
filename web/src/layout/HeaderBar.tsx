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
import { HelpMenu, HelpMenuItems } from "./HelpMenu";
import { PipelineDots, PipelineStrip } from "./PipelineStrip";
import { ReadOnlyBadge } from "./ReadOnlyBadge";
import { ShareDialog } from "./ShareDialog";
import { TargetsDrawer } from "./TargetsDrawer";
import { AUTO_RUN, AUTO_RUN_HINT, RUN, SHARE, TARGETS } from "./vocabulary";

interface Props {
  ctx: LayoutCtx;
}

// Desktop header — workspace controls on the left, the pipeline strip on
// the right.
export function DesktopHeader({ ctx }: Props): JSX.Element {
  const {
    augmentedExamplesList,
    createWorkspaceFromExample,
    workspace,
    buildClient,
    scheduleAutoGenerate,
    viewMode,
  } = ctx;
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // A `#view=1` link renders the playground WITHOUT the editing chrome: no
  // workspace switcher, no ⋯ (which owns pack import + the workspace tree),
  // no targets drawer.  The pipeline strip stays — a read-only visitor should
  // still be able to generate and look at the output — and so does Share, so
  // the link can be passed on.  One badge says which read-only this is; every
  // other surface renders the same one (audit L1).
  if (viewMode) {
    return (
      <Group h="100%" px="md" justify="space-between" wrap="wrap" gap="xs">
        <Group gap="md" wrap="wrap">
          <Title order={5}>Loom Playground</Title>
          <ReadOnlyBadge reason="view" />
          <Button
            size="xs"
            variant="default"
            onClick={() => setShareOpen(true)}
            data-testid="btn-share"
          >
            {SHARE.label}
          </Button>
          <ShareDialog ctx={ctx} opened={shareOpen} onClose={() => setShareOpen(false)} />
          <HelpMenu ctx={ctx} />
        </Group>
        <PipelineStrip ctx={ctx} />
      </Group>
    );
  }
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
        {/* Targets — the stack this system generates against, as dropdowns
            (M-T8.23, research §4 #21).  A quiet `default` button, not a
            filled one: the loudest control in the header should be the
            pipeline strip, never a settings surface (audit L6). */}
        <Button
          size="xs"
          variant="default"
          onClick={() => setTargetsOpen(true)}
          data-testid="btn-targets"
          title={TARGETS.intro}
        >
          {TARGETS.label}
        </Button>
        <TargetsDrawer ctx={ctx} opened={targetsOpen} onClose={() => setTargetsOpen(false)} />
        <ShareDialog ctx={ctx} opened={shareOpen} onClose={() => setShareOpen(false)} />
        {/* Share link, Import design pack and the imported-pack tree live
            under one ⋯ menu so the header never needs a second row (audit
            H2's follow-up, M3).  `closeOnItemClick={false}` keeps the menu
            open across the async pack import so the tree's new badge is
            visible where the user is looking. */}
        <Menu shadow="md" position="bottom-start" withinPortal closeOnItemClick={false}>
          <Menu.Target>
            <ActionIcon size="sm" variant="default" aria-label="More actions" data-testid="header-menu">
              ⋯
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              onClick={() => setShareOpen(true)}
              data-testid="btn-share"
              title="A link that loads the current source — works for any other user / browser."
            >
              {SHARE.label}…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Label>Workspace</Menu.Label>
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
        {/* `?` — Docs, Language reference, Keyboard shortcuts, Report a
            problem (M-T8.18, audit H5). */}
        <HelpMenu ctx={ctx} />
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
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // The mobile twin of the desktop view-mode header: title, the one read-only
  // badge, Share, Run + the strip.  No workspace button, no pack import, no
  // targets — a read-only link edits nothing.
  if (ctx.viewMode) {
    return (
      <Stack h="100%" px="sm" gap={2} justify="center">
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <Title order={6} style={{ flexShrink: 0 }}>Loom</Title>
            <ReadOnlyBadge reason="view" size="sm" />
          </Group>
          <Button
            size="sm"
            variant="default"
            onClick={() => setShareOpen(true)}
            data-testid="btn-share"
            px={12}
          >
            {SHARE.label}
          </Button>
          <ShareDialog ctx={ctx} opened={shareOpen} onClose={() => setShareOpen(false)} />
        </Group>
        <PipelineDots ctx={ctx} />
      </Stack>
    );
  }
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
            <Menu.Item onClick={() => setShareOpen(true)} data-testid="btn-share">
              {SHARE.label}…
            </Menu.Item>
            <Menu.Item onClick={() => setTargetsOpen(true)} data-testid="btn-targets">
              {TARGETS.label}
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
            <Menu.Divider />
            {/* The `?` items fold into the kebab on mobile (M-T8.18). */}
            <HelpMenuItems ctx={ctx} />
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
      <TargetsDrawer ctx={ctx} opened={targetsOpen} onClose={() => setTargetsOpen(false)} />
      <ShareDialog ctx={ctx} opened={shareOpen} onClose={() => setShareOpen(false)} />
    </Group>
    <PipelineDots ctx={ctx} />
    </Stack>
  );
}
