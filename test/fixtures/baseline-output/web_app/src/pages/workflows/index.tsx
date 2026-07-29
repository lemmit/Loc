// Auto-generated.  Do not edit by hand.
import { Link as RouterLink } from "react-router";
import { t } from "../../i18n";
import { Anchor, Breadcrumbs, Card, Stack, Text, Title } from "@mantine/core";

export default function WorkflowsIndex() {
  return (
    <Stack data-testid="workflows-index">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">{t("page.WorkflowsIndex.anchor.n0mxf2", "Home")}</Anchor>
        <Text>{t("page.WorkflowsIndex.text.qrue75", "Workflows")}</Text>
      </Breadcrumbs>
      <Title order={2}>{t("page.WorkflowsIndex.heading.qrue75", "Workflows")}</Title>
      <Text>{t("page.WorkflowsIndex.text.5d4da0", "System-level orchestrations.  Pick one to run.")}</Text>
      <Stack>
        <Card withBorder padding="md" data-testid="workflow-card-place_order">
          <Title order={4}>{t("page.WorkflowsIndex.heading.gb2crw", "Place Order")}</Title>
        </Card>
      </Stack>
    </Stack>
  );
}
