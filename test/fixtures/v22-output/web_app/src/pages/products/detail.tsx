// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { Alert, Anchor, Breadcrumbs, Button, Card, Group, Loader, Stack, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useProductById } from "../../api/product";

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useProductById(id);

  if (q.isLoading) return <Loader />;
  if (q.isError) return <Alert color="red">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Text>Not found.</Text>;
  const data = q.data;
  return (
    <Stack data-testid="products-detail">
      <Breadcrumbs data-testid="products-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/products">Products</Anchor>
        <Text>{data.id.slice(0, 8)}…</Text>
      </Breadcrumbs>
      <Title order={2}>Product {data.id.slice(0, 8)}…</Title>
      <Card withBorder>
        <Stack gap="xs">
        <Text><strong>sku:</strong> <span data-testid="products-detail-sku">{String(data.sku)}</span></Text>
        <Text><strong>price:</strong> amount: <span data-testid="products-detail-price-amount">{String(data.price.amount)}</span>, currency: <span data-testid="products-detail-price-currency">{String(data.price.currency)}</span></Text>
        </Stack>
      </Card>
      
      
    </Stack>
  );
}


