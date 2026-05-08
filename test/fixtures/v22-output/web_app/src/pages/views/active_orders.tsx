// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Group, Anchor, Table, Loader, Alert, Text } from "@mantine/core";
import { useActiveOrdersView } from "../../api/views";

export default function ActiveOrdersViewPage() {
  const q = useActiveOrdersView();
  return (
    <Stack data-testid="view-active_orders">
      <Group justify="space-between">
        <Title order={2}>Active Orders</Title>
        <Anchor component={Link} to="/views">← back</Anchor>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && <Text c="dimmed">No rows.</Text>}
      {q.data && q.data.length > 0 && (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>id</Table.Th>
              <Table.Th>customerId</Table.Th>
              <Table.Th>status</Table.Th>
              <Table.Th>placedAt</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.map((row, idx) => (
              <Table.Tr key={idx} data-testid={`view-active_orders-row-${idx}`}>
                <Table.Td data-testid={`view-active_orders-row-${idx}-id`}>{String(row.id ?? "")}</Table.Td>
                <Table.Td data-testid={`view-active_orders-row-${idx}-customerId`}>{String(row.customerId ?? "")}</Table.Td>
                <Table.Td data-testid={`view-active_orders-row-${idx}-status`}>{String(row.status ?? "")}</Table.Td>
                <Table.Td data-testid={`view-active_orders-row-${idx}-placedAt`}>{String(row.placedAt ?? "")}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
