import { useState } from "react";
import {
  Button,
  Code,
  Group,
  ScrollArea,
  Stack,
  Table,
  Text,
  Textarea,
} from "@mantine/core";
import type { QueryResult } from "../runtime/protocol";

const LIST_TABLES_SQL =
  "SELECT table_name FROM information_schema.tables\nWHERE table_schema = 'public'\nORDER BY table_name;";

// Cap rendered rows so a `SELECT *` on a large table can't lock up the
// panel painting thousands of <tr>s — the count line still reports the
// true total.
const MAX_RENDER_ROWS = 500;

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function SqlResult({ result }: { result: QueryResult }): JSX.Element {
  if (!result.ok) {
    return (
      <Code
        block
        c="red"
        style={{ whiteSpace: "pre-wrap", fontSize: 11 }}
        data-testid="sql-error"
      >
        {result.message}
      </Code>
    );
  }

  // No columns → a write statement (INSERT/UPDATE/DELETE/DDL).
  if (result.fields.length === 0) {
    return (
      <Text size="xs" c="dimmed" data-testid="sql-affected">
        OK — {result.affectedRows} row{result.affectedRows === 1 ? "" : "s"} affected
        {" · "}
        {result.durationMs} ms
      </Text>
    );
  }

  const shown = result.rows.slice(0, MAX_RENDER_ROWS);
  return (
    <Stack gap={4} data-testid="sql-result">
      <Text size="xs" c="dimmed">
        {result.rows.length} row{result.rows.length === 1 ? "" : "s"} · {result.durationMs} ms
        {result.rows.length > MAX_RENDER_ROWS ? ` (showing first ${MAX_RENDER_ROWS})` : ""}
      </Text>
      <ScrollArea.Autosize mah={260} type="auto">
        <Table striped withTableBorder withColumnBorders stickyHeader fz={11}>
          <Table.Thead>
            <Table.Tr>
              {result.fields.map((f) => (
                <Table.Th key={f}>{f}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((row, i) => (
              <Table.Tr key={i}>
                {result.fields.map((f) => (
                  <Table.Td key={f} style={{ whiteSpace: "nowrap" }}>
                    {renderCell(row[f])}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
    </Stack>
  );
}

export interface SqlConsoleProps {
  runQuery: (sql: string) => Promise<QueryResult>;
  isDesktop: boolean;
}

/** Ad-hoc SQL runner against the booted PGlite — one statement at a
 *  time, with a results table for SELECTs and an affected-row count for
 *  writes.  Defaults to listing the public tables so it's useful the
 *  moment you open it. */
export function SqlConsole({ runQuery, isDesktop }: SqlConsoleProps): JSX.Element {
  const [sql, setSql] = useState<string>(LIST_TABLES_SQL);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);

  async function run(query?: string): Promise<void> {
    const text = (query ?? sql).trim();
    if (text.length === 0) return;
    setRunning(true);
    try {
      setResult(await runQuery(text));
    } finally {
      setRunning(false);
    }
  }

  function runListTables(): void {
    setSql(LIST_TABLES_SQL);
    void run(LIST_TABLES_SQL);
  }

  return (
    <Stack gap={6}>
      <Textarea
        size="xs"
        value={sql}
        onChange={(e) => setSql(e.currentTarget.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
          }
        }}
        placeholder="SELECT * FROM …"
        autosize
        minRows={3}
        maxRows={isDesktop ? 8 : 10}
        styles={{
          input: {
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: isDesktop ? 12 : 16,
          },
        }}
        data-testid="sql-input"
      />
      <Group gap={6}>
        <Button size="xs" onClick={() => void run()} loading={running} data-testid="btn-run-sql">
          Run
        </Button>
        <Button size="xs" variant="default" onClick={runListTables} data-testid="btn-list-tables">
          List tables
        </Button>
        <Text size="xs" c="dimmed">
          ⌘/Ctrl + Enter
        </Text>
      </Group>
      {result && <SqlResult result={result} />}
    </Stack>
  );
}
