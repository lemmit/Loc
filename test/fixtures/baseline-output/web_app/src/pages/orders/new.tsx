// Auto-generated.  Do not edit by hand.
import { useNavigate, Link as RouterLink } from "react-router";
import { CreateOrderRequest, useCreateOrder } from "../../api/order";
import { zodResolver } from "@hookform/resolvers/zod";
import { Anchor, Breadcrumbs, Button, Card, Group, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Controller, useForm } from "react-hook-form";

export default function OrderNew() {
  const navigate = useNavigate();
  const create = useCreateOrder();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateOrderRequest>({
    resolver: zodResolver(CreateOrderRequest),
    defaultValues: { customerId: "", status: "Draft", placedAt: "" },
  });
  return (
    <Stack data-testid="orders-new-page">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/orders">Orders</Anchor>
        <Text>New</Text>
      </Breadcrumbs>
      <Title order={2}>Create order</Title>
      <Card withBorder padding="md">
        <form onSubmit={handleSubmit(async (vals) => {
                  try {
                    const out = await create.mutateAsync(vals);
                    notifications.show({ color: "green", message: "Order created" });
                    navigate(`/orders/${out.id}`);
                  } catch (e) {
                    notifications.show({ color: "red", message: (e as Error).message });
                  }
                })} data-testid="orders-new">
          <Stack gap="md">
            <TextInput label="Customer Id" {...register("customerId")} data-testid="orders-new-input-customerId" error={errors.customerId?.message} />
    
            <Controller
              control={control}
              name="status"
              render={({ field, fieldState }) => (
                <Select label="Status" data-testid="orders-new-input-status" data={ ["Draft","Confirmed","Shipped","Cancelled"] } allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v)} error={fieldState.error?.message} />
              )}
            />
    
            <TextInput label="Placed At" {...register("placedAt")} data-testid="orders-new-input-placedAt" type="datetime-local" error={errors.placedAt?.message} />
    
            <Group justify="flex-end" mt="sm">
              <Button type="submit" loading={ create.isPending } data-testid="orders-new-submit">Create</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
