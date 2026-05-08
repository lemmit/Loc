// Auto-generated.
// (new page: no aggregate data fetched yet, no display-field title.)
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, Card, Text, Anchor, Breadcrumbs, Fieldset, NumberInput, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateProductRequest, useCreateProduct } from "../../api/product";

export default function ProductNew() {
  const navigate = useNavigate();
  const create = useCreateProduct();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateProductRequest>({
    resolver: zodResolver(CreateProductRequest),
    defaultValues: { sku: "", price: { amount: 0, currency: "" } },
  });
  return (
    <Stack maw={640} data-testid="products-new" gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/products">Products</Anchor>
        <Text>New</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>New product</Text>
        <Title order={2}>Create product</Title>
      </Stack>
      <Card>
        <form
          onSubmit={handleSubmit(async (vals) => {
            try {
              const out = await create.mutateAsync(vals);
              notifications.show({ color: "green", message: "Product created" });
              navigate(`/products/${out.id}`);
            } catch (e) {
              notifications.show({ color: "red", message: (e as Error).message });
            }
          })}
        >
          <Stack gap="md">
          <TextInput label="Sku" {...register("sku")} data-testid="products-new-input-sku" error={errors.sku?.message} />
        <Fieldset legend="Price" variant="filled" radius="md" data-testid="products-new-input-price">
          <Stack gap="sm">
            <Controller
          control={control}
          name="price.amount"
          render={({ field, fieldState }) => (
            <NumberInput label="Amount" data-testid="products-new-input-price-amount" decimalScale={2} fixedDecimalScale value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
            <TextInput label="Currency" {...register("price.currency")} data-testid="products-new-input-price-currency" error={errors.price?.currency?.message} />
          </Stack>
        </Fieldset>
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => navigate("/products")}>Cancel</Button>
              <Button type="submit" loading={create.isPending} data-testid="products-new-submit">Create</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
