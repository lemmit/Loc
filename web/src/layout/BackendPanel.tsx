import { useState } from "react";
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
import { JsonBodyEditor } from "../backend/JsonBodyEditor";
import { SqlConsole } from "../backend/SqlConsole";
import { CUSTOM_ENDPOINT, groupEndpointsByTag } from "../backend/openapi";

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
export function BackendHeader({ ctx }: Props): JSX.Element {
  const { pipeline, ddl, honoBundle, runBoot } = ctx;
  return (
    <Group gap="xs" wrap="wrap" justify="flex-end">
      {ddl ? (
        <Badge size="xs" color="green" variant="light" data-testid="backend-status">booted</Badge>
      ) : (
        <Badge size="xs" color="gray" variant="light" data-testid="backend-status">offline</Badge>
      )}
      <Button
        size="xs"
        onClick={runBoot}
        loading={pipeline.booting}
        disabled={!honoBundle}
        variant="default"
        data-testid="btn-boot"
      >
        {ddl ? "Reboot" : "Boot"}
      </Button>
    </Group>
  );
}

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
  } = ctx;

  // Which sub-view of the Runtime tab is showing — the API console or
  // the Database console.  Local UI state; not worth persisting.
  const [subview, setSubview] = useState<"api" | "db">("api");

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
          <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="boot-error">
            {bootErrorMessage}
          </Code>
          {honoBundle && (
            <Group gap={6} align="center">
              <Button
                size="xs"
                variant="default"
                color="red"
                onClick={runResetData}
                loading={pipeline.booting}
                data-testid="btn-reset-data"
              >
                Clear stored data &amp; retry
              </Button>
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
            onChange={(v) => setSubview(v as "api" | "db")}
            data={[
              { label: "API", value: "api" },
              { label: "Database", value: "db" },
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
              <JsonBodyEditor
                value={reqBody}
                onChange={setReqBody}
                isDesktop={isDesktop}
              />
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
              <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }} data-testid="resp-err">
                {dispatchSlot.message}
              </Code>
            )
          )}
          </Stack>
          )}
        </Stack>
      ) : (
        <Text size="xs" c="dimmed">
          {honoBundle
            ? "Click Boot to spin up PGlite + the generated Hono app."
            : "Generate and Bundle first to enable the runtime."}
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

      <Stack gap={4}>
        <Button
          size="xs"
          variant="default"
          color="red"
          onClick={runWipe}
          style={{ alignSelf: "flex-start" }}
          data-testid="btn-wipe"
        >
          Reset database
        </Button>
        <Text size="xs" c="dimmed">
          Drops every row and re-applies the schema. The table structure stays — only your data is cleared.
        </Text>
      </Stack>
    </Stack>
  );
}
