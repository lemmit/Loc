// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";


export const CreateCustomerRequest = z.object({
  username: z.string().min(3).max(32),
  email: z.string(),
  age: z.number().int().min(18).max(150),
}).refine((data) => data.username !== data.email, { path: ["username"], message: "Invariant violated: username != email" }).refine((data) => /^[^@]+@[^@]+\.[^@]+$/.test(data.email) && data.email.length <= 120, { path: ["email"], message: "Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120" });
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;

export const UpdateCustomerRequest = z.object({
  username: z.string().min(3).max(32),
  email: z.string(),
  age: z.number().int().min(18).max(150),
}).refine((data) => data.username !== data.email, { path: ["username"], message: "Invariant violated: username != email" }).refine((data) => /^[^@]+@[^@]+\.[^@]+$/.test(data.email) && data.email.length <= 120, { path: ["email"], message: "Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120" });
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;

export const AllQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20),
  sort: z.string().default("id"),
  dir: z.string().default("asc"),
});
export type AllQuery = z.infer<typeof AllQuery>;
export type AllQueryInput = z.input<typeof AllQuery>;
export const ByEmailQuery = z.object({
  email: z.string(),
});
export type ByEmailQuery = z.infer<typeof ByEmailQuery>;

export const CustomerResponse = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  age: z.number().int(),
  display: z.string(),
});
export type CustomerResponse = z.infer<typeof CustomerResponse>;
export const CustomerListResponse = z.array(CustomerResponse);
export type CustomerListResponse = z.infer<typeof CustomerListResponse>;
export const CustomerPaged = z.object({ items: z.array(CustomerResponse), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() });
export type CustomerPaged = z.infer<typeof CustomerPaged>;

export function useAllCustomers(query: AllQueryInput = {}) {
  const q = AllQuery.parse(query);
  return useQuery({
    queryKey: ["customers", "list", q],
    queryFn: async () => {
      const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
      const r = await api.get(`/customers${qs ? "?" + qs : ""}`);
      return CustomerPaged.parse(r);
    },
  });
}

export function useCustomerById(id: string | undefined) {
  return useQuery({
    queryKey: ["customers", id],
    enabled: !!id,
    queryFn: async () => {
      const r = await api.get(`/customers/${id}`);
      return CustomerResponse.parse(r);
    },
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCustomerRequest) => {
      const r = await api.post(`/customers`, input);
      return z.object({ id: z.string() }).parse(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/customers/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useUpdateCustomer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateCustomerRequest) => {
      await api.post(`/customers/${id}/update`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers", id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useByEmailCustomer(query: ByEmailQuery) {
  return useQuery({
    queryKey: ["customers", "find", "by_email", query],
    queryFn: async () => {
      const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
      const r = await api.get(`/customers/by_email${qs ? "?" + qs : ""}`);
      return CustomerResponse.nullable().parse(r);
    },
  });
}
