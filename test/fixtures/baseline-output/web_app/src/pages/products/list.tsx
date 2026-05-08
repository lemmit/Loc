// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Skeleton, Alert, Anchor, Badge, Breadcrumbs, Center, Text, Paper } from "@mantine/core";
import { IconPlus, IconAlertCircle } from "@tabler/icons-react";
import { useAllProducts } from "../../api/product";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "../../lib/format";

export default function ProductList() {
  const navigate = useNavigate();
  const q = useAllProducts();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="products-list" gap="md">
      <Breadcrumbs data-testid="products-list-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
<Text>Products</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>Products</Title>
          <Text size="sm" c="dimmed">{q.isLoading ? "Loading…" : count === 1 ? "1 record" : count + " records"}</Text>
        </Stack>
        <Button leftSection={<IconPlus size={16} stroke={2} />} onClick={() => navigate("/products/new")} data-testid="products-list-create">New product</Button>
      </Group>
      {q.isLoading && (
        <Paper p="md">
          <Stack gap="xs">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={28} radius="sm" />
            ))}
          </Stack>
        </Paper>
      )}
      {q.isError && <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load products">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Paper p="xl" data-testid="products-list-empty">
          <Center mih={160}>
            <Stack gap="xs" align="center">
              <Text c="dimmed">No products yet.</Text>
              <Button variant="light" onClick={() => navigate("/products/new")}>
                Create your first product
              </Button>
            </Stack>
          </Center>
        </Paper>
      )}
      {q.data && q.data.length > 0 && (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={500}>
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Id</Table.Th>
<Table.Th>Sku</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row) => (
                  <Table.Tr key={row.id} data-testid={`products-row-${row.id}`} style={{ cursor: "pointer" }} onClick={() => navigate(`/products/${row.id}`)}>
                    <Table.Td><Anchor component={Link} to={`/products/${row.id}`} data-testid={`products-row-${row.id}-link`}><IdValue id={row.id} /></Anchor></Table.Td>

<Table.Td data-testid={`products-row-${row.id}-sku`}>{ row.sku === null || row.sku === undefined || row.sku === "" ? <EmptyValue /> : String(row.sku)}</Table.Td>

                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
    </Stack>
  );
}
