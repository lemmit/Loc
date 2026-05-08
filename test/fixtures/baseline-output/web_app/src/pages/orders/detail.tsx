// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { Alert, Anchor, Badge, Breadcrumbs, Button, Card, Group, NumberInput, Select, Skeleton, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useOrderById, useAddLineOrder, useConfirmOrder, AddLineRequest, ConfirmRequest } from "../../api/order";
import { useAllProducts } from "../../api/product";
import { IdValue, DateTimeValue, BoolValue, NumberValue, EmptyValue, KeyValueRow } from "../../lib/format";
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconPlus } from "@tabler/icons-react";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useOrderById(id);
  const addLine = useAddLineOrder(id ?? "");
  const confirm = useConfirmOrder(id ?? "");
  if (q.isLoading) return (
    <Stack data-testid="orders-detail-loading" gap="md">
      <Skeleton height={20} width={240} />
      <Skeleton height={32} width={320} />
      <Card><Stack gap="md">
        <Skeleton height={20} />
        <Skeleton height={20} />
        <Skeleton height={20} />
      </Stack></Card>
    </Stack>
  );
  if (q.isError) return <Alert color="red" variant="light" icon={<IconAlertCircle size={18} />} title="Couldn't load order">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title="Not found">No order matches that id.</Alert>;
  const data = q.data;
  return (
    <Stack data-testid="orders-detail" gap="md">
      <Breadcrumbs data-testid="orders-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/orders">Orders</Anchor>
        <Text>{data.id.slice(0, 8) + "…"}</Text>
      </Breadcrumbs>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Order</Text>
          <Group gap="sm" align="center">
            <Title order={2} data-testid="orders-detail-title">{data.id.slice(0, 8) + "…"}</Title>
            <span data-testid="orders-detail-id"><IdValue id={data.id} /></span>
          </Group>
        </Stack>
        <Group gap="xs" data-testid="orders-detail-ops">
          <Button variant="filled" leftSection={<IconPlus size={16} stroke={2} />} onClick={() => openAddLineModal(addLine)} data-testid="orders-op-addLine">Add Line</Button>
          <Button variant="light" leftSection={<IconCheck size={16} stroke={2} />} onClick={() => openConfirmModal(confirm)} data-testid="orders-op-confirm">Confirm</Button>
        </Group>
      </Group>
      <Card>
        <Stack gap="md">
        <KeyValueRow label="Customer Id"><span data-testid="orders-detail-customerId">{data.customerId ? <Anchor component={Link} to={`/customers/${data.customerId}`}><IdValue id={data.customerId} /></Anchor> : <EmptyValue />}</span></KeyValueRow>
        <KeyValueRow label="Status"><Badge tt="unset" component="span" variant="light" data-testid="orders-detail-status">{data.status}</Badge></KeyValueRow>
        <KeyValueRow label="Placed At"><span data-testid="orders-detail-placedAt"><DateTimeValue iso={data.placedAt} /></span></KeyValueRow>
        </Stack>
      </Card>
      <Card>
        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Title order={4}>Lines</Title>
            <Text size="sm" c="dimmed">{data.lines.length === 1 ? "1 item" : data.lines.length + " items"}</Text>
          </Group>
          <Table.ScrollContainer minWidth={400}>
            <Table striped highlightOnHover data-testid="orders-detail-lines">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Id</Table.Th>
                <Table.Th>Product Id</Table.Th>
                <Table.Th>Quantity</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.lines.map((row) => (
                  <Table.Tr key={row.id} data-testid={`orders-detail-lines-row-${row.id}`}>
                    <Table.Td data-testid={`orders-detail-lines-row-${row.id}-id`}><IdValue id={row.id} /></Table.Td>
                    <Table.Td data-testid={`orders-detail-lines-row-${row.id}-productId`}>{row.productId ? <Anchor component={Link} to={`/products/${row.productId}`}><IdValue id={row.productId} /></Anchor> : <EmptyValue />}</Table.Td>
                    <Table.Td data-testid={`orders-detail-lines-row-${row.id}-quantity`} style={{ textAlign: "right" }}><NumberValue value={row.quantity} /></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      </Card>
    </Stack>
  );
}

function openAddLineModal(mut: ReturnType<typeof useAddLineOrder>): void {
  modals.open({
    title: "Add Line",
    children: <AddLineForm mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function AddLineForm({ mut, onClose }: { mut: ReturnType<typeof useAddLineOrder>; onClose: () => void }) {
  const __products = useAllProducts();
  const { register, handleSubmit, control, formState: { errors } } = useForm<AddLineRequest>({
    resolver: zodResolver(AddLineRequest),
    defaultValues: { productId: "", qty: 0 },
  });
  return (
    <form
      data-testid="orders-op-addLine-form"
      onSubmit={handleSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "Add Line succeeded" });
          onClose();
        } catch (e) {
          notifications.show({ color: "red", message: (e as Error).message });
        }
      })}
    >
      <Stack>
        <Controller
          control={control}
          name="productId"
          render={({ field, fieldState }) => (
            <Select label="Product Id" data-testid="orders-op-addLine-input-productId" placeholder="Select…" searchable data={(__products.data ?? []).map((__o) => ({ value: __o.id, label: __o.sku }))} renderOption={({ option }) => <div data-testid={`orders-op-addLine-input-productId-option-${option.value}`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
          )}
        />
        <Controller
          control={control}
          name="qty"
          render={({ field, fieldState }) => (
            <NumberInput label="Qty" data-testid="orders-op-addLine-input-qty" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="orders-op-addLine-submit">Add Line</Button>
        </Group>
      </Stack>
    </form>
  );
}

function openConfirmModal(mut: ReturnType<typeof useConfirmOrder>): void {
  modals.open({
    title: "Confirm",
    children: <ConfirmForm mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function ConfirmForm({ mut, onClose }: { mut: ReturnType<typeof useConfirmOrder>; onClose: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<ConfirmRequest>({
    resolver: zodResolver(ConfirmRequest),
    defaultValues: {  },
  });
  return (
    <form
      data-testid="orders-op-confirm-form"
      onSubmit={handleSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "Confirm succeeded" });
          onClose();
        } catch (e) {
          notifications.show({ color: "red", message: (e as Error).message });
        }
      })}
    >
      <Stack>
        <Text>This operation has no parameters.</Text>
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="orders-op-confirm-submit">Confirm</Button>
        </Group>
      </Stack>
    </form>
  );
}
