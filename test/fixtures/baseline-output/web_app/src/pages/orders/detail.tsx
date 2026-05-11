// Auto-generated.  Do not edit by hand.
import { useParams, Link } from "react-router-dom";
import { DateTimeValue, KeyValueRow } from "../../lib/format";
import { Alert, Anchor, Badge, Breadcrumbs, Card, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useOrderById } from "../../api/order";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const orderById = useOrderById(id);
  return (
    <Stack data-testid="orders-detail">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/orders">Orders</Anchor>
        <Text>Detail</Text>
      </Breadcrumbs>
      <Title order={2}>Order detail</Title>
      <>
        { orderById.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 3 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { orderById.isError && (
          <Alert color="red" variant="light">Couldn't load order</Alert>
        ) }
        { !orderById.isLoading && !orderById.isError && !orderById.data && (
          <Alert color="yellow" variant="light">No order matches that id.</Alert>
        ) }
        { orderById.data && (
          <Card withBorder padding="md">
            <Stack>
              <KeyValueRow label="Customer Id"><Text>{orderById.data.customerId}</Text></KeyValueRow>
              <KeyValueRow label="Status"><Badge>{ orderById.data.status }</Badge></KeyValueRow>
              <KeyValueRow label="Placed At"><DateTimeValue iso={ orderById.data.placedAt } /></KeyValueRow>
            </Stack>
          </Card>
        ) }
      </>
    </Stack>
  );
}
