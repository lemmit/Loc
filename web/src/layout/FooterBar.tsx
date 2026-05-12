import { Group, Text } from "@mantine/core";
import {
  formatBytes,
  formatUnsupportedDeployables,
  modeLabel,
  type LayoutCtx,
} from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// Status strip at the bottom of the AppShell.  Reads pipeline state
// to summarise generation + bundle progress in one line.  On mobile
// the right-side details collapse onto the same line — Mantine `Group`
// with `wrap="wrap"` handles overflow gracefully.
export function FooterBar({ ctx }: Props): JSX.Element {
  const { isDesktop, generateResult, honoBundleResult, unsupportedDeployables } = ctx;
  return (
    <Group h="100%" px="md" gap="md" justify="space-between" wrap="wrap">
      {isDesktop && (
        <Text size="xs" c="dimmed">
          Loom Playground — editor + LSP + generator + bundler + runtime
        </Text>
      )}
      <Group gap="md" wrap="wrap">
        <Text size="xs" c="dimmed">
          {generateResult?.ok === false
            ? `generate: ${generateResult.diagnostics.filter((d) => d.severity === "error").length} error(s)`
            : generateResult?.ok
              ? `generated ${generateResult.files.length} file(s) (${modeLabel(generateResult)})`
              : "no generation yet"}
        </Text>
        {unsupportedDeployables.length > 0 && (
          <Text size="xs" c="yellow">
            files-only: {formatUnsupportedDeployables(unsupportedDeployables)}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {honoBundleResult === null
            ? "no bundle yet"
            : honoBundleResult.ok
              ? `bundled ${formatBytes(honoBundleResult.size)} in ${honoBundleResult.durationMs} ms (${honoBundleResult.fetchedUrls.length} deps fetched)`
              : `bundle: ${honoBundleResult.diagnostics.filter((d) => d.severity === "error").length} error(s)`}
        </Text>
      </Group>
    </Group>
  );
}
