// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Skeleton, Alert, Anchor, Badge, Breadcrumbs, Center, Text, Paper } from "@mantine/core";
import { IconPlus, IconAlertCircle } from "@tabler/icons-react";
import { useAllOrders } from "../../api/order";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "../../lib/format";

export default function OrderList() {
  const navigate = useNavigate();
  const q = useAllOrders();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="orders-list" gap="md">
      <Breadcrumbs data-testid="orders-list-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
<Text>Orders</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>Orders</Title>
          <Text size="sm" c="dimmed">{q.isLoading ? "Loading…" : count === 1 ? "1 record" : count + " records"}</Text>
        </Stack>
        <Button leftSection={<IconPlus size={16} stroke={2} />} onClick={() => navigate("/orders/new")} data-testid="orders-list-create">New order</Button>
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
      {q.isError && <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load orders">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Paper p="xl" data-testid="orders-list-empty">
          <Center mih={160}>
            <Stack gap="xs" align="center">
              <Text c="dimmed">No orders yet.</Text>
              <Button variant="light" onClick={() => navigate("/orders/new")}>
                Create your first order
              </Button>
            </Stack>
          </Center>
        </Paper>
      )}
      {q.data && q.data.length > 0 && (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={500}>
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Id</Table.Th>
<Table.Th>Customer Id</Table.Th>
<Table.Th>Status</Table.Th>
<Table.Th>Placed At</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row) => (
                  <Table.Tr key={row.id} data-testid={`orders-row-${row.id}`} style={{ cursor: "pointer" }} onClick={() => navigate(`/orders/${row.id}`)}>
                    <Table.Td><Anchor component={Link} to={`/orders/${row.id}`} data-testid={`orders-row-${row.id}-link`}><IdValue id={row.id} /></Anchor></Table.Td>

<Table.Td data-testid={`orders-row-${row.id}-customerId`}>{ row.customerId ? <Anchor component={Link} to={`/customers/${row.customerId}`} onClick={(e) => e.stopPropagation()}><IdValue id={row.customerId} /></Anchor> : <EmptyValue />}</Table.Td>

<Table.Td data-testid={`orders-row-${row.id}-status`}><Badge tt="unset" variant="light">{row.status}</Badge></Table.Td>

<Table.Td data-testid={`orders-row-${row.id}-placedAt`}><DateTimeValue iso={row.placedAt} /></Table.Td>

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
