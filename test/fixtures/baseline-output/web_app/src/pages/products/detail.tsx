// Auto-generated.  Do not edit by hand.
import { useParams, Link as RouterLink } from "react-router-dom";
import { KeyValueRow } from "../../lib/format";
import { Alert, Anchor, Breadcrumbs, Card, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useProductById } from "../../api/product";

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const productById = useProductById(id);
  return (
    <Stack data-testid="products-detail">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/products">Products</Anchor>
        <Text>Detail</Text>
      </Breadcrumbs>
      <Title order={2}>Product detail</Title>
      <>
        { productById.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 3 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { productById.isError && (
          <Alert color="red" variant="light">Couldn't load product</Alert>
        ) }
        { !productById.isLoading && !productById.isError && !productById.data && (
          <Alert color="yellow" variant="light">No product matches that id.</Alert>
        ) }
        { productById.data && (
          <Card withBorder padding="md">
            <Stack>
              <KeyValueRow label="Sku"><Text>{productById.data.sku}</Text></KeyValueRow>
            </Stack>
          </Card>
        ) }
      </>
    </Stack>
  );
}
