// Auto-generated.  Do not edit by hand.
import { useParams, Link as RouterLink } from "react-router";
import { UpdateCustomerRequest, useUpdateCustomer } from "../../api/customer";
import { applyServerErrors } from "../../lib/apply-server-errors";
import { KeyValueRow } from "../../lib/format";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Anchor, Breadcrumbs, Button, Card, Group, NumberInput, Skeleton, Stack, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { Controller, useForm } from "react-hook-form";
import { useCustomerById } from "../../api/customer";
function openUpdateModal(mut: ReturnType<typeof useUpdateCustomer>): void {
  modals.open({
    title: "Update",
    children: <UpdateForm mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function UpdateForm({ mut, onClose }: { mut: ReturnType<typeof useUpdateCustomer>; onClose: () => void }) {
  const { register, handleSubmit, setError, control, formState: { errors } } = useForm<UpdateCustomerRequest>({
    resolver: zodResolver(UpdateCustomerRequest),
    defaultValues: { username: "", email: "", age: 0 },
  });
  return (
    <form
      data-testid="customers-op-update-form"
      onSubmit={handleSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "Update succeeded" });
          onClose();
        } catch (e) {
          const outcome = applyServerErrors({ error: e, setError, fieldMap: {} as const });
          if (outcome.kind === "global") {
            notifications.show({ color: "red", message: outcome.title });
          } else if (outcome.kind === "unhandled") {
            notifications.show({ color: "red", message: (e as Error).message });
          }
        }
      })}
    >
      <Stack>
        <TextInput label="Username" {...register("username")} data-testid="customers-op-update-input-username" error={errors.username?.message} />

        <TextInput label="Email" {...register("email")} data-testid="customers-op-update-input-email" error={errors.email?.message} />

        <Controller
          control={control}
          name="age"
          render={({ field, fieldState }) => (
            <NumberInput label="Age" data-testid="customers-op-update-input-age" allowDecimal={false} value={field.value as number | "" | undefined} onChange={(v) => field.onChange(typeof v === "number" ? v : Number(v) || 0)} error={fieldState.error?.message} />
          )}
        />

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="customers-op-update-submit">Update</Button>
        </Group>
      </Stack>
    </form>
  );
}

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const customerById = useCustomerById(id);
  const update = useUpdateCustomer(id ?? "");
  return (
    <Stack data-testid="customers-detail">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/customers">Customers</Anchor>
        <Text>Detail</Text>
      </Breadcrumbs>
      <Title order={2}>Customer detail</Title>
      <>
        { customerById.isLoading && (
          <Stack gap="xs" aria-hidden="true">
    { Array.from({ length: 3 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { customerById.isError && (
          <Alert color="red" variant="light">Couldn't load customer</Alert>
        ) }
        { !customerById.isLoading && !customerById.isError && !customerById.data && (
          <Alert color="yellow" variant="light">No customer matches that id.</Alert>
        ) }
        { customerById.data && (
          <Card withBorder padding="md">
            <Stack>
              <KeyValueRow label="Username" data-testid="customers-detail-username"><Text>{customerById.data.username}</Text></KeyValueRow>
              <KeyValueRow label="Email" data-testid="customers-detail-email"><Text>{customerById.data.email}</Text></KeyValueRow>
              <KeyValueRow label="Age" data-testid="customers-detail-age"><Text>{customerById.data.age}</Text></KeyValueRow>
              <KeyValueRow label="Version" data-testid="customers-detail-version"><Text>{customerById.data.version}</Text></KeyValueRow>
            </Stack>
          </Card>
        ) }
      </>
      <Group>
        <Button variant="filled" onClick={() => openUpdateModal(update)} data-testid="customers-op-update">Update</Button>
    
      </Group>
    </Stack>
  );
}
