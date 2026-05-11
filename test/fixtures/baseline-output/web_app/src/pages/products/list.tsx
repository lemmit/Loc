// Auto-generated.  Do not edit by hand.
import { useNavigate, Link as RouterLink } from "react-router-dom";
import { IdValue } from "../../lib/format";
import { Alert, Anchor, Breadcrumbs, Button, Center, Group, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useAllProducts } from "../../api/product";

export default function ProductList() {
  const navigate = useNavigate();
  const productAll = useAllProducts();
  return (
    <Stack data-testid="products-list">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Text>Products</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <Title order={2}>Products</Title>
        <Button onClick={() => navigate("/products/new")} data-testid="products-list-create">New product</Button>
      </Group>
      <>
        { productAll.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { productAll.isError && (
          <Alert color="red" variant="light">Couldn't load products</Alert>
        ) }
        { productAll.data && productAll.data.length === 0 && (
          <Center mih={200}><Text c="dimmed">No products yet.</Text></Center>
        ) }
        { productAll.data && productAll.data.length > 0 && (
          <Paper p="md">
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Sku</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { productAll.data.map((row, idx) => (
                  <Table.Tr key={ row.id } data-testid={ ("products-row-" + row.id) }>
                    <Table.Td><RouterLink to={`/products/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                    <Table.Td><Text>{row.sku}</Text></Table.Td>
                  </Table.Tr>
                )) }
              </Table.Tbody>
            </Table>
          </Paper>
        ) }
      </>
    </Stack>
  );
}
