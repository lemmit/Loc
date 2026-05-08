// Auto-generated.
import { Stack, Title, Text, Anchor, Card, SimpleGrid } from "@mantine/core";
import { Link } from "react-router-dom";

export default function Home() {
  return (
    <Stack data-testid="home" gap="md">
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Sample</Text>
        <Title order={2}>Welcome</Title>
        <Text c="dimmed">
          Pick a section from the sidebar to start, or jump straight in below.
        </Text>
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
        <Card withBorder>
          <Stack gap={4}>
            <Text fw={600}>2 aggregates</Text>
            <Text size="sm" c="dimmed">Manage records of each kind from the sidebar.</Text>
            <Anchor component={Link} to="/customers" data-testid="home-aggregates-link">Browse the sidebar →</Anchor>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
