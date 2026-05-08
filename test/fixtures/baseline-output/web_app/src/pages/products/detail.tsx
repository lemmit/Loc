// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { Stack, Title, Card, Group, Button, Text, Skeleton, Alert, Anchor, Breadcrumbs, Badge, Table, TextInput, NumberInput, Select, Switch, Fieldset } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useProductById } from "../../api/product";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue, KeyValueRow } from "../../lib/format";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useProductById(id);
  if (q.isLoading) return (
    <Stack data-testid="products-detail-loading" gap="md">
      <Skeleton height={20} width={240} />
      <Skeleton height={32} width={320} />
      <Card><Stack gap="md">
        <Skeleton height={20} />
        <Skeleton height={20} />
        <Skeleton height={20} />
      </Stack></Card>
    </Stack>
  );
  if (q.isError) return <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load product">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title="Not found">No product matches that id.</Alert>;
  const data = q.data;
  return (
    <Stack data-testid="products-detail" gap="md">
      <Breadcrumbs data-testid="products-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/products">Products</Anchor>
        <Text>{data.sku}</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Product</Text>
          <Group gap="sm" align="center">
            <Title order={2} data-testid="products-detail-title">{data.sku}</Title>
            <span data-testid="products-detail-id"><IdValue id={data.id} /></span>
          </Group>
        </Stack>
        
      </Group>
      <Card>
        <Stack gap="md">
        <KeyValueRow label="Sku"><span data-testid="products-detail-sku">{ data.sku === null || data.sku === undefined || data.sku === "" ? <EmptyValue /> : String(data.sku)}</span></KeyValueRow>

<KeyValueRow label="Price">
          <Text size="sm"><Text component="span" c="dimmed">Amount: </Text><span data-testid="products-detail-price-amount">{String(data.price.amount)}</span></Text>
          <Text size="sm"><Text component="span" c="dimmed">Currency: </Text><span data-testid="products-detail-price-currency">{String(data.price.currency)}</span></Text>
        </KeyValueRow>

        </Stack>
      </Card>
          </Stack>
  );
}

