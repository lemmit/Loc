// Auto-generated.
// (new page: no aggregate data fetched yet, no display-field title.)
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, Card, Text, Anchor, Breadcrumbs, Select, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateOrderRequest, useCreateOrder } from "../../api/order";

export default function OrderNew() {
  const navigate = useNavigate();
  const create = useCreateOrder();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateOrderRequest>({
    resolver: zodResolver(CreateOrderRequest),
    defaultValues: { customerId: "", status: "Draft", placedAt: "" },
  });
  return (
    <Stack maw={640} data-testid="orders-new" gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/orders">Orders</Anchor>
        <Text>New</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>New order</Text>
        <Title order={2}>Create order</Title>
      </Stack>
      <Card>
        <form
          onSubmit={handleSubmit(async (vals) => {
            try {
              const out = await create.mutateAsync(vals);
              notifications.show({ color: "green", message: "Order created" });
              navigate(`/orders/${out.id}`);
            } catch (e) {
              notifications.show({ color: "red", message: (e as Error).message });
            }
          })}
        >
          <Stack gap="md">
          <TextInput label="Customer Id" {...register("customerId")} data-testid="orders-new-input-customerId" error={errors.customerId?.message} />
        <Controller
          control={control}
          name="status"
          render={({ field, fieldState }) => (
            <Select label="Status" data-testid="orders-new-input-status" data={["Draft","Confirmed","Shipped","Cancelled"]} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
          )}
        />
        <TextInput label="Placed At" {...register("placedAt")} data-testid="orders-new-input-placedAt" type="datetime-local" error={errors.placedAt?.message} />
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => navigate("/orders")}>Cancel</Button>
              <Button type="submit" loading={create.isPending} data-testid="orders-new-submit">Create</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
