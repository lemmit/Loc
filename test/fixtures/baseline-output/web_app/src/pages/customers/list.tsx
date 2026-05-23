// Auto-generated.  Do not edit by hand.
import { useNavigate, Link as RouterLink } from "react-router";
import { IdValue } from "../../lib/format";
import { Alert, Anchor, Breadcrumbs, Button, Center, Group, Paper, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useAllCustomers } from "../../api/customer";

export default function CustomerList() {
  const navigate = useNavigate();
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
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Username</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Age</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                { customerAll.data.map((row) => (
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
