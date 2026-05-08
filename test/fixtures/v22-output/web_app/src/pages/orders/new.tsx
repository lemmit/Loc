// Auto-generated.
import { useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, Select, TextInput } from "@mantine/core";
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
    <Stack maw={600} data-testid="orders-new">
      <Title order={2}>New order</Title>
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
        <Stack>
        <TextInput label="customerId" {...register("customerId")} data-testid="orders-new-input-customerId" error={errors.customerId?.message} />
        <Controller
          control={control}
          name="status"
          render={({ field, fieldState }) => (
            <Select label="status" data-testid="orders-new-input-status" data={["Draft","Confirmed","Shipped","Cancelled"]} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
          )}
        />
        <TextInput label="placedAt" {...register("placedAt")} data-testid="orders-new-input-placedAt" type="datetime-local" error={errors.placedAt?.message} />
          <Group justify="flex-end">
            <Button type="submit" loading={create.isPending} data-testid="orders-new-submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}
