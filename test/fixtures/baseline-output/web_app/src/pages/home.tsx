// Auto-generated.  Do not edit by hand.
import { Link as RouterLink } from "react-router";
import { t } from "../i18n";
import { Anchor, Card, Stack, Text, Title } from "@mantine/core";

export default function Home() {
  return (
    <Stack data-testid="home">
      <Title order={2}>{t("page.Home.heading.okelqr", "Welcome")}</Title>
      <Text>{t("page.Home.text.je8653", "Pick a section from the sidebar to start, or jump straight in below.")}</Text>
      <Stack>
        <Card withBorder padding="md">
          <Title order={4}>{t("page.Home.heading.xv173e", "3 aggregates")}</Title>
          <Text>{t("page.Home.text.wpy903", "Manage records of each kind from the sidebar.")}</Text>
        </Card>
        <Card withBorder padding="md">
          <Title order={4}>{t("page.Home.heading.ltp7vl", "1 workflow")}</Title>
          <Anchor component={RouterLink} to="/workflows">{t("page.Home.anchor.l9bem9", "Open workflows →")}</Anchor>
        </Card>
      </Stack>
    </Stack>
  );
}
