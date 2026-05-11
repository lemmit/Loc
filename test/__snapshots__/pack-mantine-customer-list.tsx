// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Group, Button, Table, Skeleton, Alert, Anchor, Badge, Breadcrumbs, Center, Text, Paper } from "@mantine/core";
import { IconPlus, IconAlertCircle } from "@tabler/icons-react";
import { useAllCustomers } from "../../api/customer";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue } from "../../lib/format";

export default function CustomerList() {
  const navigate = useNavigate();
  const q = useAllCustomers();
  const count = q.data?.length ?? 0;
  return (
    <Stack data-testid="customers-list" gap="md">
      <Breadcrumbs data-testid="customers-list-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
<Text>Customers</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>Customers</Title>
          <Text size="sm" c="dimmed">{q.isLoading ? "Loading…" : count === 1 ? "1 record" : count + " records"}</Text>
        </Stack>
        <Button leftSection={<IconPlus size={16} stroke={2} />} onClick={() => navigate("/customers/new")} data-testid="customers-list-create">New customer</Button>
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
      {q.isError && <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load customers">{(q.error as Error).message}</Alert>}
      {q.data && q.data.length === 0 && (
        <Paper p="xl" data-testid="customers-list-empty">
          <Center mih={160}>
            <Stack gap="xs" align="center">
              <Text c="dimmed">No customers yet.</Text>
              <Button variant="light" onClick={() => navigate("/customers/new")}>
                Create your first customer
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
<Table.Th>Username</Table.Th>
<Table.Th>Email</Table.Th>
<Table.Th>Age</Table.Th>
<Table.Th>Balance</Table.Th>
<Table.Th>Vip</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {q.data.map((row) => (
                  <Table.Tr key={row.id} data-testid={`customers-row-${row.id}`} style={{ cursor: "pointer" }} onClick={() => navigate(`/customers/${row.id}`)}>
                    <Table.Td><Anchor component={Link} to={`/customers/${row.id}`} data-testid={`customers-row-${row.id}-link`}><IdValue id={row.id} /></Anchor></Table.Td>
<Table.Td data-testid={`customers-row-${row.id}-username`}>{ row.username === null || row.username === undefined || row.username === "" ? <EmptyValue /> : String(row.username)}</Table.Td>
<Table.Td data-testid={`customers-row-${row.id}-email`}>{ row.email === null || row.email === undefined || row.email === "" ? <EmptyValue /> : String(row.email)}</Table.Td>
<Table.Td data-testid={`customers-row-${row.id}-age`} style={{ textAlign: "right" }}><NumberValue value={row.age} /></Table.Td>
<Table.Td data-testid={`customers-row-${row.id}-balance`} style={{ textAlign: "right" }}><NumberValue value={row.balance} decimals={2} /></Table.Td>
<Table.Td data-testid={`customers-row-${row.id}-vip`}><BoolValue value={row.vip} /></Table.Td>
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
