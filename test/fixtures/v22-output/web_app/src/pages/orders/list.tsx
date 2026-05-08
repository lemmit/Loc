// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Loader, Alert, Anchor, Badge, Center, Text } from "@mantine/core";
import { useAllOrders } from "../../api/order";

export default function OrderList() {
  const navigate = useNavigate();
  const q = useAllOrders();
  return (
    <Stack data-testid="orders-list">
      <Group justify="space-between">
        <Title order={2}>Orders</Title>
        <Button onClick={() => navigate("/orders/new")} data-testid="orders-list-create">Create order</Button>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Center mih={200} data-testid="orders-list-empty">
          <Stack gap="xs" align="center">
            <Text c="dimmed">No orders yet.</Text>
            <Button variant="light" onClick={() => navigate("/orders/new")}>
              Create your first order
            </Button>
          </Stack>
        </Center>
      )}
      {q.data && q.data.length > 0 && (
        <Table striped withTableBorder highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>id</Table.Th>
              <Table.Th>customerId</Table.Th>
              <Table.Th>status</Table.Th>
              <Table.Th>placedAt</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.map((row) => (
              <Table.Tr key={row.id} data-testid={`orders-row-${row.id}`}>
                <Table.Td><Anchor component={Link} to={`/orders/${row.id}`} data-testid={`orders-row-${row.id}-link`}>{row.id.slice(0, 8)}…</Anchor></Table.Td>
                <Table.Td data-testid={`orders-row-${row.id}-customerId`}>{String(row.customerId ?? "")}</Table.Td>
                <Table.Td data-testid={`orders-row-${row.id}-status`}><Badge tt="unset">{row.status}</Badge></Table.Td>
                <Table.Td data-testid={`orders-row-${row.id}-placedAt`}>{String(row.placedAt ?? "")}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
