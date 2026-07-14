// Auto-generated.  Do not edit by hand.
import { useState } from "react";
import { useNavigate, Link as RouterLink } from "react-router";
import { IdValue } from "../../lib/format";
import { Alert, Anchor, Breadcrumbs, Button, Center, Group, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useAllCustomers } from "../../api/customer";

export default function CustomerList() {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<string>("");
  const [sortDir, setSortDir] = useState<string>("");
  const [pageNum, setPageNum] = useState<number>(1);
  const customerAll = useAllCustomers({ page: pageNum, pageSize: 10, sort: sortKey, dir: sortDir });
  return (
    <Stack data-testid="customers-list">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Text>Customers</Text>
      </Breadcrumbs>
      <Group justify="space-between">
        <Title order={2}>Customers</Title>
        <Button onClick={() => navigate("/customers/new")} data-testid="customers-list-create">New customer</Button>
      </Group>
      <>
        { customerAll.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 5 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { customerAll.isError && (
          <Alert color="red" variant="light">Couldn't load customers</Alert>
        ) }
        { customerAll.data && customerAll.data.items.length === 0 && (
          <Center mih={200}><Text c="dimmed">No customers yet.</Text></Center>
        ) }
        { customerAll.data && customerAll.data.items.length > 0 && (
          <Paper p="md">
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "id") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("id"); setSortDir("asc"); } }}>ID{sortKey === "id" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                  <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "username") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("username"); setSortDir("asc"); } }}>Username{sortKey === "username" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                  <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "email") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("email"); setSortDir("asc"); } }}>Email{sortKey === "email" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                  <Table.Th><button type="button" style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "age") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("age"); setSortDir("asc"); } }}>Age{sortKey === "age" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</button></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { customerAll.data.items.map((row) => (
                  <Table.Tr key={ row.id } data-testid={ ("customers-row-" + row.id) }>
                    <Table.Td><RouterLink to={`/customers/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                    <Table.Td><Text>{row.username}</Text></Table.Td>
                    <Table.Td><Text>{row.email}</Text></Table.Td>
                    <Table.Td><Text>{row.age}</Text></Table.Td>
                  </Table.Tr>
                )) }
              </Table.Tbody>
            </Table>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.75rem" }} data-testid="pager"><button type="button" disabled={pageNum <= 1} onClick={() => setPageNum(pageNum - 1)}>Prev</button><span>Page {pageNum} of {Math.max(1, customerAll.data.totalPages)}</span><button type="button" disabled={pageNum >= Math.max(1, customerAll.data.totalPages)} onClick={() => setPageNum(pageNum + 1)}>Next</button></div>
          </Paper>
        ) }
      </>
    </Stack>
  );
}
