// Auto-generated.
import { Link } from "react-router-dom";
import { Anchor, Breadcrumbs, Stack, Title, Text, Card, Group, Button, SimpleGrid } from "@mantine/core";
import { IconLayoutList } from "@tabler/icons-react";

export default function ViewsIndex() {
  return (
    <Stack data-testid="views-index" gap="md">
      <Breadcrumbs data-testid="views-index-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Text>Views</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Title order={2}>Views</Title>
        <Text c="dimmed">Saved queries.  Pick one to inspect.</Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
      <Card data-testid="view-card-active_orders">
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Group gap="xs" align="center">
              <IconLayoutList size={18} stroke={2} color="var(--mantine-color-brand-6)" />
              <Title order={4}>Active Orders</Title>
            </Group>
            <Button component={Link} to="/views/active_orders" data-testid="view-active_orders-open" variant="light">Open →</Button>
          </Group>
          <Text size="sm" c="dimmed">Source: Order</Text>
        </Stack>
      </Card>
      <Card data-testid="view-card-order_summary">
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Group gap="xs" align="center">
              <IconLayoutList size={18} stroke={2} color="var(--mantine-color-brand-6)" />
              <Title order={4}>Order Summary</Title>
            </Group>
            <Button component={Link} to="/views/order_summary" data-testid="view-order_summary-open" variant="light">Open →</Button>
          </Group>
          <Text size="sm" c="dimmed">Custom shape: orderId, status, lineCount</Text>
        </Stack>
      </Card>
      </SimpleGrid>
    </Stack>
  );
}
