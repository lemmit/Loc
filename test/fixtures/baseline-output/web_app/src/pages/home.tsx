// Auto-generated.  Do not edit by hand.
import { Card, Stack, Text, Title } from "@mantine/core";

export default function Home() {
  return (
    <Stack data-testid="home">
      <Title order={2}>Welcome</Title>
      <Text>Pick a section from the sidebar to start, or jump straight in below.</Text>
      <Stack>
        <Card withBorder padding="md">
          <Title order={4}>3 aggregates</Title>
        </Card>
        <Card withBorder padding="md">
          <Title order={4}>1 workflow</Title>
        </Card>
      </Stack>
    </Stack>
  );
}
