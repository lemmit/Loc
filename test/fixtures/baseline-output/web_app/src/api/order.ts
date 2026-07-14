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

export const AddLineOrderRequest = z.object({
  productId: z.string(),
  qty: z.number().int().min(1),
});
export type AddLineOrderRequest = z.infer<typeof AddLineOrderRequest>;
export const ConfirmOrderRequest = z.object({
});
export type ConfirmOrderRequest = z.infer<typeof ConfirmOrderRequest>;
export const UpdateOrderRequest = z.object({
  customerId: z.string(),
  status: OrderStatusSchema,
  placedAt: z.string(),
});
export type UpdateOrderRequest = z.infer<typeof UpdateOrderRequest>;

export const AllQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20),
  sort: z.string().default("id"),
  dir: z.string().default("asc"),
});
export type AllQuery = z.infer<typeof AllQuery>;
export type AllQueryInput = z.input<typeof AllQuery>;
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
export const OrderPaged = z.object({ items: z.array(OrderResponse), page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() });
export type OrderPaged = z.infer<typeof OrderPaged>;

export function useAllOrders(query: AllQueryInput = {}) {
  const q = AllQuery.parse(query);
  return useQuery({
    queryKey: ["orders", "list", q],
    queryFn: async () => {
      const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
      const r = await api.get(`/orders${qs ? "?" + qs : ""}`);
      return OrderPaged.parse(r);
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
    mutationFn: async (input: AddLineOrderRequest) => {
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
    mutationFn: async (input: ConfirmOrderRequest) => {
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
    mutationFn: async (input: UpdateOrderRequest) => {
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
      const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
      const r = await api.get(`/orders/by_customer${qs ? "?" + qs : ""}`);
      return OrderListResponse.parse(r);
    },
  });
}
