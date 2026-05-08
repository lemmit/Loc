// Auto-generated.
import { Stack, Title, Text, Anchor, Card, SimpleGrid } from "@mantine/core";
import { Link } from "react-router-dom";

export default function Home() {
  return (
    <Stack data-testid="home" gap="md">
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Acme</Text>
        <Title order={2}>Welcome</Title>
        <Text c="dimmed">
          Pick a section from the sidebar to start, or jump straight in below.
        </Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
        <Card withBorder>
          <Stack gap={4}>
            <Text fw={600}>3 aggregates</Text>
            <Text size="sm" c="dimmed">Manage records of each kind from the sidebar.</Text>
      <Anchor component={Link} to="/products" data-testid="home-aggregates-link">Browse the sidebar →</Anchor>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap={4}>
            <Text fw={600}>1 workflow</Text>
            <Text size="sm" c="dimmed">System-level orchestrations you can run from a form.</Text>
            <Anchor component={Link} to="/workflows" data-testid="home-workflows-link" size="sm">Open workflows →</Anchor>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap={4}>
            <Text fw={600}>2 views</Text>
            <Text size="sm" c="dimmed">Saved queries — open one to inspect rows.</Text>
            <Anchor component={Link} to="/views" data-testid="home-views-link" size="sm">Open views →</Anchor>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
