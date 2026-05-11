// Auto-generated.  Do not edit by hand.
import { useNavigate, Link } from "react-router-dom";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateCustomerRequest, useCreateCustomer } from "../../api/customer";
import { notifications } from "@mantine/notifications";
import { Anchor, Breadcrumbs, Button, Card, Group, NumberInput, Stack, Text, TextInput, Title } from "@mantine/core";

export default function CustomerNew() {
  const navigate = useNavigate();
  const create = useCreateCustomer();
  const { register, handleSubmit, control, formState: { errors } } = useForm<CreateCustomerRequest>({
    resolver: zodResolver(CreateCustomerRequest),
    defaultValues: { username: "", email: "", age: 0 },
  });
  return (
    <Stack data-testid="customers-new-page">
      <Breadcrumbs>
        <Anchor component={Link} to="/">Home</Anchor>
        <Anchor component={Link} to="/customers">Customers</Anchor>
        <Text>New</Text>
      </Breadcrumbs>
      <Title order={2}>Create customer</Title>
      <Card withBorder padding="md">
        <form onSubmit={handleSubmit(async (vals) => {
                  try {
                    const out = await create.mutateAsync(vals);
                    notifications.show({ color: "green", message: "Customer created" });
                    navigate(`/customers/${out.id}`);
                  } catch (e) {
                    notifications.show({ color: "red", message: (e as Error).message });
                  }
                })} data-testid="customers-new">
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
              <Button type="submit" loading={ create.isPending } data-testid="customers-new-submit">Create</Button>
            </Group>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
