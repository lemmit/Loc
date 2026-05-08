// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { api } from "./client";

export const PlaceOrderRequest = z.object({
  customerId: z.string(),
  productId: z.string(),
  quantity: z.number().int(),
});
export type PlaceOrderRequest = z.infer<typeof PlaceOrderRequest>;

export function usePlaceOrderWorkflow() {
  return useMutation({
    mutationFn: async (input: PlaceOrderRequest) => {
      await api.post(`/workflows/place_order`, input);
    },
  });
}
