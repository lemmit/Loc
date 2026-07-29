// Auto-generated.  Do not edit by hand.
import { t } from "../i18n";
import { Card, Stack, Text, Title } from "@mantine/core";

export default function Home() {
  return (
    <Stack data-testid="home">
      <Title order={2}>{t("page.Home.heading.okelqr", "Welcome")}</Title>
      <Text>{t("page.Home.text.je8653", "Pick a section from the sidebar to start, or jump straight in below.")}</Text>
      <Stack>
        <Card withBorder padding="md">
          <Title order={4}>{t("page.Home.heading.xv173e", "3 aggregates")}</Title>
        </Card>
        <Card withBorder padding="md">
          <Title order={4}>{t("page.Home.heading.ltp7vl", "1 workflow")}</Title>
        </Card>
      </Stack>
    </Stack>
  );
}
