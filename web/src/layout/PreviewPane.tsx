import { Box, Text } from "@mantine/core";
import { Preview } from "../preview/Preview";
import { formatUnsupportedDeployables, type LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// Preview iframe wrapper — when the React bundle is ready and the
// backend is booted, mount <Preview>.  Otherwise show a hint that
// describes the next required step.
export function PreviewPane({ ctx }: Props): JSX.Element {
  const {
    previewBundle,
    previewBooted,
    previewProblem,
    ddl,
    engine,
    generateSuccess,
    reactBundleStatus,
    unsupportedDeployables,
  } = ctx;

  // When the only deployables in the generated output are runtimes
  // the browser can't host (.NET, Phoenix LiveView), explain why
  // Preview is grey — the user otherwise hits a generic "no React
  // frontend" message that hides the real reason.
  const absentHint =
    unsupportedDeployables.length > 0
      ? `This example only declares ${formatUnsupportedDeployables(unsupportedDeployables)}, which the browser playground can't host.  Files-only — pick a system with a Hono + React deployable (e.g. Sales System) to use Preview.`
      : "This example has no React frontend.  Pick a system-mode example (e.g. Sales System) to use Preview.";

  return (
    <Box style={{ flex: 1, minHeight: 0, position: "relative" }}>
      {previewBundle && previewBooted && engine ? (
        <>
          <Preview
            js={previewBundle.code}
            css={previewBundle.css}
            versions={previewBundle.versions}
            vendorImportmap={previewBundle.vendorImportmap}
            vendorCssUrl={previewBundle.vendorCssUrl}
            runtime={engine}
            onAppLog={ctx.appendAppLog}
          />
          {previewProblem && (
            <Box
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                zIndex: 5,
                pointerEvents: "none",
              }}
            >
              <Text
                size="xs"
                fw={600}
                c="white"
                bg="red.7"
                px="xs"
                py={2}
                style={{ borderRadius: 4 }}
                data-testid="preview-stale-badge"
              >
                Latest build failed — showing last working preview
              </Text>
            </Box>
          )}
        </>
      ) : (
        <Box p="md">
          <Text size="sm" c="dimmed">
            {!generateSuccess
              ? "Generate a system-mode source first (the Sales System example has both Hono + React deployables)."
              : reactBundleStatus.kind === "absent"
                ? absentHint
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
