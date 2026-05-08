// Auto-generated.
import { Link } from "react-router-dom";
import { Anchor, Breadcrumbs, Stack, Title, Text, Card, Group, Button, SimpleGrid } from "@mantine/core";
import { IconBolt } from "@tabler/icons-react";

export default function WorkflowsIndex() {
  return (
    <Stack data-testid="workflows-index" gap="md">
      <Breadcrumbs data-testid="workflows-index-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Text>Workflows</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Title order={2}>Workflows</Title>
        <Text c="dimmed">System-level orchestrations.  Pick one to run.</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
      <Card data-testid="workflow-card-place_order">
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Group gap="xs" align="center">
              <IconBolt size={18} stroke={2} color="var(--mantine-color-brand-6)" />
              <Title order={4}>Place Order</Title>
            </Group>
            <Button component={Link} to="/workflows/place_order" data-testid="workflow-place_order-run">Run →</Button>
          </Group>
          <Text size="sm" c="dimmed" data-testid="workflow-place_order-param-customerId"><strong>Customer Id</strong>: {"string"}</Text>
          <Text size="sm" c="dimmed" data-testid="workflow-place_order-param-productId"><strong>Product Id</strong>: {"Id<Product>"}</Text>
          <Text size="sm" c="dimmed" data-testid="workflow-place_order-param-quantity"><strong>Quantity</strong>: {"int"}</Text>
        </Stack>
      </Card>
      </SimpleGrid>
    </Stack>
  );
}
