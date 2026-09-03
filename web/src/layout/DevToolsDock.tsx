import { Box, Group, Text, UnstyledButton } from "@mantine/core";
import { AuthConfigPanel, authStubDot } from "./AuthConfigPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import { agentDot, ChatBody } from "./ChatPanel";
import { TestsBody } from "./TestsPanel";
import { HistoryBody } from "./HistoryPanel";
import { MigrationsBody, migrationsDot } from "./MigrationsPanel";
import { OutputPanel, outputAggregateDot } from "./OutputPanel";
import { type DockTab, type LayoutCtx } from "./ctx";
import { PANE } from "./vocabulary";

// `DockTab` (the consolidated bottom-dock tab ids) is defined in ctx.ts so
// LayoutCtx can carry the active-tab state; re-exported here so existing
// importers (`DesktopShell`) keep resolving it from DevToolsDock.  The
// `"agent"` tab (the deterministic demo) is part of that shared type.
export type { DockTab };

interface Props {
  ctx: LayoutCtx;
  tab: DockTab;
  setTab: (t: DockTab) => void;
}

type DotColour = "red" | "yellow" | "green" | "gray" | null;

export function DevToolsDock({ ctx, tab, setTab }: Props): JSX.Element {
  const { ddl } = ctx;

  // Green once booted; nothing while offline — a permanent grey dot reads
  // as "something needs attention" and dilutes the red/yellow ones.
  const backendDot: DotColour = ddl ? "green" : null;

  const tabs: { id: DockTab; label: string; dot: DotColour }[] = [
    { id: "output", label: PANE.output, dot: outputAggregateDot(ctx) },
    { id: "agent", label: PANE.agent, dot: agentDot(ctx) },
    { id: "backend", label: PANE.runtime, dot: backendDot },
    { id: "tests", label: PANE.tests, dot: null },
    { id: "migrations", label: PANE.migrations, dot: migrationsDot(ctx) },
    { id: "history", label: PANE.history, dot: null },
    { id: "auth", label: PANE.auth, dot: authStubDot(ctx) },
  ];

  return (
    <Box style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group
        px="sm"
        py={4}
        bg="dark.6"
        gap="xs"
        justify="space-between"
        wrap="nowrap"
        style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Group gap={2} wrap="nowrap" data-testid="devtools-tabs">
          {tabs.map((t) => (
            <UnstyledButton
              key={t.id}
              onClick={() => setTab(t.id)}
              data-testid={`devtools-tab-${t.id}`}
              data-active={tab === t.id || undefined}
              px="xs"
              py={2}
              style={{
                borderRadius: 4,
                background:
                  tab === t.id ? "var(--mantine-color-dark-4)" : "transparent",
              }}
            >
              <Group gap={6} wrap="nowrap">
                <Text
                  size="xs"
                  fw={600}
                  tt="uppercase"
                  c={tab === t.id ? undefined : "dimmed"}
                >
                  {t.label}
                </Text>
                {t.dot && (
                  <Box
                    w={7}
                    h={7}
                    style={{
                      borderRadius: "50%",
                      background: `var(--mantine-color-${t.dot}-6)`,
                    }}
                  />
                )}
              </Group>
            </UnstyledButton>
          ))}
        </Group>
        {tab === "backend" && <BackendHeader ctx={ctx} />}
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "output" && (
          <OutputPanel ctx={ctx} stream={ctx.outputStream} setStream={ctx.setOutputStream} />
        )}
        {tab === "agent" && <ChatBody ctx={ctx} />}
        {tab === "backend" && <BackendBody ctx={ctx} />}
        {tab === "tests" && <TestsBody ctx={ctx} />}
        {tab === "migrations" && <MigrationsBody ctx={ctx} />}
        {tab === "history" && <HistoryBody ctx={ctx} />}
        {tab === "auth" && <AuthConfigPanel ctx={ctx} />}
      </Box>
    </Box>
  );
}
