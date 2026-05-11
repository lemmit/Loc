import { Box, Text } from "@mantine/core";
import { Preview } from "../preview/Preview";
import type { LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// Preview iframe wrapper — when the React bundle is ready and the
// backend is booted, mount <Preview>.  Otherwise show a hint that
// describes the next required step.
export function PreviewPane({ ctx }: Props): JSX.Element {
  const { reactBundle, ddl, runtimeClient, generateSuccess, reactBundleStatus } = ctx;

  return (
    <Box style={{ flex: 1, minHeight: 0 }}>
      {reactBundle && ddl && runtimeClient ? (
        <Preview
          js={reactBundle.code}
          css={reactBundle.css}
          versions={reactBundle.versions}
          runtime={runtimeClient}
        />
      ) : (
        <Box p="md">
          <Text size="sm" c="dimmed">
            {!generateSuccess
              ? "Generate a system-mode source first (the Sales System example has both Hono + React deployables)."
              : reactBundleStatus.kind === "absent"
                ? "This example has no React frontend.  Pick a system-mode example (e.g. Sales System) to use Preview."
                : reactBundleStatus.kind === "fail"
                  ? "React bundling failed — switch to Files for details."
                  : reactBundleStatus.kind === "pending"
                    ? "Click Bundle to compile the React frontend (~10 s on first run)."
                    : !ddl
                      ? "Boot the backend first — the React app calls into PGlite via the runtime worker."
                      : "Loading…"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
