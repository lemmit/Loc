// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import { OrderResponse, OrderListResponse } from "./order";
import { OrderStatusSchema } from "./order";

export const ActiveOrdersResponse = OrderListResponse;
export type ActiveOrdersResponse = z.infer<typeof ActiveOrdersResponse>;

export function useActiveOrdersView() {
  return useQuery({
    queryKey: ["views", "active_orders"],
    queryFn: async () => {
      const r = await api.get(`/views/active_orders`);
      return ActiveOrdersResponse.parse(r);
    },
  });
}

export const OrderSummaryRow = z.object({
  orderId: z.string(),
  status: OrderStatusSchema,
  lineCount: z.number().int(),
});
export type OrderSummaryRow = z.infer<typeof OrderSummaryRow>;
export const OrderSummaryResponse = z.array(OrderSummaryRow);
export type OrderSummaryResponse = z.infer<typeof OrderSummaryResponse>;

export function useOrderSummaryView() {
  return useQuery({
    queryKey: ["views", "order_summary"],
    queryFn: async () => {
      const r = await api.get(`/views/order_summary`);
      return OrderSummaryResponse.parse(r);
    },
  });
}
