// Auto-generated.
// (new page: no aggregate data fetched yet, no display-field title.)
import { Link, useNavigate } from "react-router-dom";
import { Stack, Title, Button, Group, Card, Text, Anchor, Breadcrumbs, NumberInput, TextInput } from "@mantine/core";
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
    <Stack maw={640} data-testid="customers-new" gap="md">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/customers">Customers</Anchor>
        <Text>New</Text>
      </Breadcrumbs>
      <Stack gap={2}>
        <Text size="sm" c="dimmed" tt="uppercase" fw={600}>New customer</Text>
        <Title order={2}>Create customer</Title>
      </Stack>
      <Card>
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
          <Stack gap="md">
          <TextInput label="Username" {...register("username")} data-testid="customers-new-input-username" error={errors.username?.message} />
        <TextInput label="Email" {...register("email")} data-testid="customers-new-input-email" error={errors.email?.message} />
        <Controller
          control={control}
          name="age"
          render={({ field, fieldState }) => (
            <NumberInput label="Age" data-testid="customers-new-input-age" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => navigate("/customers")}>Cancel</Button>
              <Button type="submit" loading={create.isPending} data-testid="customers-new-submit">Create</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
