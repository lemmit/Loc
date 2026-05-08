// Auto-generated.
import { useParams, Link } from "react-router-dom";
import { Alert, Anchor, Badge, Breadcrumbs, Button, Card, Group, Loader, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useOrderById, useAddLineOrder, useConfirmOrder, AddLineRequest, ConfirmRequest } from "../../api/order";
import { useAllProducts } from "../../api/product";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useOrderById(id);
  const addLine = useAddLineOrder(id ?? "");
  const confirm = useConfirmOrder(id ?? "");
  if (q.isLoading) return <Loader />;
  if (q.isError) return <Alert color="red">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Text>Not found.</Text>;
  const data = q.data;
  return (
    <Stack data-testid="orders-detail">
      <Breadcrumbs data-testid="orders-detail-breadcrumbs">
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/orders">Orders</Anchor>
        <Text>{data.id.slice(0, 8)}…</Text>
      </Breadcrumbs>
      <Title order={2}>Order {data.id.slice(0, 8)}…</Title>
      <Card withBorder>
        <Stack gap="xs">
        <Text><strong>customerId:</strong> <span data-testid="orders-detail-customerId">{String(data.customerId)}</span></Text>
        <Text><strong>status:</strong> <Badge tt="unset" component="span" data-testid="orders-detail-status">{data.status}</Badge></Text>
        <Text><strong>placedAt:</strong> <span data-testid="orders-detail-placedAt">{String(data.placedAt)}</span></Text>
        </Stack>
      </Card>
      <Card withBorder>
        <Title order={4}>lines</Title>
        <Table striped withTableBorder data-testid="orders-detail-lines">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>id</Table.Th>
              <Table.Th>productId</Table.Th>
              <Table.Th>quantity</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.lines.map((row) => (
              <Table.Tr key={row.id} data-testid={`orders-detail-lines-row-${row.id}`}>
                <Table.Td data-testid={`orders-detail-lines-row-${row.id}-id`}>{String(row.id ?? "")}</Table.Td>
                <Table.Td data-testid={`orders-detail-lines-row-${row.id}-productId`}>{String(row.productId ?? "")}</Table.Td>
                <Table.Td data-testid={`orders-detail-lines-row-${row.id}-quantity`}>{String(row.quantity ?? "")}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Card withBorder>
        <Title order={4}>Operations</Title>
        <Group>
          <Button onClick={() => openAddLineModal(addLine)} data-testid="orders-op-addLine">addLine</Button>
          <Button onClick={() => openConfirmModal(confirm)} data-testid="orders-op-confirm">confirm</Button>
        </Group>
      </Card>
    </Stack>
  );
}

function openAddLineModal(mut: ReturnType<typeof useAddLineOrder>): void {
  modals.open({
    title: "addLine",
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
          notifications.show({ color: "green", message: "addLine succeeded" });
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
            <Select label="productId" data-testid="orders-op-addLine-input-productId" data={(__products.data ?? []).map((__o) => ({ value: __o.id, label: __o.sku }))} renderOption={({ option }) => <div data-testid={`orders-op-addLine-input-productId-option-${option.value}`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
          )}
        />
        <Controller
          control={control}
          name="qty"
          render={({ field, fieldState }) => (
            <NumberInput label="qty" data-testid="orders-op-addLine-input-qty" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="orders-op-addLine-submit">addLine</Button>
        </Group>
      </Stack>
    </form>
  );
}

function openConfirmModal(mut: ReturnType<typeof useConfirmOrder>): void {
  modals.open({
    title: "confirm",
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
          notifications.show({ color: "green", message: "confirm succeeded" });
          onClose();
        } catch (e) {
          notifications.show({ color: "red", message: (e as Error).message });
        }
      })}
    >
      <Stack>
        <Text>This operation has no parameters.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="orders-op-confirm-submit">confirm</Button>
        </Group>
      </Stack>
    </form>
  );
}
