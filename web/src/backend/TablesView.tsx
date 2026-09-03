import { Badge, Box, Button, Code, Group, Loader, Stack, Text, UnstyledButton } from "@mantine/core";
import { useEffect, useState } from "react";
import type { LayoutCtx } from "../layout/ctx";
import { RUNTIME_USERS, STREAM, seeStream } from "../layout/vocabulary";
import { OutputStreamLink } from "../layout/OutputStreamLink";
import type { QueryResult } from "../runtime/protocol";
import { SqlResult } from "./SqlConsole";
import {
  firstRowsSql,
  LIST_USER_TABLES_SQL,
  readUserTables,
  TABLE_PREVIEW_ROWS,
  tableLabel,
  type UserTable,
} from "./tables-query";
import { usersState } from "./users";

// The read-only Tables sub-view of the Runtime tab (M-T8.22 slice 3; the
// model-driven family's "see your data" view — Encore, Prisma Studio).
// `information_schema.tables` → table list → first 50 rows of the picked
// table, all through the existing `runQuery` RPC.  Read-only by
// construction: the only SQL sent is the two literals in `tables-query.ts`.
// Every async read has a failure branch with Retry (audit M18).

type Loading<T> = { kind: "loading" } | { kind: "ok"; value: T } | { kind: "error"; message: string };

export function TablesView({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const { runQuery, ddl, isDesktop } = ctx;
  const [tables, setTables] = useState<Loading<UserTable[]>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<UserTable | null>(null);
  const [rows, setRows] = useState<Loading<QueryResult> | null>(null);

  // Re-list when the schema (re)boots or the user retries.
  useEffect(() => {
    let cancelled = false;
    setTables({ kind: "loading" });
    void runQuery(LIST_USER_TABLES_SQL)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) setTables({ kind: "error", message: r.message });
        else setTables({ kind: "ok", value: readUserTables(r.rows) });
      })
      .catch((err: unknown) => {
        if (!cancelled) setTables({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ddl, attempt]);

  const open = (t: UserTable): void => {
    setPicked(t);
    setRows({ kind: "loading" });
    void runQuery(firstRowsSql(t.schema, t.name))
      .then((r) => setRows(r.ok ? { kind: "ok", value: r } : { kind: "error", message: r.message }))
      .catch((err: unknown) => setRows({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  };

  return (
    <Group gap="md" align="flex-start" wrap={isDesktop ? "nowrap" : "wrap"} data-testid="runtime-tables">
      <Stack gap={6} style={{ flex: isDesktop ? "0 0 220px" : "1 1 100%", minWidth: 0 }}>
        <Text size="xs" fw={700} tt="uppercase">
          Tables
        </Text>
        {tables.kind === "loading" ? (
          <Group gap={6}>
            <Loader size={10} />
            <Text size="xs" c="dimmed">
              Listing tables…
            </Text>
          </Group>
        ) : tables.kind === "error" ? (
          <ErrorRow
            testid="runtime-tables-error"
            hint="The table list could not be read from the in-browser Postgres."
            message={tables.message}
            ctx={ctx}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : tables.value.length === 0 ? (
          <Text size="xs" c="dimmed" data-testid="runtime-tables-empty">
            No tables — the schema has no persisted aggregate yet.
          </Text>
        ) : (
          <Stack gap={2} data-testid="runtime-tables-list">
            {tables.value.map((t) => {
              const active = picked?.schema === t.schema && picked?.name === t.name;
              return (
                <UnstyledButton
                  key={`${t.schema}.${t.name}`}
                  onClick={() => open(t)}
                  px={6}
                  py={2}
                  data-testid={`runtime-table-${t.name}`}
                  data-active={active || undefined}
                  style={{
                    borderRadius: 4,
                    background: active ? "var(--mantine-color-default-hover)" : undefined,
                    fontFamily: "var(--mantine-font-family-monospace)",
                    fontSize: 12,
                  }}
                >
                  {tableLabel(t)}
                </UnstyledButton>
              );
            })}
          </Stack>
        )}
        <UsersStrip ctx={ctx} />
      </Stack>

      <Box style={{ flex: "1 1 auto", minWidth: 0 }} data-testid="runtime-table-rows">
        {picked == null ? (
          <Text size="xs" c="dimmed">
            Pick a table to see its first {TABLE_PREVIEW_ROWS} rows. Read-only — writes go through the Database view.
          </Text>
        ) : (
          <Stack gap={4}>
            <Group gap={6}>
              <Text size="xs" fw={600} ff="monospace">
                {tableLabel(picked)}
              </Text>
              <Text size="xs" c="dimmed">
                first {TABLE_PREVIEW_ROWS} rows
              </Text>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => open(picked)} data-testid="runtime-table-refresh">
                Refresh
              </Button>
            </Group>
            {rows == null || rows.kind === "loading" ? (
              <Group gap={6}>
                <Loader size={10} />
                <Text size="xs" c="dimmed">
                  Reading rows…
                </Text>
              </Group>
            ) : rows.kind === "error" ? (
              <ErrorRow
                testid="runtime-table-rows-error"
                hint="The rows could not be read."
                message={rows.message}
                ctx={ctx}
                onRetry={() => open(picked)}
              />
            ) : (
              <SqlResult result={rows.value} />
            )}
          </Stack>
        )}
      </Box>
    </Group>
  );
}

function ErrorRow({
  testid,
  hint,
  message,
  ctx,
  onRetry,
}: {
  testid: string;
  hint: string;
  message: string;
  ctx: LayoutCtx;
  onRetry: () => void;
}): JSX.Element {
  return (
    <Stack gap={4} data-testid={testid}>
      <Group gap={6} wrap="wrap">
        <Text size="xs" c="red">
          {hint}
        </Text>
        <OutputStreamLink ctx={ctx} stream="backend" label={seeStream(STREAM.runtimeLogs)} />
        <Button size="compact-xs" variant="subtle" onClick={onRetry} data-testid={`${testid}-retry`}>
          Retry
        </Button>
      </Group>
      <Code block c="red" style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
        {message}
      </Code>
    </Stack>
  );
}

// The identities requests carry — the generated dev stub's built-in one
// and the Auth tab's override — beside the tables, so "why does this row
// say created_by admin" answers itself.
function UsersStrip({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  const state = usersState(ctx.generateSuccess?.files ?? [], ctx.authStub);
  return (
    <Stack gap={4} mt="xs" data-testid="runtime-users">
      <Text size="xs" fw={700} tt="uppercase">
        {RUNTIME_USERS.heading}
      </Text>
      {state.kind === "none" ? (
        <Text size="xs" c="dimmed">
          {RUNTIME_USERS.none}
        </Text>
      ) : state.kind === "oidc" ? (
        <Text size="xs" c="dimmed">
          {RUNTIME_USERS.oidc}
        </Text>
      ) : (
        state.identities.map((id) => (
          <Box
            key={id.kind}
            p={6}
            data-testid={`runtime-user-${id.kind}`}
            style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 4 }}
          >
            <Badge size="xs" variant="light" color={id.kind === "override" ? "green" : "gray"} mb={4}>
              {id.kind === "override" ? RUNTIME_USERS.override : RUNTIME_USERS.builtIn}
            </Badge>
            <Stack gap={0}>
              {Object.entries(id.claims).map(([k, v]) => (
                <Text key={k} size="xs" ff="monospace" truncate title={`${k}: ${v}`}>
                  <Text span c="dimmed">
                    {k}:
                  </Text>{" "}
                  {v}
                </Text>
              ))}
            </Stack>
          </Box>
        ))
      )}
    </Stack>
  );
}
