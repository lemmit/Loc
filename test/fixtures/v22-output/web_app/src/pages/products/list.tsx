// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Loader, Alert, Anchor, Badge, Center, Text } from "@mantine/core";
import { useAllProducts } from "../../api/product";

export default function ProductList() {
  const navigate = useNavigate();
  const q = useAllProducts();
  return (
    <Stack data-testid="products-list">
      <Group justify="space-between">
        <Title order={2}>Products</Title>
        <Button onClick={() => navigate("/products/new")} data-testid="products-list-create">Create product</Button>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Center mih={200} data-testid="products-list-empty">
          <Stack gap="xs" align="center">
            <Text c="dimmed">No products yet.</Text>
            <Button variant="light" onClick={() => navigate("/products/new")}>
              Create your first product
            </Button>
          </Stack>
        </Center>
      )}
      {q.data && q.data.length > 0 && (
        <Table striped withTableBorder highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>id</Table.Th>
              <Table.Th>sku</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.map((row) => (
              <Table.Tr key={row.id} data-testid={`products-row-${row.id}`}>
                <Table.Td><Anchor component={Link} to={`/products/${row.id}`} data-testid={`products-row-${row.id}-link`}>{row.id.slice(0, 8)}…</Anchor></Table.Td>
                <Table.Td data-testid={`products-row-${row.id}-sku`}>{String(row.sku ?? "")}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
