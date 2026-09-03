import { Suspense, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type { LayoutCtx } from "./ctx";
import { PlainJsonBody } from "../backend/PlainJsonBody";
import { LazyJsonBodyEditor } from "./lazy-panels";
import { SqlConsole } from "../backend/SqlConsole";
import { CUSTOM_ENDPOINT, groupEndpointsByTag } from "../backend/openapi";
import { RequestsView } from "../backend/RequestsView";
import { TablesView } from "../backend/TablesView";
import {
  DISPATCH_FAILED,
  interpretBootError,
  interpretStatus,
  nextStepMid,
  RUNTIME_STATUS,
  RUNTIME_VIEW,
  seeStream,
  STAGE,
  STREAM,
} from "./vocabulary";
import { ConfirmAction, confirmSites } from "../util/confirm";
import { OutputStreamLink } from "./OutputStreamLink";

interface Props {
  ctx: LayoutCtx;
}

// The right-aligned cluster on the Runtime panel header — booted/
// offline status + Boot/Reboot, the lifecycle gate for both the API
// and Database sub-views.  The DB-specific controls (persistence,
// schema-migration, Reset) moved into the Database sub-view body, where
// there's room to explain what each one means.
// Lifted out so both shells can reuse it: desktop renders it inside
// a Group beside the "Runtime" label, mobile renders it in a banner
// above the form body (Mantine Tabs.List only holds the labels).
// On desktop the Boot button lives on the header's pipeline strip
// (`btn-boot` there — M-T8.16); mobile has no strip buttons, so the
// banner keeps it.
export function BackendHeader({ ctx }: Props): JSX.Element {
  const { isDesktop, pipeline, ddl, honoBundle, runBoot } = ctx;
  return (
    <Group gap="xs" wrap="wrap" justify="flex-end">
      {ddl ? (
        <Badge size="xs" color="green" variant="light" data-testid="backend-status">
          {RUNTIME_STATUS.booted}
        </Badge>
      ) : (
        <Badge size="xs" color="gray" variant="light" data-testid="backend-status">
          {RUNTIME_STATUS.offline}
        </Badge>
      )}
      {!isDesktop && (
        <Button
          size="xs"
          onClick={runBoot}
          loading={pipeline.booting}
          disabled={!honoBundle}
          variant="default"
          data-testid="btn-boot"
        >
          {ddl ? "Reboot" : STAGE.boot}
        </Button>
      )}
    </Group>
  );
}

type Subview = "api" | "db" | "tables" | "requests";
const SUBVIEWS: readonly Subview[] = ["api", "db", "tables", "requests"];
const isSubview = (v: string): v is Subview => (SUBVIEWS as readonly string[]).includes(v);

// The form body: method + path + body + send + response.  No
// resize/scroll wrapper — the shell decides the surrounding box.
export function BackendBody({ ctx }: Props): JSX.Element {
  const {
    isDesktop,
    pipeline,
    ddl,
    persistent,
    migrated,
    bootErrorMessage,
    reqMethod,
    setReqMethod,
    reqPath,
    setReqPath,
    reqBody,
    setReqBody,
    dispatchSlot,
    honoBundle,
    runDispatch,
    runWipe,
    runResetData,
    runQuery,
    apiEndpoints,
    selectedOpId,
    selectedEndpoint,
    runSelectEndpoint,
    pathParamValues,
    setPathParam,
    queryParamValues,
    setQueryParam,
    runGenerateExample,
    requestTraces,
  } = ctx;

  // Which sub-view of the Runtime tab is showing — the API console, the
  // Database console, the read-only Tables view, or the Requests traces
  // (M-T8.22).  Local UI state; not worth persisting.
  const [subview, setSubview] = useState<Subview>("api");

  // iOS Safari auto-zooms on input focus when the input's font is
  // < 16 px.  Bumping mobile to 16 px keeps zoom away without
  // forcing the desktop UI to look gigantic.
  const mobileInputStyles = isDesktop ? undefined : { input: { fontSize: 16 } };

  // Grouped picker data — a "Custom request" escape hatch first, then
  // every discovered endpoint grouped by aggregate.  Empty when the spec
  // couldn't be loaded, in which case the picker is hidden entirely.
  const endpointData =
    apiEndpoints.length > 0
      ? [
          { group: "Manual", items: [{ value: CUSTOM_ENDPOINT, label: "Custom request" }] },
          ...groupEndpointsByTag(apiEndpoints),
        ]
      : [];

  const showBody =
    reqMethod === "POST" || reqMethod === "PUT" || reqMethod === "PATCH";

  return (
    <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }} p="xs">
      {bootErrorMessage && (
        <Stack gap={6} mb="xs">
          {/* One line of interpretation + the stream that holds the stack,
              ABOVE the raw text (audit M19). */}
          <Group gap={6} wrap="wrap" align="baseline">
            <Text size="xs" c="red" data-testid="boot-error-hint" style={{ flex: 1, minWidth: 200 }}>
              {interpretBootError(bootErrorMessage)}
            </Text>
            <OutputStreamLink ctx={ctx} stream="backend" label={seeStream(STREAM.runtimeLogs)} />
          </Group>
          <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="boot-error">
            {bootErrorMessage}
          </Code>
          {honoBundle && (
            <Group gap={6} align="center">
              <ConfirmAction
                spec={confirmSites.clearStoredData()}
                onConfirm={runResetData}
                testids={{ base: "btn-reset-data", yes: "btn-reset-data-confirm" }}
                trigger={(arm) => (
                  <Button
                    size="xs"
                    variant="default"
                    color="red"
                    onClick={arm}
                    loading={pipeline.booting}
                    data-testid="btn-reset-data"
                  >
                    Clear stored data &amp; retry…
                  </Button>
                )}
              />
              <Text size="xs" c="dimmed">
                If the boot fails on stale persisted data, this drops the saved database and reboots clean.
              </Text>
            </Group>
          )}
        </Stack>
      )}
      {ddl ? (
        <Stack gap={8}>
          <SegmentedControl
            size="xs"
            fullWidth
            value={subview}
            onChange={(v) => isSubview(v) && setSubview(v)}
            data={[
              { label: RUNTIME_VIEW.api, value: "api" },
              { label: RUNTIME_VIEW.db, value: "db" },
              { label: RUNTIME_VIEW.tables, value: "tables" },
              {
                label:
                  requestTraces.total > 0
                    ? `${RUNTIME_VIEW.requests} (${requestTraces.total})`
                    : RUNTIME_VIEW.requests,
                value: "requests",
              },
            ]}
            data-testid="runtime-subview"
          />
          {subview === "db" ? (
            <DatabaseView
              persistent={persistent}
              migrated={migrated}
              runWipe={runWipe}
              runQuery={runQuery}
              isDesktop={isDesktop}
            />
          ) : subview === "tables" ? (
            <TablesView ctx={ctx} />
          ) : subview === "requests" ? (
            <RequestsView ctx={ctx} />
          ) : (
          <Stack gap={6}>
          {endpointData.length > 0 && (
            <Select
              size="xs"
              searchable
              value={selectedOpId}
              onChange={(v) => v && runSelectEndpoint(v)}
              data={endpointData}
              placeholder="Pick an endpoint…"
              nothingFoundMessage="No match"
              w="100%"
              styles={mobileInputStyles}
              data-testid="req-endpoint"
            />
          )}
          <Group gap={6} wrap="wrap">
            <Select
              size="xs"
              value={reqMethod}
              onChange={(v) => v && setReqMethod(v)}
              data={["GET", "POST", "PUT", "DELETE", "PATCH"]}
              allowDeselect={false}
              w={isDesktop ? 90 : "100%"}
              styles={mobileInputStyles}
              data-testid="req-method"
            />
            <TextInput
              size="xs"
              value={reqPath}
              onChange={(e) => setReqPath(e.currentTarget.value)}
              placeholder="/api/products"
              style={{ flex: isDesktop ? 1 : "1 1 100%" }}
              styles={mobileInputStyles}
              data-testid="req-path"
            />
            <Button
              size={isDesktop ? "xs" : "sm"}
              onClick={runDispatch}
              loading={pipeline.dispatching}
              disabled={ddl === null}
              data-testid="btn-send"
            >
              Send
            </Button>
          </Group>
          {selectedEndpoint && selectedEndpoint.pathParams.length > 0 && (
            <Group gap={6} wrap="wrap">
              {selectedEndpoint.pathParams.map((name) => (
                <TextInput
                  key={name}
                  size="xs"
                  label={name}
                  value={pathParamValues[name] ?? ""}
                  onChange={(e) => setPathParam(name, e.currentTarget.value)}
                  placeholder={name}
                  style={{ flex: isDesktop ? 1 : "1 1 100%" }}
                  styles={mobileInputStyles}
                  data-testid={`req-pathparam-${name}`}
                />
              ))}
            </Group>
          )}
          {selectedEndpoint && selectedEndpoint.queryParams.length > 0 && (
            <Group gap={6} wrap="wrap">
              {selectedEndpoint.queryParams.map((q) => (
                <TextInput
                  key={q.name}
                  size="xs"
                  label={q.required ? `${q.name} *` : q.name}
                  value={queryParamValues[q.name] ?? ""}
                  onChange={(e) => setQueryParam(q.name, e.currentTarget.value)}
                  placeholder={q.name}
                  style={{ flex: isDesktop ? 1 : "1 1 100%" }}
                  styles={mobileInputStyles}
                  data-testid={`req-queryparam-${q.name}`}
                />
              ))}
            </Group>
          )}
          {showBody && (
            <Stack gap={4}>
              <Group justify="space-between" align="center">
                <Text size="xs" c="dimmed">Request body</Text>
                {selectedEndpoint?.requestSchema && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={runGenerateExample}
                    data-testid="btn-gen-example"
                  >
                    Generate example
                  </Button>
                )}
              </Group>
              {/* Monaco on desktop (lazy — it is not on the eager path);
                  a textarea on mobile, which never fetches it at all. */}
              {isDesktop ? (
                <Suspense fallback={<Text size="xs" c="dimmed">Loading editor…</Text>}>
                  <LazyJsonBodyEditor
                    value={reqBody}
                    onChange={setReqBody}
                    isDesktop={isDesktop}
                  />
                </Suspense>
              ) : (
                <PlainJsonBody value={reqBody} onChange={setReqBody} isDesktop={isDesktop} />
              )}
            </Stack>
          )}
          {dispatchSlot && (
            dispatchSlot.ok ? (
              <Box data-testid="resp-ok">
                <Group gap={6} mb={4}>
                  <Badge
                    size="xs"
                    color={dispatchSlot.response.status < 400 ? "green" : "red"}
                    variant="filled"
                    data-testid="resp-status"
                  >
                    {dispatchSlot.response.status} {dispatchSlot.response.statusText}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {dispatchSlot.durationMs} ms
                  </Text>
                </Group>
                {/* An error status gets one line of interpretation + the
                    stream that explains it, ABOVE the raw body (audit M19). */}
                {dispatchSlot.response.status >= 400 && (
                  <Group gap={6} wrap="wrap" align="baseline" mb={4}>
                    <Text size="xs" c="red" data-testid="resp-hint" style={{ flex: 1, minWidth: 200 }}>
                      {interpretStatus(dispatchSlot.response.status)}
                    </Text>
                    {dispatchSlot.response.status >= 500 && (
                      <OutputStreamLink ctx={ctx} stream="backend" label={seeStream(STREAM.runtimeLogs)} />
                    )}
                    {dispatchSlot.response.status === 404 && (
                      <Button size="compact-xs" variant="subtle" onClick={() => setSubview("requests")} data-testid="resp-see-404s">
                        See 404s →
                      </Button>
                    )}
                  </Group>
                )}
                <Code
                  block
                  style={{
                    whiteSpace: "pre-wrap",
                    fontSize: 11,
                    // Desktop caps the response box so the form
                    // doesn't push the rest of the panel off-screen.
                    // Mobile gives it room to breathe — the panel is
                    // the foregrounded tab, no other content competes.
                    maxHeight: isDesktop ? 100 : undefined,
                    overflow: "auto",
                  }}
                  data-testid="resp-body"
                >
                  {dispatchSlot.response.body || "(empty body)"}
                </Code>
              </Box>
            ) : (
              <Stack gap={4}>
                <Group gap={6} wrap="wrap" align="baseline">
                  <Text size="xs" c="red" data-testid="resp-err-hint" style={{ flex: 1, minWidth: 200 }}>
                    {DISPATCH_FAILED}
                  </Text>
                  <OutputStreamLink ctx={ctx} stream="backend" label={seeStream(STREAM.runtimeLogs)} />
                </Group>
                <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="resp-err">
                  {dispatchSlot.message}
                </Code>
              </Stack>
            )
          )}
          </Stack>
          )}
        </Stack>
      ) : (
        <Text size="xs" c="dimmed">
          {honoBundle
            ? `${isDesktop ? `Click ${STAGE.boot}` : nextStepMid("boot", false)} to start the generated API and an in-browser Postgres. You can then call endpoints and run SQL here.`
            : `${nextStepMid("boot", isDesktop)} to start the generated API and an in-browser Postgres.`}
        </Text>
      )}
    </Box>
  );
}

interface DatabaseViewProps {
  persistent: boolean;
  migrated: boolean;
  runWipe: () => void;
  runQuery: LayoutCtx["runQuery"];
  isDesktop: boolean;
}

// The Database sub-view: a plain-language account of where the data
// lives, the ad-hoc SQL console, and a clearly-explained Reset.
function DatabaseView({
  persistent,
  migrated,
  runWipe,
  runQuery,
  isDesktop,
}: DatabaseViewProps): JSX.Element {
  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Group gap={6}>
          <Badge
            size="xs"
            color={persistent ? "blue" : "gray"}
            variant="light"
            data-testid="persistence-status"
          >
            {persistent ? "persisted" : "in-memory"}
          </Badge>
          {migrated && (
            <Badge size="xs" color="orange" variant="light" data-testid="migrated-status">
              schema migrated
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {persistent
            ? "Rows are saved in your browser (OPFS), keyed by the source hash — they survive a page reload."
            : "Your browser refused persistent storage, so rows live in memory and are wiped on reload."}
        </Text>
        {migrated && (
          <Text size="xs" c="dimmed">
            The schema changed since the last boot, so the database was dropped and recreated — earlier rows were cleared.
          </Text>
        )}
      </Stack>

      <SqlConsole runQuery={runQuery} isDesktop={isDesktop} />

      <ResetDatabase runWipe={runWipe} />
    </Stack>
  );
}

// Two-step reset: the first click reveals the consequence and a confirm,
// so one stray click can't drop every row.  The explanation sits ABOVE
// the button so it is read before, not after, the action.  The two-step
// itself is the shared `ConfirmAction` (inline shape) — the same control
// every other destructive action in the playground uses.
function ResetDatabase({ runWipe }: { runWipe: () => void }): JSX.Element {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        Reset drops every row and re-applies the schema. The table structure stays — only your data is cleared.
      </Text>
      <ConfirmAction
        spec={confirmSites.resetDatabase()}
        onConfirm={runWipe}
        testids={{ base: "btn-wipe", yes: "btn-wipe-confirm" }}
        trigger={(arm) => (
          <Button
            size="xs"
            variant="default"
            color="red"
            onClick={arm}
            style={{ alignSelf: "flex-start" }}
            data-testid="btn-wipe"
          >
            Reset database…
          </Button>
        )}
      />
    </Stack>
  );
}
