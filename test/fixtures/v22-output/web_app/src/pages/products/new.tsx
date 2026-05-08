// Auto-generated.
import { useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, Fieldset, NumberInput, TextInput } from "@mantine/core";
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
    <Stack maw={600} data-testid="products-new">
      <Title order={2}>New product</Title>
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
        <Stack>
        <TextInput label="sku" {...register("sku")} data-testid="products-new-input-sku" error={errors.sku?.message} />
        <Fieldset legend="price" data-testid="products-new-input-price">
          <Controller
          control={control}
          name="price.amount"
          render={({ field, fieldState }) => (
            <NumberInput label="price.amount" data-testid="products-new-input-price-amount" decimalScale={2} fixedDecimalScale value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
          <TextInput label="price.currency" {...register("price.currency")} data-testid="products-new-input-price-currency" error={errors.price?.currency?.message} />
        </Fieldset>
          <Group justify="flex-end">
            <Button type="submit" loading={create.isPending} data-testid="products-new-submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}
