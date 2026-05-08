// Auto-generated.
import { Link } from "react-router-dom";
import { Stack, Title, Text, Card, Group, Button } from "@mantine/core";

export default function WorkflowsIndex() {
  return (
    <Stack data-testid="workflows-index">
      <Title order={2}>Workflows</Title>
      <Text c="dimmed">System-level orchestrations.  Pick one to run.</Text>
      <Card withBorder data-testid="workflow-card-place_order">
        <Group justify="space-between">
          <Title order={4}>Place Order</Title>
          <Button component={Link} to="/workflows/place_order" data-testid="workflow-place_order-run">Run →</Button>
        </Group>
        <Text size="sm" c="dimmed" data-testid="workflow-place_order-param-customerId"><strong>customerId</strong>: {"string"}</Text>
        <Text size="sm" c="dimmed" data-testid="workflow-place_order-param-productId"><strong>productId</strong>: {"Id<Product>"}</Text>
        <Text size="sm" c="dimmed" data-testid="workflow-place_order-param-quantity"><strong>quantity</strong>: {"int"}</Text>
      </Card>
    </Stack>
  );
}
