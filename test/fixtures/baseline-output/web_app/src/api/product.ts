// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export const MoneySchema = z.object({
  amount: z.number().min(0),
  currency: z.string().length(3),
});

export const CreateProductRequest = z.object({
  sku: z.string().min(1),
  price: MoneySchema,
});
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;

export const UpdateProductRequest = z.object({
  sku: z.string().min(1),
  price: MoneySchema,
});
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;

export const AllQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20),
  sort: z.string().default("id"),
  dir: z.string().default("asc"),
});
export type AllQuery = z.infer<typeof AllQuery>;
export type AllQueryInput = z.input<typeof AllQuery>;
export const BySkuQuery = z.object({
  sku: z.string(),
});
export type BySkuQuery = z.infer<typeof BySkuQuery>;

export const ProductResponse = z.object({
  id: z.string(),
  sku: z.string(),
  price: MoneySchema,
  display: z.string(),
});
export type ProductResponse = z.infer<typeof ProductResponse>;
export const ProductListResponse = z.array(ProductResponse);
export type ProductListResponse = z.infer<typeof ProductListResponse>;
export const ProductPaged = z.object({ items: z.array(ProductResponse), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() });
export type ProductPaged = z.infer<typeof ProductPaged>;

export function useAllProducts(query: AllQueryInput = {}) {
  const q = AllQuery.parse(query);
  return useQuery({
    queryKey: ["products", "list", q],
    queryFn: async () => {
      const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
      const r = await api.get(`/products${qs ? "?" + qs : ""}`);
      return ProductPaged.parse(r);
    },
  });
}

export function useProductById(id: string | undefined) {
  return useQuery({
    queryKey: ["products", id],
    enabled: !!id,
    queryFn: async () => {
      const r = await api.get(`/products/${id}`);
      return ProductResponse.parse(r);
    },
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateProductRequest) => {
      const r = await api.post(`/products`, input);
      return z.object({ id: z.string() }).parse(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useDeleteProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/products/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useUpdateProduct(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProductRequest) => {
      await api.post(`/products/${id}/update`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products", id] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

export function useBySkuProduct(query: BySkuQuery) {
  return useQuery({
    queryKey: ["products", "find", "by_sku", query],
    queryFn: async () => {
      const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
      const r = await api.get(`/products/by_sku${qs ? "?" + qs : ""}`);
      return ProductResponse.nullable().parse(r);
    },
  });
}
