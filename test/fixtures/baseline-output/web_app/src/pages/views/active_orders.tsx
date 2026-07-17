// Auto-generated.  Do not edit by hand.
import { DateTimeValue } from "../../lib/format";
import { Alert, Badge, Center, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useActiveOrdersView } from "../../api/views";

export default function ActiveOrdersView() {
  const activeOrdersView = useActiveOrdersView();
  return (
    <Stack data-testid="view-active_orders">
      <Title order={2}>Active Orders</Title>
      <>
        { activeOrdersView.isLoading && (
          <Stack gap="xs" aria-hidden="true">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { activeOrdersView.isError && (
          <Alert color="red" variant="light">Couldn't load active orders</Alert>
        ) }
        { activeOrdersView.data && activeOrdersView.data.length === 0 && (
          <Center mih={200}><Text c="dimmed">No rows.</Text></Center>
        ) }
        { activeOrdersView.data && activeOrdersView.data.length > 0 && (
          <Paper p="md">
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Customer Id</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Placed At</Table.Th>
                  <Table.Th>Version</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { activeOrdersView.data.map((row, idx) => (
                  <Table.Tr key={ idx }>
                    <Table.Td><Text>{row.customerId}</Text></Table.Td>
                    <Table.Td><Badge tt="none">{ row.status }</Badge></Table.Td>
                    <Table.Td><DateTimeValue iso={ row.placedAt } /></Table.Td>
                    <Table.Td><Text>{row.version}</Text></Table.Td>
                  </Table.Tr>
                )) }
              </Table.Tbody>
            </Table>
          </Paper>
        ) }
      </>
    </Stack>
  );
}
