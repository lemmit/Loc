// Auto-generated.  Do not edit by hand.
import { useState } from "react";
import { useNavigate, Link as RouterLink } from "react-router";
import { IdValue } from "../../lib/format";
import { Alert, Anchor, Breadcrumbs, Button, Center, Group, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useAllProducts } from "../../api/product";

export default function ProductList() {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<string>("");
  const [sortDir, setSortDir] = useState<string>("");
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
                  <Table.Th><span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "id") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("id"); setSortDir("asc"); } }}>ID{sortKey === "id" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span></Table.Th>
                  <Table.Th><span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "sku") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("sku"); setSortDir("asc"); } }}>Sku{sortKey === "sku" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { [...(productAll.data)].sort((a, b) => { if (!sortKey) { return 0; } const av = (a as Record<string, unknown>)[sortKey]; const bv = (b as Record<string, unknown>)[sortKey]; const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1; return sortDir === "desc" ? -c : c; }).map((row) => (
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
