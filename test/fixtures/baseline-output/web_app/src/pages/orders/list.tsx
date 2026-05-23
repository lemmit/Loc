// Auto-generated.  Do not edit by hand.
import { useNavigate, Link as RouterLink } from "react-router";
import { DateTimeValue, IdValue } from "../../lib/format";
import { Alert, Anchor, Badge, Breadcrumbs, Button, Center, Group, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useAllOrders } from "../../api/order";

export default function OrderList() {
  const navigate = useNavigate();
  const orderAll = useAllOrders();
  return (
    <Stack data-testid="orders-list">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Text>Orders</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <Title order={2}>Orders</Title>
        <Button onClick={() => navigate("/orders/new")} data-testid="orders-list-create">New order</Button>
      </Group>
      <>
        { orderAll.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { orderAll.isError && (
          <Alert color="red" variant="light">Couldn't load orders</Alert>
        ) }
        { orderAll.data && orderAll.data.length === 0 && (
          <Center mih={200}><Text c="dimmed">No orders yet.</Text></Center>
        ) }
        { orderAll.data && orderAll.data.length > 0 && (
          <Paper p="md">
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Customer Id</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Placed At</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { orderAll.data.map((row) => (
                  <Table.Tr key={ row.id } data-testid={ ("orders-row-" + row.id) }>
                    <Table.Td><RouterLink to={`/orders/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                    <Table.Td><Text>{row.customerId}</Text></Table.Td>
                    <Table.Td><Badge tt="none">{ row.status }</Badge></Table.Td>
                    <Table.Td><DateTimeValue iso={ row.placedAt } /></Table.Td>
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
