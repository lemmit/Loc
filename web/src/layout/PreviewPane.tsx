import { Box, Button, Group, Text } from "@mantine/core";
import { selectNodePath } from "../build/select-target";
import { Preview } from "../preview/Preview";
import { formatUnsupportedDeployables, type LayoutCtx } from "./ctx";
import { nextStepMid, SELECT_MODE, STAGE } from "./vocabulary";

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
    authedRuntime,
    generateSuccess,
    reactBundleStatus,
    unsupportedDeployables,
    isDesktop,
    pipeline,
  } = ctx;
  // Mobile has one "Run" button that spans Generate → Bundle → Boot;
  // desktop exposes the three steps separately.  Name the control the
  // user can actually see.
  const runVerb = nextStepMid("generate", isDesktop);

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
            runtime={authedRuntime}
            onAppLog={ctx.appendAppLog}
            onSelectElement={ctx.resolveSelectedElement}
          />
          <SelectResultBar ctx={ctx} />
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
            {pipeline.generating
              ? "Generating…"
              : pipeline.bundling
                ? "Bundling the frontend and backend — about 10 s on first run…"
                : pipeline.booting
                  ? "Starting the in-browser backend…"
                  : !generateSuccess
                    ? `Nothing generated yet — ${runVerb} to build the project from your source.`
                    : reactBundleStatus.kind === "absent"
                      ? absentHint
                      : reactBundleStatus.kind === "fail"
                        ? "The bundle failed, so there is nothing to preview. Open Output → Bundler for the error."
                        : reactBundleStatus.kind === "pending"
                          ? `${nextStepMid("bundle", isDesktop)} to compile the frontend and backend (~10 s on first run)${isDesktop ? `, then ${STAGE.boot}` : ""}.`
                          : !ddl
                            ? `Bundled. ${isDesktop ? `Click ${STAGE.boot}` : nextStepMid("boot", false)} to start the in-browser backend and database.`
                            : "Loading…"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** What the last preview select-mode click resolved to (M-T8.20 slice 4).
 *
 *  A one-line result under the preview rather than a modal: the resolution
 *  already REVEALED the declaration in the editor, so this says what was
 *  found and offers the two follow-ups the mission names — open it in the
 *  Builder, or hand the node path to the agent. */
function SelectResultBar({ ctx }: { ctx: LayoutCtx }): JSX.Element | null {
  const result = ctx.selectResult;
  if (!result) return null;
  const message =
    result.kind === "unidentified"
      ? SELECT_MODE.unidentified
      : result.kind === "unresolved"
        ? SELECT_MODE.unresolved(result.testid)
        : SELECT_MODE.found(selectNodePath(result.target));
  return (
    <Box
      px="sm"
      py={4}
      bg="dark.6"
      style={{ borderTop: "1px solid var(--mantine-color-dark-4)" }}
      data-testid="select-result"
      data-kind={result.kind}
    >
      <Group gap={8} wrap="nowrap" justify="space-between">
        <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>
          {message}
        </Text>
        {result.kind === "found" && (
          <Group gap={4} wrap="nowrap">
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => ctx.setCenterView("builder")}
              data-testid="select-open-builder"
            >
              {SELECT_MODE.openBuilder}
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => ctx.askAgent(`Change ${selectNodePath(result.target)}: `)}
              data-testid="select-ask-agent"
            >
              {SELECT_MODE.askAgent}
            </Button>
          </Group>
        )}
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={ctx.dismissSelectResult}
          data-testid="select-result-dismiss"
        >
          Dismiss
        </Button>
      </Group>
    </Box>
  );
}
