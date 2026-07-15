// Auto-generated.  Do not edit by hand.
import { useState } from "react";
import { useNavigate, Link as RouterLink } from "react-router";
import { DateTimeValue, IdValue } from "../../lib/format";
import { Alert, Anchor, Badge, Breadcrumbs, Button, Center, Group, Paper, Skeleton, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useAllOrders, useByCustomerOrder } from "../../api/order";

export default function OrderList() {
  const navigate = useNavigate();
  const [byCustomerCustomerId, setByCustomerCustomerId] = useState<string>("");
  const [sortKey, setSortKey] = useState<string>("");
  const [sortDir, setSortDir] = useState<string>("");
  const [pageNum, setPageNum] = useState<number>(1);
  const orderByCustomer = useByCustomerOrder({ customerId: byCustomerCustomerId });
  const orderAll = useAllOrders({ page: pageNum, pageSize: 10, sort: sortKey, dir: sortDir });
  return (
    <Stack data-testid="orders-list">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Text>Orders</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <Title order={2}>Orders</Title>
        <Button onClick={() => navigate("/orders/new")} data-testid="orders-list-create">New order</Button>
      </Group>
      <Group>
        <TextInput label="Customer Id" value={byCustomerCustomerId} onChange={(e) => setByCustomerCustomerId(e.currentTarget.value)} data-testid="orders-filter-by_customer_customer_id" />
      </Group>
      {((byCustomerCustomerId !== "")) ? (<>
          { orderByCustomer.isLoading && (
            <Stack gap="xs">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
          ) }
          { orderByCustomer.isError && (
            <Alert color="red" variant="light">Couldn't load orders</Alert>
          ) }
          { orderByCustomer.data && orderByCustomer.data.length === 0 && (
            <Center mih={200}><Text c="dimmed">No orders yet.</Text></Center>
          ) }
          { orderByCustomer.data && orderByCustomer.data.length > 0 && (
            <Paper p="md">
              <Table striped highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "id") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("id"); setSortDir("asc"); } }}>ID{sortKey === "id" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "customerId") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("customerId"); setSortDir("asc"); } }}>Customer Id{sortKey === "customerId" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "status") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("status"); setSortDir("asc"); } }}>Status{sortKey === "status" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "placedAt") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("placedAt"); setSortDir("asc"); } }}>Placed At{sortKey === "placedAt" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "version") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("version"); setSortDir("asc"); } }}>Version{sortKey === "version" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  { ([...(orderByCustomer.data)].sort((a, b) => { if (!sortKey) { return 0; } const av = (a as Record<string, unknown>)[sortKey]; const bv = (b as Record<string, unknown>)[sortKey]; const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1; return sortDir === "desc" ? -c : c; })).slice((pageNum - 1) * 10, pageNum * 10).map((row) => (
                    <Table.Tr key={ row.id } data-testid={ ("orders-row-" + row.id) }>
                      <Table.Td><RouterLink to={`/orders/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                      <Table.Td><Text>{row.customerId}</Text></Table.Td>
                      <Table.Td><Badge tt="none">{ row.status }</Badge></Table.Td>
                      <Table.Td><DateTimeValue iso={ row.placedAt } /></Table.Td>
                      <Table.Td><Text>{row.version}</Text></Table.Td>
                    </Table.Tr>
                  )) }
                </Table.Tbody>
              </Table>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" }} data-testid="pager"><button type="button" disabled={pageNum <= 1} onClick={() => setPageNum(pageNum - 1)}>Prev</button><span>Page {pageNum} of {Math.max(1, Math.ceil(([...(orderByCustomer.data)].sort((a, b) => { if (!sortKey) { return 0; } const av = (a as Record<string, unknown>)[sortKey]; const bv = (b as Record<string, unknown>)[sortKey]; const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1; return sortDir === "desc" ? -c : c; })).length / 10))}</span><button type="button" disabled={pageNum >= Math.max(1, Math.ceil(([...(orderByCustomer.data)].sort((a, b) => { if (!sortKey) { return 0; } const av = (a as Record<string, unknown>)[sortKey]; const bv = (b as Record<string, unknown>)[sortKey]; const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1; return sortDir === "desc" ? -c : c; })).length / 10))} onClick={() => setPageNum(pageNum + 1)}>Next</button></div>
            </Paper>
          ) }
        </>) : <>
          { orderAll.isLoading && (
            <Stack gap="xs">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
          ) }
          { orderAll.isError && (
            <Alert color="red" variant="light">Couldn't load orders</Alert>
          ) }
          { orderAll.data && orderAll.data.items.length === 0 && (
            <Center mih={200}><Text c="dimmed">No orders yet.</Text></Center>
          ) }
          { orderAll.data && orderAll.data.items.length > 0 && (
            <Paper p="md">
              <Table striped highlightOnHover stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "id") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("id"); setSortDir("asc"); } }}>ID{sortKey === "id" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "customerId") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("customerId"); setSortDir("asc"); } }}>Customer Id{sortKey === "customerId" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "status") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("status"); setSortDir("asc"); } }}>Status{sortKey === "status" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "placedAt") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("placedAt"); setSortDir("asc"); } }}>Placed At{sortKey === "placedAt" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                    <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "version") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("version"); setSortDir("asc"); } }}>Version{sortKey === "version" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  { orderAll.data.items.map((row) => (
                    <Table.Tr key={ row.id } data-testid={ ("orders-row-" + row.id) }>
                      <Table.Td><RouterLink to={`/orders/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                      <Table.Td><Text>{row.customerId}</Text></Table.Td>
                      <Table.Td><Badge tt="none">{ row.status }</Badge></Table.Td>
                      <Table.Td><DateTimeValue iso={ row.placedAt } /></Table.Td>
                      <Table.Td><Text>{row.version}</Text></Table.Td>
                    </Table.Tr>
                  )) }
                </Table.Tbody>
              </Table>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" }} data-testid="pager"><button type="button" disabled={pageNum <= 1} onClick={() => setPageNum(pageNum - 1)}>Prev</button><span>Page {pageNum} of {Math.max(1, orderAll.data.totalPages)}</span><button type="button" disabled={pageNum >= Math.max(1, orderAll.data.totalPages)} onClick={() => setPageNum(pageNum + 1)}>Next</button></div>
            </Paper>
          ) }
        </>}
    </Stack>
  );
}
