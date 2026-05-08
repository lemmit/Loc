// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Group, Anchor, Badge, Table, Alert, Text, Paper, Skeleton } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useOrderSummaryView } from "../../api/views";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "../../lib/format";

export default function OrderSummaryViewPage() {
  const q = useOrderSummaryView();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="view-order_summary" gap="md">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>View</Text>
          <Title order={2}>Order Summary</Title>
          <Text size="sm" c="dimmed">{q.isLoading ? "Loading…" : count === 1 ? "1 row" : count + " rows"}</Text>
        </Stack>
        <Anchor component={Link} to="/views">← back</Anchor>
      </Group>
      {q.isLoading && (
        <Paper p="md">
          <Stack gap="xs">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={28} radius="sm" />
            ))}
          </Stack>
        </Paper>
      )}
      {q.isError && <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load view">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && <Text c="dimmed">No rows.</Text>}
      {q.data && q.data.length > 0 && (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={500}>
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Order Id</Table.Th>
<Table.Th>Status</Table.Th>
<Table.Th>Line Count</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row, idx) => (
                  <Table.Tr key={idx} data-testid={`view-order_summary-row-${idx}`}>
                    <Table.Td data-testid={`view-order_summary-row-${idx}-orderId`}>{ row.orderId ? <Anchor component={Link} to={`/orders/${row.orderId}`} onClick={(e) => e.stopPropagation()}><IdValue id={row.orderId} /></Anchor> : <EmptyValue />}</Table.Td>

<Table.Td data-testid={`view-order_summary-row-${idx}-status`}><Badge tt="unset" variant="light">{row.status}</Badge></Table.Td>

<Table.Td data-testid={`view-order_summary-row-${idx}-lineCount`} style={{ textAlign: "right" }}><NumberValue value={row.lineCount} /></Table.Td>

                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
    </Stack>
  );
}
