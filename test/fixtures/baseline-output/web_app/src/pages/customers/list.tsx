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
  const customerAll = useAllCustomers();
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
        { customerAll.data && customerAll.data.length === 0 && (
          <Center mih={200}><Text c="dimmed">No customers yet.</Text></Center>
        ) }
        { customerAll.data && customerAll.data.length > 0 && (
          <Paper p="md">
            <Table striped highlightOnHover stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th><span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "id") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("id"); setSortDir("asc"); } }}>ID{sortKey === "id" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span></Table.Th>
                  <Table.Th><span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "username") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("username"); setSortDir("asc"); } }}>Username{sortKey === "username" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span></Table.Th>
                  <Table.Th><span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "email") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("email"); setSortDir("asc"); } }}>Email{sortKey === "email" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span></Table.Th>
                  <Table.Th><span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { if (sortKey === "age") { setSortDir(sortDir === "asc" ? "desc" : "asc"); } else { setSortKey("age"); setSortDir("asc"); } }}>Age{sortKey === "age" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}</span></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { [...(customerAll.data)].sort((a, b) => { if (!sortKey) { return 0; } const av = (a as Record<string, unknown>)[sortKey]; const bv = (b as Record<string, unknown>)[sortKey]; const c = av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1; return sortDir === "desc" ? -c : c; }).map((row) => (
                  <Table.Tr key={ row.id } data-testid={ ("customers-row-" + row.id) }>
                    <Table.Td><RouterLink to={`/customers/${ row.id }`}><IdValue id={ row.id } /></RouterLink></Table.Td>
                    <Table.Td><Text>{row.username}</Text></Table.Td>
                    <Table.Td><Text>{row.email}</Text></Table.Td>
                    <Table.Td><Text>{row.age}</Text></Table.Td>
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
