// Auto-generated.
import { Link, useNavigate } from "react-router-dom";
import { Anchor, Breadcrumbs, Button, Card, Group, NumberInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
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
    <Stack maw={640} data-testid="workflow-place_order" gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/workflows">Workflows</Anchor>
        <Text>Place Order</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>Workflow</Text>
        <Title order={2}>Place Order</Title>
      </Stack>
      <Card>
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
          <Stack gap="md">
          <TextInput label="Customer Id" {...register("customerId")} data-testid="workflow-place_order-input-customerId" error={errors.customerId?.message} />

          <Controller
          control={control}
          name="productId"
          render={({ field, fieldState }) => (
            <Select label="Product Id" data-testid="workflow-place_order-input-productId" placeholder="Select…" searchable data={(__products.data ?? []).map((__o) => ({ value: __o.id, label: __o.sku }))} renderOption={({ option }) => <div data-testid={`workflow-place_order-input-productId-option-${option.value}`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
          )}
        />

          <Controller
          control={control}
          name="quantity"
          render={({ field, fieldState }) => (
            <NumberInput label="Quantity" data-testid="workflow-place_order-input-quantity" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => navigate("/workflows")}>Cancel</Button>
            <Button type="submit" loading={run.isPending} data-testid="workflow-place_order-submit">Run</Button>
          </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
