// Auto-generated.  Do not edit by hand.
import { useParams, Link as RouterLink } from "react-router";
import { UpdateRequest, useUpdateProduct } from "../../api/product";
import { KeyValueRow } from "../../lib/format";
import { zodResolver } from "@hookform/resolvers/zod";
import { Alert, Anchor, Breadcrumbs, Button, Card, Group, Skeleton, Stack, Text, TextInput, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useForm } from "react-hook-form";
import { useProductById } from "../../api/product";
function openUpdateModal(mut: ReturnType<typeof useUpdateProduct>): void {
  modals.open({
    title: "Update",
    children: <UpdateForm mut={mut} onClose={() => modals.closeAll()} />,
  });
}

function UpdateForm({ mut, onClose }: { mut: ReturnType<typeof useUpdateProduct>; onClose: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<UpdateRequest>({
    resolver: zodResolver(UpdateRequest),
    defaultValues: { sku: "", price: "" },
  });
  return (
    <form
      data-testid="products-op-update-form"
      onSubmit={handleSubmit(async (vals) => {
        try {
          await mut.mutateAsync(vals);
          notifications.show({ color: "green", message: "Update succeeded" });
          onClose();
        } catch (e) {
          notifications.show({ color: "red", message: (e as Error).message });
        }
      })}
    >
      <Stack>
        <TextInput label="Sku" {...register("sku")} data-testid="products-op-update-input-sku" error={errors.sku?.message} />

        <TextInput label="Price" {...register("price")} data-testid="products-op-update-input-price" error={errors.price?.message} />

        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={mut.isPending} data-testid="products-op-update-submit">Update</Button>
        </Group>
      </Stack>
    </form>
  );
}

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const productById = useProductById(id);
  const update = useUpdateProduct(id ?? "");
  return (
    <Stack data-testid="products-detail">
      <Breadcrumbs>
        <Anchor component={RouterLink} to="/">Home</Anchor>
        <Anchor component={RouterLink} to="/products">Products</Anchor>
        <Text>Detail</Text>
      </Breadcrumbs>
      <Title order={2}>Product detail</Title>
      <>
        { productById.isLoading && (
          <Stack gap="xs">
    { Array.from({ length: 3 }).map((_, i) => (
    <Skeleton key={i} height={ 28 } radius="sm" />
    )) }
    </Stack>
        ) }
        { productById.isError && (
          <Alert color="red" variant="light">Couldn't load product</Alert>
        ) }
        { !productById.isLoading && !productById.isError && !productById.data && (
          <Alert color="yellow" variant="light">No product matches that id.</Alert>
        ) }
        { productById.data && (
          <Card withBorder padding="md">
            <Stack>
              <KeyValueRow label="Sku" data-testid="products-detail-sku"><Text>{productById.data.sku}</Text></KeyValueRow>
              <KeyValueRow label="Price Amount"><Text>{productById.data.price.amount}</Text></KeyValueRow>
              <KeyValueRow label="Price Currency"><Text>{productById.data.price.currency}</Text></KeyValueRow>
            </Stack>
          </Card>
        ) }
      </>
      <Group>
        <Button variant="filled" onClick={() => openUpdateModal(update)} data-testid="products-op-update">Update</Button>
    
      </Group>
    </Stack>
  );
}
