// Auto-generated.  Do not edit by hand.
import { Link as RouterLink } from "react-router";
import { Anchor, Breadcrumbs, Card, Stack, Text, Title } from "@mantine/core";

export default function WorkflowsIndex() {
  return (
    <Stack data-testid="workflows-index">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Text>Workflows</Text>
      </Breadcrumbs>
      <Title order={2}>Workflows</Title>
      <Text>System-level orchestrations.  Pick one to run.</Text>
      <Stack>
        <Card withBorder padding="md" data-testid="workflow-card-place_order">
          <Title order={4}>Place Order</Title>
        </Card>
      </Stack>
    </Stack>
  );
}
