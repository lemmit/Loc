import { lazy, Suspense, useState } from "react";
import { Box, Button, Drawer, Group, SegmentedControl, Stack, Tabs, Text, UnstyledButton } from "@mantine/core";
import { EditorPane } from "./EditorPane";
import { FilesPane } from "./FilesPane";
import { PreviewPane } from "./PreviewPane";
import { AuthConfigPanel } from "./AuthConfigPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import { TestsBody } from "./TestsPanel";
import { HistoryBody } from "./HistoryPanel";
import { MigrationsBody } from "./MigrationsPanel";
import { ChatBody } from "./ChatPanel";
import { OutputPanel, outputMark } from "./OutputPanel";
import { PaneErrorBoundary } from "../PaneErrorBoundary";
import { ExamplesSheet } from "./ExamplesPane";
import { FirstRunCard } from "./FirstRunCard";
import { devClaimsHeader, type LayoutCtx, type MobileCodeView, type MobileTab } from "./ctx";
import {
  agentMark,
  authMark,
  type Mark,
  migrationsMark,
  runtimeMark,
  StatusMark,
  testsMark,
  worstMark,
} from "./status-mark";
import { PANE } from "./vocabulary";

// The visual Builder (craft.js + a main-thread Langium parse) and the
// Model graph (React Flow) are heavy — lazily loaded so neither lands in
// the main mobile chunk until its sub-view is opened, mirroring DesktopShell.
const BuilderPane = lazy(() => import("../builder/BuilderPane"));
const ModelBuilderPane = lazy(() => import("../builder/system-v2/SystemBuilderV2Pane"));
const RequirementsPane = lazy(() => import("../builder/requirements/RequirementsPane"));

interface Props {
  ctx: LayoutCtx;
}

const TAB_VALUES: readonly MobileTab[] = [
  "code",
  "preview",
  "output",
  "backend",
  "tests",
  "migrations",
  "history",
  "agent",
  "auth",
] as const;

function isMobileTab(v: string | null): v is MobileTab {
  return v !== null && (TAB_VALUES as readonly string[]).includes(v);
}

/** The panes behind **More** — the bottom sheet (audit M1).  Their
 *  `mobile-tab-*` ids live on the sheet rows. */
const SECONDARY: readonly { id: MobileTab; label: string }[] = [
  { id: "tests", label: PANE.tests },
  { id: "migrations", label: PANE.migrations },
  { id: "history", label: PANE.history },
  { id: "agent", label: PANE.agent },
  { id: "auth", label: PANE.auth },
];

// Mobile layout — single fullscreen pane at a time, switched via a
// bottom tab bar.  Stacking the editor on top of the right pane (as
// the old responsive layout did) leaves each with ~120 px on an
// iPhone-sized viewport, which is unusable.  Foregrounding one
// panel at a time gives Code the entire viewport minus header +
// tab-bar (~660 px), enough to actually read and write code.
//
// Four primary tabs (Code, Preview, Runtime, Output) plus **More**, which
// opens a bottom sheet with the rest — nine tabs wrapped onto two rows on a
// 390 px phone and broke the thumb-bar idiom (audit M1).
//
// Active tab + persistence live in App.tsx so the header's Run
// cascade can navigate to Preview/Backend on a clean boot.  We just
// read it off the ctx here.
export function MobileShell({ ctx }: Props): JSX.Element {
  const { activeTab, setActiveTab, codeView, setCodeView } = ctx;
  const [moreOpen, setMoreOpen] = useState(false);
  const marks: Record<MobileTab, Mark | null> = {
    code: null,
    preview: null,
    output: outputMark(ctx),
    backend: runtimeMark(ctx),
    tests: testsMark(ctx),
    migrations: migrationsMark(ctx),
    history: null,
    agent: agentMark(ctx),
    auth: authMark(ctx, devClaimsHeader(ctx.authStub) != null),
  };
  const secondaryActive = SECONDARY.find((s) => s.id === activeTab) ?? null;
  const moreMark = worstMark(SECONDARY.map((s) => marks[s.id]));

  const pick = (t: MobileTab): void => {
    setActiveTab(t);
    setMoreOpen(false);
  };

  return (
    <>
    <Tabs
      value={activeTab}
      onChange={(v) => {
        // "more" is a button in tab's clothing: it opens the sheet and
        // leaves the active pane alone.
        if (v === "more") {
          setMoreOpen(true);
          return;
        }
        if (isMobileTab(v)) setActiveTab(v);
      }}
      keepMounted
      // `inverted` flips the tab list to the bottom — the iOS / Android
      // idiom for primary navigation, thumb-reachable.
      inverted
      styles={{
        root: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
        panel: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
        list: { borderTop: "1px solid var(--mantine-color-dark-4)" },
        tab: {
          // ≥ 44 px tap target per iOS HIG.
          minHeight: 48,
          fontSize: 12,
          paddingLeft: 6,
          paddingRight: 6,
        },
        tabSection: { marginLeft: 4 },
      }}
      data-testid="mobile-tabs"
    >
      <Tabs.Panel value="code">
        {/* Consolidated source / builder / model / generated view — the
            mobile counterpart of the desktop center pane.  A SegmentedControl
            drives the three editable views; the "Generated" chip switches to
            the generated-file browser (and deselects the segments). */}
        <Group px={6} py={6} bg="dark.6" gap={8} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
          <SegmentedControl
            size="xs"
            value={codeView === "generated" ? "" : codeView}
            onChange={(v) => setCodeView(v as MobileCodeView)}
            data={[
              { value: "source", label: <span data-testid="mobile-doc-tab-source">{PANE.source}</span> },
              { value: "builder", label: <span data-testid="mobile-doc-tab-builder">{PANE.builder}</span> },
              { value: "model", label: <span data-testid="mobile-doc-tab-model">{PANE.model}</span> },
              { value: "requirements", label: <span data-testid="mobile-doc-tab-requirements">{PANE.requirements}</span> },
            ]}
          />
          <Button
            size="xs"
            variant={codeView === "generated" ? "filled" : "default"}
            onClick={() => setCodeView("generated")}
            data-testid="mobile-doc-tab-generated"
          >
            {PANE.generated}
          </Button>
          {/* Chat is a peer of Source on desktop (M-T8.19 slice 1); on a
              phone it stays its own full-screen pane — this is the jump to
              it, so the switcher reads the same on both. */}
          <Button
            size="xs"
            variant="default"
            onClick={() => ctx.openChat()}
            data-testid="mobile-doc-tab-chat"
          >
            {PANE.chat}
          </Button>
        </Group>
        {/* Editor stays mounted (display toggle) so Monaco keeps its model +
            undo history; Builder/Model mount only while active so they
            re-parse the current source on each switch. */}
        <Box style={{ flex: 1, minHeight: 0, display: codeView === "source" ? "flex" : "none", flexDirection: "column" }}>
          {/* Stacked above the textarea, not over it — nothing is covered
              on a phone (M-T8.18). */}
          {ctx.firstRunVisible && <FirstRunCard ctx={ctx} />}
          <EditorPane ctx={ctx} />
        </Box>
        {codeView === "builder" && (
          <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <PaneErrorBoundary name="Builder">
              <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading builder…</Text></Box>}>
                <BuilderPane ctx={ctx} />
              </Suspense>
            </PaneErrorBoundary>
          </Box>
        )}
        {codeView === "model" && (
          <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <PaneErrorBoundary name="Model">
              <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading model…</Text></Box>}>
                <ModelBuilderPane ctx={ctx} />
              </Suspense>
            </PaneErrorBoundary>
          </Box>
        )}
        {codeView === "requirements" && (
          <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <PaneErrorBoundary name="Requirements">
              <Suspense fallback={<Box p="md"><Text size="sm" c="dimmed">Loading requirements…</Text></Box>}>
                <RequirementsPane ctx={ctx} />
              </Suspense>
            </PaneErrorBoundary>
          </Box>
        )}
        {codeView === "generated" && (
          <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <FilesPane ctx={ctx} />
          </Box>
        )}
      </Tabs.Panel>
      <Tabs.Panel value="preview">
        <PreviewPane ctx={ctx} />
      </Tabs.Panel>
      <Tabs.Panel value="output">
        <OutputPanel ctx={ctx} stream={ctx.outputStream} setStream={ctx.setOutputStream} />
      </Tabs.Panel>
      <Tabs.Panel value="backend">
        {/* Status badge + Boot/Reset move into a header banner above
            the form, since Tabs.List on a bottom-tab nav only holds
            short labels.  Wrapping it in a Group with wrap="wrap"
            keeps the layout sane on narrow screens. */}
        <Group px="sm" py={6} bg="dark.6" justify="flex-end" gap="xs" wrap="wrap">
          <BackendHeader ctx={ctx} />
        </Group>
        <BackendBody ctx={ctx} />
      </Tabs.Panel>
      <Tabs.Panel value="tests">
        <TestsBody ctx={ctx} active={activeTab === "tests"} />
      </Tabs.Panel>
      <Tabs.Panel value="migrations">
        {/* Evolution lifecycle — schema migrations, wire-contract breaking
            changes, and provenance-snapshot capture against a pinned git
            baseline.  Desktop parity (the dock's Migrations tab); the async
            git reads are gated on visibility. */}
        <MigrationsBody ctx={ctx} active={activeTab === "migrations"} />
      </Tabs.Panel>
      <Tabs.Panel value="history">
        <HistoryBody ctx={ctx} active={activeTab === "history"} />
      </Tabs.Panel>
      <Tabs.Panel value="agent">
        <ChatBody ctx={ctx} />
      </Tabs.Panel>
      <Tabs.Panel value="auth">
        <AuthConfigPanel ctx={ctx} />
      </Tabs.Panel>
      <Tabs.List grow>
        <Tabs.Tab value="code" data-testid="mobile-tab-code">{PANE.code}</Tabs.Tab>
        <Tabs.Tab value="preview" data-testid="mobile-tab-preview">{PANE.preview}</Tabs.Tab>
        <Tabs.Tab
          value="backend"
          data-testid="mobile-tab-backend"
          rightSection={marks.backend ? <StatusMark mark={marks.backend} /> : undefined}
        >
          {PANE.runtime}
        </Tabs.Tab>
        {/* A count (errors) or a dot when any stream is flagged — the user
            shouldn't need to open the panel to discover something went red. */}
        <Tabs.Tab
          value="output"
          data-testid="mobile-tab-output"
          rightSection={marks.output ? <StatusMark mark={marks.output} /> : undefined}
        >
          {PANE.output}
        </Tabs.Tab>
        <Tabs.Tab
          value="more"
          data-testid="mobile-tab-more"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          data-secondary-active={secondaryActive?.id}
          rightSection={moreMark ? <StatusMark mark={moreMark} /> : undefined}
          // Reads as the active tab while one of its panes is showing:
          // the label becomes that pane's name and takes the active tint.
          style={
            secondaryActive
              ? { color: "var(--mantine-primary-color-filled)", borderColor: "var(--mantine-primary-color-filled)" }
              : undefined
          }
        >
          {secondaryActive ? secondaryActive.label : PANE.more}
        </Tabs.Tab>
      </Tabs.List>
    </Tabs>
    <Drawer
      opened={moreOpen}
      onClose={() => setMoreOpen(false)}
      position="bottom"
      size="auto"
      title={PANE.more}
      padding="sm"
      styles={{ content: { borderTopLeftRadius: 12, borderTopRightRadius: 12 } }}
    >
      <Stack gap={4} role="listbox" aria-label={PANE.more} data-testid="mobile-more-sheet">
        {SECONDARY.map((s) => (
          <UnstyledButton
            key={s.id}
            role="option"
            aria-selected={activeTab === s.id}
            onClick={() => pick(s.id)}
            data-testid={`mobile-tab-${s.id}`}
            px="sm"
            py={10}
            style={{
              borderRadius: 8,
              // ≥ 44 px tap target.
              minHeight: 44,
              background: activeTab === s.id ? "var(--mantine-color-default-hover)" : undefined,
            }}
          >
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" fw={activeTab === s.id ? 600 : 400}>
                {s.label}
              </Text>
              <StatusMark mark={marks[s.id]} />
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
    </Drawer>
    <ExamplesSheet ctx={ctx} opened={ctx.examplesOpen} onClose={() => ctx.setExamplesOpen(false)} />
    </>
  );
}
