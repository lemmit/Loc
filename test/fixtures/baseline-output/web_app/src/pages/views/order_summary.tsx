// Auto-generated.  Do not edit by hand.
import { Link as RouterLink } from "react-router";
import { IdValue } from "../../lib/format";
import { Alert, Badge, Center, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useOrderSummaryView } from "../../api/views";

export default function OrderSummaryView() {
  const orderSummaryView = useOrderSummaryView();
  return (
    <Stack data-testid="view-order_summary">
      <Title order={2}>Order Summary</Title>
      <>
        { orderSummaryView.isLoading && (
          <Stack gap="xs" aria-hidden="true">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { orderSummaryView.isError && (
          <Alert color="red" variant="light">Couldn't load order summary</Alert>
        ) }
        { orderSummaryView.data && orderSummaryView.data.length === 0 && (
          <Center mih={200}><Text c="dimmed">No rows.</Text></Center>
        ) }
        { orderSummaryView.data && orderSummaryView.data.length > 0 && (
          <Paper p="md">
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Order Id</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Line Count</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { orderSummaryView.data.map((row, idx) => (
                  <Table.Tr key={ idx }>
                    <Table.Td><RouterLink to={`/orders/${ row.orderId }`}><IdValue id={ row.orderId } /></RouterLink></Table.Td>
                    <Table.Td><Badge tt="none">{ row.status }</Badge></Table.Td>
                    <Table.Td><Text>{row.lineCount}</Text></Table.Td>
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
