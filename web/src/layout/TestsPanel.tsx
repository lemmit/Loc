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
import { findUiTestFile, runUiSuite, uiSuiteFiles } from "../testing/run-ui-tests";
import { makeIframeTransport } from "../testing/iframe-transport";
import type { TestResult } from "../testing/harness";

// "Tests" dock tab — runs the generated `test e2e` suites in-browser
// against the booted runtime.  API suites (`against <backend>`) hit the
// runtime engine's dispatch; UI suites (`against <react>`) drive the
// preview iframe through the message-driven driver.
export function TestsBody({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { engine, ddl, generateSuccess } = ctx;
  const files = generateSuccess?.files ?? [];
  const apiFile = useMemo(() => findApiTestFile(files), [generateSuccess]);
  const uiFile = useMemo(() => findUiTestFile(files), [generateSuccess]);

  const [running, setRunning] = useState<"api" | "ui" | null>(null);
  const [apiResults, setApiResults] = useState<TestResult[] | null>(null);
  const [uiResults, setUiResults] = useState<TestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<TsTransformClient | null>(null);
  useEffect(() => {
    return () => {
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);
  const client = (): TsTransformClient =>
    (clientRef.current ??= new TsTransformClient());

  const runApi = async (): Promise<void> => {
    if (!apiFile || !engine) return;
    setError(null);
    setApiResults(null);
    setRunning("api");
    try {
      await engine.wipe();
      setApiResults(
        await runApiTests({
          source: apiFile.content,
          compile: (ts) => client().compile(ts),
          dispatch: (req) => engine.dispatch(req),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const runUi = async (): Promise<void> => {
    if (!uiFile || !engine) return;
    setError(null);
    setUiResults(null);
    setRunning("ui");
    try {
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe[data-testid="preview-iframe"]',
      );
      if (!iframe) {
        throw new Error("Preview isn't mounted — Bundle + Boot first.");
      }
      await engine.wipe();
      setUiResults(
        await runUiSuite({
          entry: uiFile.path,
          files: uiSuiteFiles(files, uiFile),
          bundle: (entry, fs) => client().buildUi(entry, fs),
          transport: makeIframeTransport(iframe, { timeout: 8000 }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  if (!apiFile && !uiFile) {
    return (
      <Text c="dimmed" size="sm" p="sm">
        This system declares no <Code>test e2e</Code> blocks. Add some (and
        Generate) to run them here.
      </Text>
    );
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Group px="sm" py={6} gap="sm" wrap="wrap">
        {apiFile && (
          <Button
            size="xs"
            onClick={() => void runApi()}
            loading={running === "api"}
            disabled={!ddl || running !== null}
            title="Reset the DB, then run the API e2e suite against the booted runtime."
            data-testid="btn-run-api-tests"
          >
            Run API tests
          </Button>
        )}
        {uiFile && (
          <Button
            size="xs"
            variant="light"
            onClick={() => void runUi()}
            loading={running === "ui"}
            disabled={!ddl || running !== null}
            title="Reset the DB, then drive the preview through the generated page objects."
            data-testid="btn-run-ui-tests"
          >
            Run UI tests
          </Button>
        )}
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
          <ResultsBlock title="API" results={apiResults} />
          <ResultsBlock title="UI" results={uiResults} />
          {!apiResults && !uiResults && !error && (
            <Text c="dimmed" size="sm">
              {ddl ? "Run a suite above." : "Generate, Bundle and Boot, then run."}
            </Text>
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}

function ResultsBlock({
  title,
  results,
}: {
  title: string;
  results: TestResult[] | null;
}): JSX.Element | null {
  if (!results) return null;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.length - passed;
  return (
    <Box mb="sm" data-testid={`test-results-${title.toLowerCase()}`}>
      <Group gap={6} mb={4}>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed">
          {title}
        </Text>
        <Badge size="sm" color="green" variant="light">
          {passed} passed
        </Badge>
        {failed > 0 && (
          <Badge size="sm" color="red" variant="light">
            {failed} failed
          </Badge>
        )}
      </Group>
      <Stack gap={6}>
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
    </Box>
  );
}
