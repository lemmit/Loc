// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { Stack, Title, Card, Group, Button, Text, Skeleton, Alert, Anchor, Breadcrumbs, Badge, Table, TextInput, NumberInput, Select, Switch, Fieldset } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCustomerById } from "../../api/customer";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue, KeyValueRow } from "../../lib/format";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useCustomerById(id);
  if (q.isLoading) return (
    <Stack data-testid="customers-detail-loading" gap="md">
      <Skeleton height={20} width={240} />
      <Skeleton height={32} width={320} />
      <Card><Stack gap="md">
        <Skeleton height={20} />
        <Skeleton height={20} />
        <Skeleton height={20} />
      </Stack></Card>
    </Stack>
  );
  if (q.isError) return <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load customer">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title="Not found">No customer matches that id.</Alert>;
  const data = q.data;
  return (
    <Stack data-testid="customers-detail" gap="md">
      <Breadcrumbs data-testid="customers-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/customers">Customers</Anchor>
        <Text>{data.username}</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Customer</Text>
          <Group gap="sm" align="center">
            <Title order={2} data-testid="customers-detail-title">{data.username}</Title>
            <span data-testid="customers-detail-id"><IdValue id={data.id} /></span>
          </Group>
        </Stack>
        
      </Group>
      <Card>
        <Stack gap="md">
        <KeyValueRow label="Username"><span data-testid="customers-detail-username">{ data.username === null || data.username === undefined || data.username === "" ? <EmptyValue /> : String(data.username)}</span></KeyValueRow>

<KeyValueRow label="Email"><span data-testid="customers-detail-email">{ data.email === null || data.email === undefined || data.email === "" ? <EmptyValue /> : String(data.email)}</span></KeyValueRow>

<KeyValueRow label="Age"><span data-testid="customers-detail-age"><NumberValue value={data.age} /></span></KeyValueRow>

        </Stack>
      </Card>
          </Stack>
  );
}

