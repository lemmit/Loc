// Auto-generated.  Do not edit by hand.
import { useParams, Link as RouterLink } from "react-router";
import { AddLineOrderRequest, ConfirmOrderRequest, UpdateOrderRequest, useAddLineOrder, useConfirmOrder, useUpdateOrder } from "../../api/order";
import { useAllProducts } from "../../api/product";
import { applyServerErrors } from "../../lib/apply-server-errors";
import { DateTimeValue, IdValue, KeyValueRow } from "../../lib/format";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Anchor, Badge, Breadcrumbs, Button, Card, Group, NumberInput, Select, Skeleton, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { Controller, useForm } from "react-hook-form";
import { useOrderById } from "../../api/order";
function openAddLineModal(mut: ReturnType<typeof useAddLineOrder>): void {
  modals.open({
    title: "Add Line",
    children: <AddLineForm mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function AddLineForm({ mut, onClose }: { mut: ReturnType<typeof useAddLineOrder>; onClose: () => void }) {
  const __products = useAllProducts();
  const { handleSubmit, setError, control } = useForm<AddLineOrderRequest>({
    resolver: zodResolver(AddLineOrderRequest),
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
          const outcome = applyServerErrors({ error: e, setError, fieldMap: {} as const });
          if (outcome.kind === "global") {
            notifications.show({ color: "red", message: outcome.title });
          } else if (outcome.kind === "unhandled") {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        }
      })}
    >
      <Stack>
        <Controller
          control={control}
          name="productId"
          render={({ field, fieldState }) => (
            <Select label="Product Id" data-testid="orders-op-addLine-input-productId" placeholder="Select…" searchable data={(__products.data?.items ?? []).map((__o) => ({ value: __o.id, label: __o.display }))} renderOption={({ option }) => <div data-testid={`orders-op-addLine-input-productId-option-${option.value}`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
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
  const { handleSubmit, setError } = useForm<ConfirmOrderRequest>({
    resolver: zodResolver(ConfirmOrderRequest),
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
          const outcome = applyServerErrors({ error: e, setError, fieldMap: {} as const });
          if (outcome.kind === "global") {
            notifications.show({ color: "red", message: outcome.title });
          } else if (outcome.kind === "unhandled") {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        }
      })}
    >
      <Stack>
        <Text c="dimmed">This operation has no parameters.</Text>
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="orders-op-confirm-submit">Confirm</Button>
        </Group>
      </Stack>
    </form>
  );
}
function openUpdateModal(mut: ReturnType<typeof useUpdateOrder>): void {
  modals.open({
    title: "Update",
    children: <UpdateForm mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function UpdateForm({ mut, onClose }: { mut: ReturnType<typeof useUpdateOrder>; onClose: () => void }) {
  const { register, handleSubmit, setError, control, formState: { errors } } = useForm<UpdateOrderRequest>({
    resolver: zodResolver(UpdateOrderRequest),
    defaultValues: { customerId: "", status: "Draft", placedAt: "" },
  });
  return (
    <form
      data-testid="orders-op-update-form"
      onSubmit={handleSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "Update succeeded" });
          onClose();
        } catch (e) {
          const outcome = applyServerErrors({ error: e, setError, fieldMap: {} as const });
          if (outcome.kind === "global") {
            notifications.show({ color: "red", message: outcome.title });
          } else if (outcome.kind === "unhandled") {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        }
      })}
    >
      <Stack>
        <TextInput label="Customer Id" {...register("customerId")} data-testid="orders-op-update-input-customerId" error={errors.customerId?.message} />

        <Controller
          control={control}
          name="status"
          render={({ field, fieldState }) => (
            <Select label="Status" data-testid="orders-op-update-input-status" data={ ["Draft","Confirmed","Shipped","Cancelled"] } allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
          )}
        />

        <TextInput label="Placed At" {...register("placedAt")} data-testid="orders-op-update-input-placedAt" type="datetime-local" error={errors.placedAt?.message} />

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="orders-op-update-submit">Update</Button>
        </Group>
      </Stack>
    </form>
  );
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const orderById = useOrderById(id);
  const addLine = useAddLineOrder(id ?? "");
  const confirm = useConfirmOrder(id ?? "");
  const update = useUpdateOrder(id ?? "");
  return (
    <Stack data-testid="orders-detail">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/orders">Orders</Anchor>
        <Text>Detail</Text>
      </Breadcrumbs>
      <Title order={2}>Order detail</Title>
      <>
        { orderById.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 3 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { orderById.isError && (
          <Alert color="red" variant="light">Couldn't load order</Alert>
        ) }
        { !orderById.isLoading && !orderById.isError && !orderById.data && (
          <Alert color="yellow" variant="light">No order matches that id.</Alert>
        ) }
        { orderById.data && (
          <Stack>
            <Card withBorder padding="md">
              <Stack>
                <KeyValueRow label="Customer Id" data-testid="orders-detail-customerId"><Text>{orderById.data.customerId}</Text></KeyValueRow>
                <KeyValueRow label="Status" data-testid="orders-detail-status"><Badge tt="none">{ orderById.data.status }</Badge></KeyValueRow>
                <KeyValueRow label="Placed At" data-testid="orders-detail-placedAt"><DateTimeValue iso={ orderById.data.placedAt } /></KeyValueRow>
                <KeyValueRow label="Version" data-testid="orders-detail-version"><Text>{orderById.data.version}</Text></KeyValueRow>
              </Stack>
            </Card>
            <Card withBorder padding="md" data-testid="orders-detail-lines">
              <Stack>
                <Title order={4}>Lines</Title>
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Product Id</Table.Th>
                      <Table.Th>Quantity</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    { orderById.data.lines.map((row, idx) => (
                      <Table.Tr key={ idx }>
                        <Table.Td><RouterLink to={`/products/${ row.productId }`}><IdValue id={ row.productId } /></RouterLink></Table.Td>
                        <Table.Td><Text>{row.quantity}</Text></Table.Td>
                      </Table.Tr>
                    )) }
                  </Table.Tbody>
                </Table>
              </Stack>
            </Card>
          </Stack>
        ) }
      </>
      <Group>
        <Button variant="filled" onClick={() => openAddLineModal(addLine)} data-testid="orders-op-addLine">Add Line</Button>
    
        <Button variant="light" onClick={() => openConfirmModal(confirm)} data-testid="orders-op-confirm">Confirm</Button>
    
        <Button variant="light" onClick={() => openUpdateModal(update)} data-testid="orders-op-update">Update</Button>
    
      </Group>
    </Stack>
  );
}
