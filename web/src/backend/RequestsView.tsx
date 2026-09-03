import { Badge, Box, Code, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import type { LayoutCtx } from "../layout/ctx";
import { OutputStreamLink } from "../layout/OutputStreamLink";
import { interpretStatus, REQUESTS, STREAM, seeStream } from "../layout/vocabulary";
import type { OperationTrace } from "./route-match";
import { matchRoute } from "./route-match";

// The Requests sub-view (M-T8.22 slice 4): every operation the spec
// declares with the number of requests it served, grouped by aggregate;
// click one for its last request line — and the last response body when the
// API console's own last request was that operation.  Unmatched paths are
// the 404s list.  Reads `ctx.requestTraces`, the aggregate App.tsx derives
// from the runtime log so M-T8.20 can put the same counts on Model nodes.

export function RequestsView({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { requestTraces, dispatchSlot, reqMethod, reqPath, apiEndpoints } = ctx;
  const [openId, setOpenId] = useState<string | null>(null);

  if (requestTraces.total === 0) {
    return (
      <Text size="xs" c="dimmed" data-testid="runtime-requests-empty">
        {REQUESTS.empty(ctx.isDesktop)}
      </Text>
    );
  }

  const groups = new Map<string, OperationTrace[]>();
  for (const t of requestTraces.byOperation) {
    const list = groups.get(t.endpoint.tag) ?? [];
    list.push(t);
    groups.set(t.endpoint.tag, list);
  }
  // Which operation the console's last dispatch hit — its response body is
  // the only one we hold (the log carries status + duration, not bodies).
  const consoleOp = dispatchSlot?.ok ? matchRoute(reqMethod, reqPath, apiEndpoints) : null;

  return (
    <Stack gap="sm" data-testid="runtime-requests">
      <Stack gap={4}>
        <Group gap={6}>
          <Text size="xs" fw={700} tt="uppercase">
            {REQUESTS.heading}
          </Text>
          <Text size="xs" c="dimmed">
            {requestTraces.total} served
          </Text>
        </Group>
        {[...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tag, list]) => (
            <Box key={tag}>
              <Text size="xs" c="dimmed" mb={2}>
                {tag}
              </Text>
              <Stack gap={1}>
                {list.map((t) => {
                  const open = openId === t.endpoint.operationId;
                  return (
                    <Box key={t.endpoint.operationId}>
                      <UnstyledButton
                        onClick={() => setOpenId(open ? null : t.endpoint.operationId)}
                        px={6}
                        py={2}
                        style={{ width: "100%", borderRadius: 4, background: open ? "var(--mantine-color-default-hover)" : undefined }}
                        data-testid={`runtime-request-op-${t.endpoint.operationId}`}
                        data-count={t.count}
                      >
                        <Group gap={8} wrap="nowrap">
                          <Badge
                            size="xs"
                            variant={t.count > 0 ? "filled" : "light"}
                            color={t.errors > 0 ? "red" : t.count > 0 ? "blue" : "gray"}
                            style={{ flexShrink: 0, minWidth: 28 }}
                            data-testid={`runtime-request-count-${t.endpoint.operationId}`}
                          >
                            {t.count}
                          </Badge>
                          <Text size="xs" ff="monospace" truncate style={{ flex: 1 }}>
                            {t.endpoint.method} {t.endpoint.path}
                          </Text>
                          {t.last && (
                            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                              last {t.last.status} · {t.last.durationMs} ms
                            </Text>
                          )}
                        </Group>
                      </UnstyledButton>
                      {open && (
                        <Box pl={12} py={4} data-testid={`runtime-request-detail-${t.endpoint.operationId}`}>
                          {t.last == null ? (
                            <Text size="xs" c="dimmed">
                              Not called yet.
                            </Text>
                          ) : (
                            <Stack gap={4}>
                              <Text size="xs" ff="monospace">
                                {REQUESTS.lastLabel}: {t.last.method} {t.last.path} → {t.last.status} in {t.last.durationMs} ms
                                {t.last.requestId ? ` · req=${t.last.requestId.split("-")[0]}` : ""}
                              </Text>
                              {t.last.status >= 400 && (
                                <Group gap={6} wrap="wrap">
                                  <Text size="xs" c="red">
                                    {interpretStatus(t.last.status)}
                                  </Text>
                                  <OutputStreamLink ctx={ctx} stream="backend" label={seeStream(STREAM.runtimeLogs)} />
                                </Group>
                              )}
                              {consoleOp?.operationId === t.endpoint.operationId && dispatchSlot?.ok ? (
                                <Code block style={{ whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 160, overflow: "auto" }}>
                                  {dispatchSlot.response.body || "(empty body)"}
                                </Code>
                              ) : (
                                <Text size="xs" c="dimmed">
                                  The log keeps status + duration; the body is shown for the API console's own last request.
                                </Text>
                              )}
                            </Stack>
                          )}
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Stack>
            </Box>
          ))}
      </Stack>

      <Stack gap={4} data-testid="runtime-requests-404s">
        <Text size="xs" fw={700} tt="uppercase">
          {REQUESTS.notFoundHeading}
        </Text>
        {requestTraces.unmatched.length === 0 ? (
          <Text size="xs" c="dimmed">
            {REQUESTS.noneNotFound}
          </Text>
        ) : (
          <Stack gap={1}>
            {requestTraces.unmatched.map((u) => (
              <Group key={`${u.method} ${u.path}`} gap={8} wrap="nowrap" px={6} data-testid="runtime-request-404">
                <Badge size="xs" variant="light" color="red" style={{ flexShrink: 0, minWidth: 28 }}>
                  {u.count}
                </Badge>
                <Text size="xs" ff="monospace" truncate style={{ flex: 1 }}>
                  {u.method} {u.path}
                </Text>
                <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                  last {u.lastStatus}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
