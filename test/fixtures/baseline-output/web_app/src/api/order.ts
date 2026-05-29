// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export const OrderStatusSchema = z.enum(["Draft", "Confirmed", "Shipped", "Cancelled"]);

export const CreateOrderRequest = z.object({
  customerId: z.string(),
  status: OrderStatusSchema,
  placedAt: z.string(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const AddLineRequest = z.object({
  productId: z.string(),
  qty: z.number().int().min(1),
});
export type AddLineRequest = z.infer<typeof AddLineRequest>;
export const ConfirmRequest = z.object({
});
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;
export const UpdateRequest = z.object({
  customerId: z.string(),
  status: OrderStatusSchema,
  placedAt: z.string(),
});
export type UpdateRequest = z.infer<typeof UpdateRequest>;

export const ByCustomerQuery = z.object({
  customerId: z.string(),
});
export type ByCustomerQuery = z.infer<typeof ByCustomerQuery>;

export const OrderLineResponse = z.object({
  id: z.string(),
  productId: z.string(),
  quantity: z.number().int(),
});
export type OrderLineResponse = z.infer<typeof OrderLineResponse>;
export const OrderResponse = z.object({
  id: z.string(),
  customerId: z.string(),
  status: OrderStatusSchema,
  placedAt: z.string(),
  lines: z.array(OrderLineResponse),
});
export type OrderResponse = z.infer<typeof OrderResponse>;
export const OrderListResponse = z.array(OrderResponse);
export type OrderListResponse = z.infer<typeof OrderListResponse>;

export function useAllOrders() {
  return useQuery({
    queryKey: ["orders"],
    queryFn: async () => {
      const r = await api.get(`/orders`);
      return OrderListResponse.parse(r);
    },
  });
}

export function useOrderById(id: string | undefined) {
  return useQuery({
    queryKey: ["orders", id],
    enabled: !!id,
    queryFn: async () => {
      const r = await api.get(`/orders/${id}`);
      return OrderResponse.parse(r);
    },
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOrderRequest) => {
      const r = await api.post(`/orders`, input);
      return z.object({ id: z.string() }).parse(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });
}

export function useDeleteOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/orders/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });
}

export function useAddLineOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddLineRequest) => {
      await api.post(`/orders/${id}/add_line`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders", id] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function useConfirmOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmRequest) => {
      await api.post(`/orders/${id}/confirm`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders", id] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function useUpdateOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateRequest) => {
      await api.post(`/orders/${id}/update`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["orders", id] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

export function useByCustomerOrder(query: ByCustomerQuery) {
  return useQuery({
    queryKey: ["orders", "find", "by_customer", query],
    queryFn: async () => {
      const qs = new URLSearchParams(query as Record<string, string>).toString();
      const r = await api.get(`/orders/by_customer${qs ? "?" + qs : ""}`);
      return OrderListResponse.parse(r);
    },
  });
}
