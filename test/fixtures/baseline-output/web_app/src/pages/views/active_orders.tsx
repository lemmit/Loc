// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Group, Anchor, Badge, Table, Alert, Text, Paper, Skeleton } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useActiveOrdersView } from "../../api/views";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "../../lib/format";

export default function ActiveOrdersViewPage() {
  const q = useActiveOrdersView();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="view-active_orders" gap="md">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>View</Text>
          <Title order={2}>Active Orders</Title>
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
                  <Table.Th>Id</Table.Th>
<Table.Th>Customer Id</Table.Th>
<Table.Th>Status</Table.Th>
<Table.Th>Placed At</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row, idx) => (
                  <Table.Tr key={idx} data-testid={`view-active_orders-row-${idx}`}>
                    <Table.Td data-testid={`view-active_orders-row-${idx}-id`}>{ row.id === null || row.id === undefined || row.id === "" ? <EmptyValue /> : String(row.id)}</Table.Td>

<Table.Td data-testid={`view-active_orders-row-${idx}-customerId`}>{ row.customerId === null || row.customerId === undefined || row.customerId === "" ? <EmptyValue /> : String(row.customerId)}</Table.Td>

<Table.Td data-testid={`view-active_orders-row-${idx}-status`}><Badge tt="unset" variant="light">{row.status}</Badge></Table.Td>

<Table.Td data-testid={`view-active_orders-row-${idx}-placedAt`}><DateTimeValue iso={row.placedAt} /></Table.Td>

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
