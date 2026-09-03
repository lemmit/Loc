import { Box, Group, Tabs, Tooltip, UnstyledButton } from "@mantine/core";
import { AuthConfigPanel } from "./AuthConfigPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import { TestsBody } from "./TestsPanel";
import { HistoryBody } from "./HistoryPanel";
import { MigrationsBody } from "./MigrationsPanel";
import { OutputPanel, outputMark } from "./OutputPanel";
import { devClaimsHeader, type DockTab, type LayoutCtx } from "./ctx";
import {
  agentMark,
  authMark,
  type Mark,
  migrationsMark,
  runtimeMark,
  StatusMark,
  testsMark,
} from "./status-mark";
import { CHAT, PANE } from "./vocabulary";

// `DockTab` (the consolidated bottom-dock tab ids) is defined in ctx.ts so
// LayoutCtx can carry the active-tab state; re-exported here so existing
// importers (`DesktopShell`) keep resolving it from DevToolsDock.
//
// `"agent"` is STILL a member of that type — the mobile shell's tab bar and
// the persisted desktop dock state both name it — but on desktop it is no
// longer a dock PANEL.  M-T8.19 moved the chat into the centre switcher (it is
// a peer of Source, not a log stream: research §4 #1), so what sits in the
// tab strip here is a SHORTCUT carrying the same `devtools-tab-agent` id, and
// clicking it focuses the centre tab instead of swapping the dock.
export type { DockTab };

interface Props {
  ctx: LayoutCtx;
  tab: DockTab;
  setTab: (t: DockTab) => void;
}

const DOCK_TABS: readonly DockTab[] = [
  "output",
  "backend",
  "tests",
  "migrations",
  "history",
  "auth",
] as const;

function isDockTab(v: string | null): v is DockTab {
  return v !== null && (DOCK_TABS as readonly string[]).includes(v);
}

// The desktop bottom dock — a real tablist (M-T8.16 slice 3, audit M12):
// Mantine `Tabs` gives `role="tab"`, `aria-selected` and arrow-key
// navigation for free; the `devtools-tab-*` ids stay on the tabs.  Status
// is a count badge where a count exists (errors, failed tests, destructive
// migrations) and a dot with a hidden label otherwise (audit M11).
export function DevToolsDock({ ctx, tab, setTab }: Props): JSX.Element {
  const tabs: { id: DockTab; label: string; mark: Mark | null }[] = [
    { id: "output", label: PANE.output, mark: outputMark(ctx) },
    { id: "backend", label: PANE.runtime, mark: runtimeMark(ctx) },
    { id: "tests", label: PANE.tests, mark: testsMark(ctx) },
    { id: "migrations", label: PANE.migrations, mark: migrationsMark(ctx) },
    { id: "history", label: PANE.history, mark: null },
    { id: "auth", label: PANE.auth, mark: authMark(ctx, devClaimsHeader(ctx.authStub) != null) },
  ];

  return (
    <Tabs
      value={tab}
      onChange={(v) => isDockTab(v) && setTab(v)}
      variant="pills"
      color="gray"
      keepMounted={false}
      styles={{
        root: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column" },
        list: { gap: 2, flexWrap: "nowrap" },
        tab: {
          padding: "2px 8px",
          minHeight: 0,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          borderRadius: 4,
        },
        tabSection: { marginLeft: 6 },
        panel: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
      }}
    >
      <Group
        px="sm"
        py={4}
        bg="dark.6"
        gap="xs"
        justify="space-between"
        wrap="nowrap"
        style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Tabs.List data-testid="devtools-tabs" aria-label={PANE.devTools}>
          {tabs.map((t) => (
            <Tabs.Tab
              key={t.id}
              value={t.id}
              data-testid={`devtools-tab-${t.id}`}
              rightSection={t.mark ? <StatusMark mark={t.mark} testid={`devtools-mark-${t.id}`} /> : undefined}
            >
              {t.label}
            </Tabs.Tab>
          ))}
          {/* Not a tab: a jump to the Chat centre tab, keeping the public
              `devtools-tab-agent` id the specs and the palette use. */}
          <AgentShortcut ctx={ctx} />
        </Tabs.List>
        {tab === "backend" && <BackendHeader ctx={ctx} />}
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Tabs.Panel value="output">
          <OutputPanel ctx={ctx} stream={ctx.outputStream} setStream={ctx.setOutputStream} />
        </Tabs.Panel>
        <Tabs.Panel value="backend">
          <BackendBody ctx={ctx} />
        </Tabs.Panel>
        <Tabs.Panel value="tests">
          <TestsBody ctx={ctx} />
        </Tabs.Panel>
        <Tabs.Panel value="migrations">
          <MigrationsBody ctx={ctx} />
        </Tabs.Panel>
        <Tabs.Panel value="history">
          <HistoryBody ctx={ctx} />
        </Tabs.Panel>
        <Tabs.Panel value="auth">
          <AuthConfigPanel ctx={ctx} />
        </Tabs.Panel>
      </Box>
    </Tabs>
  );
}

/** The Agent entry in the dock's tab strip.  It LOOKS like the tabs beside it
 *  (same pill chrome, same status mark) but it is a plain button: chat is a
 *  centre view now, so activating it moves focus there rather than filling the
 *  dock.  `role="link"` keeps it out of the tablist's arrow-key rotation while
 *  staying keyboard reachable. */
function AgentShortcut({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const mark = agentMark(ctx);
  return (
    <Tooltip label={CHAT.dockShortcut} withArrow position="top">
      <UnstyledButton
        role="link"
        data-testid="devtools-tab-agent"
        onClick={() => ctx.openChat()}
        px={8}
        py={2}
        style={{
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--mantine-color-dimmed)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {PANE.agent}
        {mark && <StatusMark mark={mark} testid="devtools-mark-agent" />}
        <span aria-hidden>↗</span>
      </UnstyledButton>
    </Tooltip>
  );
}
