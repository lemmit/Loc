// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Text, Card, Group, Button } from "@mantine/core";

export default function ViewsIndex() {
  return (
    <Stack data-testid="views-index">
      <Title order={2}>Views</Title>
      <Text c="dimmed">Saved queries.  Pick one to inspect.</Text>
      <Card withBorder data-testid="view-card-active_orders">
        <Group justify="space-between">
          <Title order={4}>Active Orders</Title>
          <Button component={Link} to="/views/active_orders" data-testid="view-active_orders-open">Open →</Button>
        </Group>
        <Text size="sm" c="dimmed">Source: Order</Text>
      </Card>
      <Card withBorder data-testid="view-card-order_summary">
        <Group justify="space-between">
          <Title order={4}>Order Summary</Title>
          <Button component={Link} to="/views/order_summary" data-testid="view-order_summary-open">Open →</Button>
        </Group>
        <Text size="sm" c="dimmed">Custom shape: orderId, status, lineCount</Text>
      </Card>
    </Stack>
  );
}
