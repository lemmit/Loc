// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Group, Anchor, Table, Loader, Alert, Text } from "@mantine/core";
import { useOrderSummaryView } from "../../api/views";

export default function OrderSummaryViewPage() {
  const q = useOrderSummaryView();
  return (
    <Stack data-testid="view-order_summary">
      <Group justify="space-between">
        <Title order={2}>Order Summary</Title>
        <Anchor component={Link} to="/views">← back</Anchor>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && <Text c="dimmed">No rows.</Text>}
      {q.data && q.data.length > 0 && (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>orderId</Table.Th>
              <Table.Th>status</Table.Th>
              <Table.Th>lineCount</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.map((row, idx) => (
              <Table.Tr key={idx} data-testid={`view-order_summary-row-${idx}`}>
                <Table.Td data-testid={`view-order_summary-row-${idx}-orderId`}><Anchor component={Link} to={`/orders/${row.orderId}`}>{String(row.orderId).slice(0, 8)}…</Anchor></Table.Td>
                <Table.Td data-testid={`view-order_summary-row-${idx}-status`}>{String(row.status ?? "")}</Table.Td>
                <Table.Td data-testid={`view-order_summary-row-${idx}-lineCount`}>{String(row.lineCount ?? "")}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
