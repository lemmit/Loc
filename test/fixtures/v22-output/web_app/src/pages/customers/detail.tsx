// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { Alert, Anchor, Breadcrumbs, Button, Card, Group, Loader, Stack, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCustomerById } from "../../api/customer";

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useCustomerById(id);

  if (q.isLoading) return <Loader />;
  if (q.isError) return <Alert color="red">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Text>Not found.</Text>;
  const data = q.data;
  return (
    <Stack data-testid="customers-detail">
      <Breadcrumbs data-testid="customers-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/customers">Customers</Anchor>
        <Text>{data.id.slice(0, 8)}…</Text>
      </Breadcrumbs>
      <Title order={2}>Customer {data.id.slice(0, 8)}…</Title>
      <Card withBorder>
        <Stack gap="xs">
        <Text><strong>username:</strong> <span data-testid="customers-detail-username">{String(data.username)}</span></Text>
        <Text><strong>email:</strong> <span data-testid="customers-detail-email">{String(data.email)}</span></Text>
        <Text><strong>age:</strong> <span data-testid="customers-detail-age">{String(data.age)}</span></Text>
        </Stack>
      </Card>
      
      
    </Stack>
  );
}


