// Auto-generated.  Do not edit by hand.
import { Link } from "react-router-dom";
import { Anchor, Breadcrumbs, Card, Stack, Text, Title } from "@mantine/core";

export default function ViewsIndex() {
  return (
    <Stack data-testid="views-index">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Text>Views</Text>
      </Breadcrumbs>
      <Title order={2}>Views</Title>
      <Text>Saved queries.  Open one to inspect rows.</Text>
      <Stack>
        <Card withBorder padding="md" data-testid="view-card-active_orders">
          <Title order={4}>Active Orders</Title>
        </Card>
        <Card withBorder padding="md" data-testid="view-card-order_summary">
          <Title order={4}>Order Summary</Title>
        </Card>
      </Stack>
    </Stack>
  );
}
