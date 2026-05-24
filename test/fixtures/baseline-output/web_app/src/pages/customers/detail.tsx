// Auto-generated.  Do not edit by hand.
import { useParams, Link as RouterLink } from "react-router";
import { KeyValueRow } from "../../lib/format";
import { Alert, Anchor, Breadcrumbs, Card, Group, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useCustomerById } from "../../api/customer";

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerById = useCustomerById(id);
  return (
    <Stack data-testid="customers-detail">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/customers">Customers</Anchor>
        <Text>Detail</Text>
      </Breadcrumbs>
      <Title order={2}>Customer detail</Title>
      <>
        { customerById.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 3 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { customerById.isError && (
          <Alert color="red" variant="light">Couldn't load customer</Alert>
        ) }
        { !customerById.isLoading && !customerById.isError && !customerById.data && (
          <Alert color="yellow" variant="light">No customer matches that id.</Alert>
        ) }
        { customerById.data && (
          <Card withBorder padding="md">
            <Stack>
              <KeyValueRow label="Username" data-testid="customers-detail-username"><Text>{customerById.data.username}</Text></KeyValueRow>
              <KeyValueRow label="Email" data-testid="customers-detail-email"><Text>{customerById.data.email}</Text></KeyValueRow>
              <KeyValueRow label="Age" data-testid="customers-detail-age"><Text>{customerById.data.age}</Text></KeyValueRow>
            </Stack>
          </Card>
        ) }
      </>
      <Group />
    </Stack>
  );
}
