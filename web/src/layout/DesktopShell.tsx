import { Box, Group, SegmentedControl, Text } from "@mantine/core";
import { useState } from "react";
import { EditorPane } from "./EditorPane";
import { FilesPane } from "./FilesPane";
import { PreviewPane } from "./PreviewPane";
import { ProblemsPanelScrollable } from "./ProblemsPanel";
import { BackendBody, BackendHeader } from "./BackendPanel";
import { modeLabel, type LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// Desktop layout — lifted as-is from the pre-refactor App.tsx so the
// existing Playwright e2e (which runs at the 1280-px desktop viewport)
// keeps passing without selector churn.
//
// Top: Editor pane (flex 1) | Right pane (flex 1.5, Files/Preview tabs)
// Bottom: Problems | Backend split, 220 px tall.
export function DesktopShell({ ctx }: Props): JSX.Element {
  const [rightPane, setRightPane] = useState<"files" | "preview">("files");
  const { files, generateResult, reactBundleStatus, ddl, diagnostics } = ctx;

  return (
    <>
      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
        <EditorPane ctx={ctx} border="right" />
        <Box style={{ flex: 1.5, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Group px="sm" py={4} bg="dark.6" justify="space-between" gap="xs">
            <SegmentedControl
              size="xs"
              value={rightPane}
              onChange={(v) => setRightPane(v as "files" | "preview")}
              data={[
                { label: "Files", value: "files" },
                { label: "Preview", value: "preview" },
              ]}
              data-testid="right-pane-tabs"
            />
            {rightPane === "files" ? (
              <Text size="xs" c="dimmed">
                {files.length} file{files.length === 1 ? "" : "s"} · {modeLabel(generateResult)}
              </Text>
            ) : (() => {
              switch (reactBundleStatus.kind) {
                case "ok":
                  return (
                    <Text size="xs" c={ddl ? "green" : "dimmed"}>
                      {ddl ? "live" : "needs Boot"}
                    </Text>
                  );
                case "fail":
                  return (
                    <Text size="xs" c="red" title="The React bundle failed — see Bundle errors in the Files tab for details.">
                      preview bundle failed
                    </Text>
                  );
                case "absent":
                  return (
                    <Text size="xs" c="dimmed" title="This example has no React deployable — pick a system-mode example (e.g. Sales System) to enable Preview.">
                      no preview
                    </Text>
                  );
                case "pending":
                  return (
                    <Text size="xs" c="dimmed">
                      needs Bundle
                    </Text>
                  );
              }
            })()}
          </Group>
          {rightPane === "files" ? <FilesPane ctx={ctx} /> : <PreviewPane ctx={ctx} />}
        </Box>
      </Box>
      {/* Bottom panel — Problems on one half, Backend on the other,
          side by side, fixed 220 px. */}
      <Box
        style={{
          height: 220,
          flexShrink: 0,
          borderTop: "1px solid var(--mantine-color-dark-4)",
          background: "var(--mantine-color-dark-7)",
          overflow: "hidden",
          display: "flex",
        }}
      >
        <Box
          style={{
            flex: 1,
            minWidth: 0,
            borderRight: "1px solid var(--mantine-color-dark-4)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Group px="sm" py={4} bg="dark.6" gap="xs">
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Problems
            </Text>
          </Group>
          <ProblemsPanelScrollable items={diagnostics} />
        </Box>
        <Box style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <Group px="sm" py={4} bg="dark.6" justify="space-between" gap="xs" wrap="wrap">
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Backend
            </Text>
            <BackendHeader ctx={ctx} />
          </Group>
          <BackendBody ctx={ctx} />
        </Box>
      </Box>
    </>
  );
}
