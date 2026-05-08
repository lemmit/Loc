// Auto-generated.
import { useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, NumberInput, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateCustomerRequest, useCreateCustomer } from "../../api/customer";

export default function CustomerNew() {
  const navigate = useNavigate();
  const create = useCreateCustomer();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateCustomerRequest>({
    resolver: zodResolver(CreateCustomerRequest),
    defaultValues: { username: "", email: "", age: 0 },
  });
  return (
    <Stack maw={600} data-testid="customers-new">
      <Title order={2}>New customer</Title>
      <form
        onSubmit={handleSubmit(async (vals) => {
          try {
            const out = await create.mutateAsync(vals);
            notifications.show({ color: "green", message: "Customer created" });
            navigate(`/customers/${out.id}`);
          } catch (e) {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        })}
      >
        <Stack>
        <TextInput label="username" {...register("username")} data-testid="customers-new-input-username" error={errors.username?.message} />
        <TextInput label="email" {...register("email")} data-testid="customers-new-input-email" error={errors.email?.message} />
        <Controller
          control={control}
          name="age"
          render={({ field, fieldState }) => (
            <NumberInput label="age" data-testid="customers-new-input-age" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
          <Group justify="flex-end">
            <Button type="submit" loading={create.isPending} data-testid="customers-new-submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}
