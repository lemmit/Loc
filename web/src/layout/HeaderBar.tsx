import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Select,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { PackPicker } from "../workspace/PackPicker";
import { WorkspaceDrawer } from "../workspace/WorkspaceDrawer";
import { WorkspaceSwitcher } from "../workspace/WorkspaceSwitcher";
import { WorkspaceTree } from "../workspace/WorkspaceTree";
import type { LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// Desktop header — full toolbar across two `Group`s.  Unchanged from
// the pre-refactor layout (this is a 1:1 lift to keep desktop stable
// while we focus on mobile).
export function DesktopHeader({ ctx }: Props): JSX.Element {
  const {
    augmentedExamplesList,
    exampleId,
    setExampleId,
    copyShareLink,
    copied,
    workspace,
    buildClient,
    scheduleAutoGenerate,
    runGenerate,
    runBundle,
    pipeline,
    errorCount,
    warningCount,
    liveMode,
    setLiveMode,
    generateSuccess,
  } = ctx;
  return (
    <Group h="100%" px="md" justify="space-between" wrap="wrap" gap="xs">
      <Group gap="md" wrap="wrap">
        <Title order={5}>Loom Playground</Title>
        <WorkspaceSwitcher workspace={workspace} size="xs" />
        <Select
          size="xs"
          value={exampleId}
          onChange={(v) => v && setExampleId(v)}
          data={augmentedExamplesList.map((e) => ({ value: e.id, label: e.label }))}
          allowDeselect={false}
          w={300}
          // Selecting an example imports it into the active workspace
          // (overwriting its sources).  Stable accessible name for screen
          // readers + Playwright locators — without one the combobox is an
          // empty-name `role="textbox"` and the first-match query is
          // order-dependent.
          aria-label="Choose example"
          placeholder="Import example…"
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
      <Group gap="xs" wrap="wrap">
        <Button
          size="xs"
          onClick={runGenerate}
          loading={pipeline.generating}
          disabled={errorCount > 0}
          variant="filled"
          data-testid="btn-generate"
        >
          Generate
        </Button>
        <Button
          size="xs"
          onClick={runBundle}
          loading={pipeline.bundling}
          disabled={!generateSuccess || generateSuccess.files.length === 0}
          variant="default"
          data-testid="btn-bundle"
        >
          Bundle
        </Button>
        <Badge color="red" variant={errorCount > 0 ? "filled" : "light"} size="sm">
          {errorCount} error{errorCount === 1 ? "" : "s"}
        </Badge>
        <Badge color="yellow" variant={warningCount > 0 ? "filled" : "light"} size="sm">
          {warningCount} warning{warningCount === 1 ? "" : "s"}
        </Badge>
        <Switch
          size="xs"
          checked={liveMode}
          onChange={(e) => setLiveMode(e.currentTarget.checked)}
          label="Live"
          data-testid="live-mode"
          title="When on, edits cascade Generate → Bundle → Boot automatically."
        />
      </Group>
    </Group>
  );
}

// Mobile header — single 48 px row.  Logo + example picker on the
// left, primary "Run" button + kebab menu on the right.  Everything
// secondary (Bundle, Share, Pack import, Workspace, Live mode toggle,
// error/warning counts) collapses into the menu so the row never
// wraps to a second line.
export function MobileHeader({ ctx }: Props): JSX.Element {
  const {
    augmentedExamplesList,
    exampleId,
    setExampleId,
    copyShareLink,
    copied,
    workspace,
    buildClient,
    scheduleAutoGenerate,
    runFull,
    runBundle,
    pipeline,
    errorCount,
    warningCount,
    liveMode,
    setLiveMode,
    generateSuccess,
  } = ctx;
  // Spans Generate → Bundle → Boot.  Without it the spinner only
  // showed during the (often instant) Generate step, leaving the
  // user staring at an enabled-looking button for ~10 s while the
  // bundler crunched.  This was the root cause of the "Run does
  // nothing" complaint.
  const runLoading = pipeline.generating || pipeline.bundling || pipeline.booting;
  const [wsDrawerOpen, setWsDrawerOpen] = useState(false);
  return (
    <Group h="100%" px="sm" justify="space-between" gap="xs" wrap="nowrap">
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
          Run
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
            <Menu.Label>
              <Group gap={6}>
                <Badge color="red" variant={errorCount > 0 ? "filled" : "light"} size="xs">
                  {errorCount} err
                </Badge>
                <Badge color="yellow" variant={warningCount > 0 ? "filled" : "light"} size="xs">
                  {warningCount} warn
                </Badge>
              </Group>
            </Menu.Label>
            <Menu.Item
              onClick={runBundle}
              disabled={!generateSuccess || generateSuccess.files.length === 0}
              data-testid="btn-bundle"
            >
              {pipeline.bundling ? "Bundling…" : "Bundle"}
            </Menu.Item>
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
                label="Live mode"
                data-testid="live-mode"
              />
              <Text size="xs" c="dimmed" mt={4}>
                Edits cascade Generate → Bundle → Boot automatically.
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
        exampleId={exampleId}
        onImportExample={setExampleId}
      />
    </Group>
  );
}
