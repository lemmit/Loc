// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Loader, Alert, Anchor, Badge, Center, Text } from "@mantine/core";
import { useAllCustomers } from "../../api/customer";

export default function CustomerList() {
  const navigate = useNavigate();
  const q = useAllCustomers();
  return (
    <Stack data-testid="customers-list">
      <Group justify="space-between">
        <Title order={2}>Customers</Title>
        <Button onClick={() => navigate("/customers/new")} data-testid="customers-list-create">Create customer</Button>
      </Group>
      {q.isLoading && <Loader />}
      {q.isError && <Alert color="red">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Center mih={200} data-testid="customers-list-empty">
          <Stack gap="xs" align="center">
            <Text c="dimmed">No customers yet.</Text>
            <Button variant="light" onClick={() => navigate("/customers/new")}>
              Create your first customer
            </Button>
          </Stack>
        </Center>
      )}
      {q.data && q.data.length > 0 && (
        <Table striped withTableBorder highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>id</Table.Th>
              <Table.Th>username</Table.Th>
              <Table.Th>email</Table.Th>
              <Table.Th>age</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.map((row) => (
              <Table.Tr key={row.id} data-testid={`customers-row-${row.id}`}>
                <Table.Td><Anchor component={Link} to={`/customers/${row.id}`} data-testid={`customers-row-${row.id}-link`}>{row.id.slice(0, 8)}…</Anchor></Table.Td>
                <Table.Td data-testid={`customers-row-${row.id}-username`}>{String(row.username ?? "")}</Table.Td>
                <Table.Td data-testid={`customers-row-${row.id}-email`}>{String(row.email ?? "")}</Table.Td>
                <Table.Td data-testid={`customers-row-${row.id}-age`}>{String(row.age ?? "")}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
