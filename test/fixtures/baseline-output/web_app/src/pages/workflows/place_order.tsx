// Auto-generated.  Do not edit by hand.
import { useNavigate, Link as RouterLink } from "react-router";
import { useAllProducts } from "../../api/product";
import { PlaceOrderRequest, usePlaceOrderWorkflow } from "../../api/workflows";
import { applyServerErrors } from "../../lib/apply-server-errors";
import { zodResolver } from "@hookform/resolvers/zod";
import { Anchor, Breadcrumbs, Button, Card, Group, NumberInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Controller, useForm } from "react-hook-form";

export default function PlaceOrderWorkflow() {
  const navigate = useNavigate();
  const run = usePlaceOrderWorkflow();
  const __products = useAllProducts();
  const { register, handleSubmit, setError, control, formState: { errors } } = useForm<PlaceOrderRequest>({
    resolver: zodResolver(PlaceOrderRequest),
    defaultValues: { customerId: "", productId: "", quantity: 0 },
  });
  return (
    <Stack data-testid="workflow-place_order-page">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/workflows">Workflows</Anchor>
        <Text>Place Order</Text>
      </Breadcrumbs>
      <Title order={2}>Place Order</Title>
      <Card withBorder padding="md">
        <form onSubmit={handleSubmit(async (vals) => {
                  try {
                    await run.mutateAsync(vals);
                    notifications.show({ color: "green", message: "Place Order completed" });
                    navigate("/workflows");
                  } catch (e) {
                    const outcome = applyServerErrors({ error: e, setError, fieldMap: {} as const });
                    if (outcome.kind === "global") {
                      notifications.show({ color: "red", message: outcome.title });
                    } else if (outcome.kind === "unhandled") {
                      notifications.show({ color: "red", message: (e as Error).message });
                    }
                  }
                })} data-testid="workflow-place_order">
          <Stack gap="md">
            <TextInput label="Customer Id" {...register("customerId")} data-testid="workflow-place_order-input-customerId" error={errors.customerId?.message} />
    
            <Controller
              control={control}
              name="productId"
              render={({ field, fieldState }) => (
                <Select label="Product Id" data-testid="workflow-place_order-input-productId" placeholder="Select…" searchable data={(__products.data?.items ?? []).map((__o) => ({ value: __o.id, label: __o.display }))} renderOption={({ option }) => <div data-testid={`workflow-place_order-input-productId-option-${option.value}`}>{option.label}</div>} allowDeselect={false} value={field.value as string} onChange={(v) => field.onChange(v ?? "")} error={fieldState.error?.message} />
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
              <Button type="submit" loading={ run.isPending } data-testid="workflow-place_order-submit">Run</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
