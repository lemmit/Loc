import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import { TsTransformClient } from "../testing/transform-client";
import { findApiTestFile, runApiTests } from "../testing/run-api-tests";
import type { TestResult } from "../testing/harness";

// "Tests" dock tab — runs the generated `test e2e … against <backend>`
// suite (emitted as `e2e/<System>.e2e.test.ts`) in-browser against the
// booted runtime, with pass/fail per test.  No Node, no real vitest:
// the suite's `fetch` is routed through the runtime engine's dispatch
// and its `vitest` slice is re-implemented by `web/src/testing/*`.
export function TestsBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { engine, ddl, generateSuccess } = ctx;
  const testFile = useMemo(
    () => findApiTestFile(generateSuccess?.files ?? []),
    [generateSuccess],
  );

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lazily spin the esbuild-wasm transform worker only when the user
  // first runs tests; dispose on unmount.
  const clientRef = useRef<TsTransformClient | null>(null);
  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  const canRun = !!testFile && !!engine && !!ddl && !running;

  const onRun = async (): Promise<void> => {
    if (!testFile || !engine) return;
    setError(null);
    setResults(null);
    setRunning(true);
    try {
      clientRef.current ??= new TsTransformClient();
      const client = clientRef.current;
      // Reset rows first so re-runs are deterministic — the generated
      // suites assume a clean DB (the docker e2e boots fresh).
      await engine.wipe();
      const out = await runApiTests({
        source: testFile.content,
        compile: (ts) => client.compile(ts),
        dispatch: (req) => engine.dispatch(req),
      });
      setResults(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (!testFile) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        This system declares no{" "}
        <Code>test e2e &quot;…&quot; against &lt;backend&gt;</Code> blocks.
        Add one (and Generate) to run API tests here.
      </Text>
    );
  }

  const passed = results?.filter((r) => r.status === "pass").length ?? 0;
  const failed = results?.filter((r) => r.status === "fail").length ?? 0;

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={6} gap="sm" wrap="wrap" justify="space-between">
        <Group gap="sm">
          <Button
            size="xs"
            onClick={() => void onRun()}
            loading={running}
            disabled={!canRun}
            title="Reset the DB, then run the generated API e2e suite against the booted runtime."
            data-testid="btn-run-tests"
          >
            Run API tests
          </Button>
          {results && (
            <Group gap={6} data-testid="test-summary">
              <Badge size="sm" color="green" variant="light">
                {passed} passed
              </Badge>
              {failed > 0 && (
                <Badge size="sm" color="red" variant="light">
                  {failed} failed
                </Badge>
              )}
            </Group>
          )}
        </Group>
        {!ddl && (
          <Text size="xs" c="dimmed">
            Boot the backend to run tests.
          </Text>
        )}
      </Group>

      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box px="sm" pb="sm">
          {error && (
            <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="test-error">
              {error}
            </Code>
          )}
          {results && (
            <Stack gap={6} data-testid="test-results">
              {results.map((r, i) => (
                <Box key={i} data-testid="test-row">
                  <Group gap={8} wrap="nowrap">
                    <Badge
                      size="xs"
                      color={r.status === "pass" ? "green" : "red"}
                      variant="filled"
                    >
                      {r.status}
                    </Badge>
                    <Text size="sm" style={{ flex: 1 }}>
                      {r.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {Math.round(r.durationMs)} ms
                    </Text>
                  </Group>
                  {r.error && (
                    <Code
                      block
                      c="red"
                      mt={4}
                      style={{ whiteSpace: "pre-wrap", fontSize: 11 }}
                    >
                      {r.error}
                    </Code>
                  )}
                </Box>
              ))}
            </Stack>
          )}
          {!results && !error && (
            <Text c="dimmed" size="sm">
              {ddl
                ? "Click “Run API tests” to execute the generated suite."
                : "Generate, Bundle and Boot, then run the suite."}
            </Text>
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}
