import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import type { LayoutCtx } from "./ctx";

interface Props {
  ctx: LayoutCtx;
}

// The right-aligned cluster on the Backend panel header — booted/
// offline + persistence + migration badges, Reset DB, Boot/Reboot.
// Lifted out so both shells can reuse it: desktop renders it inside
// a Group beside the "Backend" label, mobile renders it in a banner
// above the form body (Mantine Tabs.List only holds the labels).
export function BackendHeader({ ctx }: Props): JSX.Element {
  const { pipeline, ddl, persistent, migrated, honoBundle, runBoot, runWipe } = ctx;
  return (
    <Group gap="xs" wrap="wrap" justify="flex-end">
      {ddl ? (
        <Badge size="xs" color="green" variant="light" data-testid="backend-status">booted</Badge>
      ) : (
        <Badge size="xs" color="gray" variant="light" data-testid="backend-status">offline</Badge>
      )}
      {ddl && (
        <Badge
          size="xs"
          color={persistent ? "blue" : "gray"}
          variant="light"
          title={
            persistent
              ? "Rows survive page reload — PGlite is OPFS-backed, keyed by source hash."
              : "Browser refused OPFS storage — rows live in memory and are wiped on reload."
          }
          data-testid="persistence-status"
        >
          {persistent ? "persisted" : "in-memory"}
        </Badge>
      )}
      {ddl && migrated && (
        <Badge
          size="xs"
          color="orange"
          variant="light"
          title="Schema changed since the previous boot — DROP SCHEMA + re-applied DDL.  Pre-existing rows were dropped."
          data-testid="migrated-status"
        >
          schema migrated
        </Badge>
      )}
      {ddl && (
        <Button
          size="xs"
          variant="default"
          onClick={runWipe}
          title="Drop every row in the booted PGlite and re-apply the schema."
          data-testid="btn-wipe"
        >
          Reset DB
        </Button>
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
  } = ctx;

  // iOS Safari auto-zooms on input focus when the input's font is
  // < 16 px.  Bumping mobile to 16 px keeps zoom away without
  // forcing the desktop UI to look gigantic.
  const mobileInputStyles = isDesktop ? undefined : { input: { fontSize: 16 } };

  return (
    <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }} p="xs">
      {bootErrorMessage && (
        <Code block c="red" mb="xs" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
          {bootErrorMessage}
        </Code>
      )}
      {ddl ? (
        <Stack gap={6}>
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
              placeholder="/products"
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
          {(reqMethod === "POST" || reqMethod === "PUT" || reqMethod === "PATCH") && (
            <Textarea
              size="xs"
              value={reqBody}
              onChange={(e) => setReqBody(e.currentTarget.value)}
              placeholder='{"sku": "W-1", "price": {"amount": 5, "currency": "USD"}}'
              autosize
              minRows={2}
              maxRows={isDesktop ? 4 : 6}
              styles={{
                input: {
                  fontFamily: "var(--mantine-font-family-monospace)",
                  fontSize: isDesktop ? 11 : 16,
                },
              }}
              data-testid="req-body"
            />
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
      ) : (
        <Text size="xs" c="dimmed">
          {honoBundle
            ? "Click Boot to spin up PGlite + the generated Hono app."
            : "Generate and Bundle first to enable the backend."}
        </Text>
      )}
    </Box>
  );
}
