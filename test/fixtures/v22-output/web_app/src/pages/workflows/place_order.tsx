// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Anchor, Button, Group, NumberInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlaceOrderRequest, usePlaceOrderWorkflow } from "../../api/workflows";
import { useAllProducts } from "../../api/product";

export default function PlaceOrderWorkflowPage() {
  const navigate = useNavigate();
  const run = usePlaceOrderWorkflow();
  const __products = useAllProducts();
  const { register, handleSubmit, control, formState: { errors } } = useForm<PlaceOrderRequest>({
    resolver: zodResolver(PlaceOrderRequest),
    defaultValues: { customerId: "", productId: "", quantity: 0 },
  });
  return (
    <Stack maw={600} data-testid="workflow-place_order">
      <Group justify="space-between">
        <Title order={2}>Place Order</Title>
        <Anchor component={Link} to="/workflows">← back</Anchor>
      </Group>
      <form
        onSubmit={handleSubmit(async (vals) => {
          try {
            await run.mutateAsync(vals);
            notifications.show({ color: "green", message: "Place Order completed" });
            navigate("/workflows");
          } catch (e) {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        })}
      >
        <Stack>
        <TextInput label="customerId" {...register("customerId")} data-testid="workflow-place_order-input-customerId" error={errors.customerId?.message} />
        <Controller
          control={control}
          name="productId"
          render={({ field, fieldState }) => (
            <Select label="productId" data-testid="workflow-place_order-input-productId" data={(__products.data ?? []).map((__o) => ({ value: __o.id, label: __o.sku }))} renderOption={({ option }) => <div data-testid={`workflow-place_order-input-productId-option-${option.value}`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
          )}
        />
        <Controller
          control={control}
          name="quantity"
          render={({ field, fieldState }) => (
            <NumberInput label="quantity" data-testid="workflow-place_order-input-quantity" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
          <Group justify="flex-end">
            <Button type="submit" loading={run.isPending} data-testid="workflow-place_order-submit">Run</Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}
