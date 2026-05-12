import { Box, Group, Indicator, Tabs } from "@mantine/core";
import { EditorPane } from "./EditorPane";
import { FilesPane } from "./FilesPane";
import { PreviewPane } from "./PreviewPane";
import { ProblemsPanelScrollable } from "./ProblemsPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import type { LayoutCtx, MobileTab } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

const TAB_VALUES: readonly MobileTab[] = ["code", "files", "preview", "problems", "backend"] as const;

function isMobileTab(v: string | null): v is MobileTab {
  return v !== null && (TAB_VALUES as readonly string[]).includes(v);
}

// Mobile layout — single fullscreen pane at a time, switched via a
// bottom tab bar.  Stacking the editor on top of the right pane (as
// the old responsive layout did) leaves each with ~120 px on an
// iPhone-sized viewport, which is unusable.  Foregrounding one
// panel at a time gives Code the entire viewport minus header +
// tab-bar (~660 px), enough to actually read and write code.
//
// Active tab + persistence live in App.tsx so the header's Run
// cascade can navigate to Preview/Backend on a clean boot.  We just
// read it off the ctx here.
export function MobileShell({ ctx }: Props): JSX.Element {
  const { activeTab, setActiveTab, errorCount, diagnostics } = ctx;

  return (
    <Tabs
      value={activeTab}
      onChange={(v) => isMobileTab(v) && setActiveTab(v)}
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
        },
      }}
      data-testid="mobile-tabs"
    >
      <Tabs.Panel value="code">
        <EditorPane ctx={ctx} />
      </Tabs.Panel>
      <Tabs.Panel value="files">
        <FilesPane ctx={ctx} />
      </Tabs.Panel>
      <Tabs.Panel value="preview">
        <PreviewPane ctx={ctx} />
      </Tabs.Panel>
      <Tabs.Panel value="problems">
        <ProblemsPanelScrollable items={diagnostics} />
      </Tabs.Panel>
      <Tabs.Panel value="backend">
        {/* Status badges + Boot/Reset move into a header banner above
            the form, since Tabs.List on a bottom-tab nav only holds
            short labels.  Wrapping it in a Group with wrap="wrap"
            keeps the layout sane on narrow screens. */}
        <Group px="sm" py={6} bg="dark.6" justify="flex-end" gap="xs" wrap="wrap">
          <BackendHeader ctx={ctx} />
        </Group>
        <BackendBody ctx={ctx} />
      </Tabs.Panel>
      <Tabs.List grow>
        <Tabs.Tab value="code" data-testid="mobile-tab-code">Code</Tabs.Tab>
        <Tabs.Tab value="files" data-testid="mobile-tab-files">Files</Tabs.Tab>
        <Tabs.Tab value="preview" data-testid="mobile-tab-preview">Preview</Tabs.Tab>
        <Tabs.Tab value="problems" data-testid="mobile-tab-problems">
          {/* Red dot when there are errors — the user shouldn't need
              to switch panels to discover the source has problems. */}
          <Indicator size={6} color="red" disabled={errorCount === 0} offset={-2}>
            <Box>Problems</Box>
          </Indicator>
        </Tabs.Tab>
        <Tabs.Tab value="backend" data-testid="mobile-tab-backend">Backend</Tabs.Tab>
      </Tabs.List>
    </Tabs>
  );
}
