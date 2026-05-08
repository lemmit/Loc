// Auto-generated.  Do not edit by hand.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Customer } from "../domain/customer.js";
import { CustomerRepository } from "../db/repositories/customer-repository.js";
import * as Ids from "../domain/ids.js";
import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors.js";


const CreateCustomerRequest = z.object({
  username: z.string().min(3).max(32),
  email: z.string(),
  age: z.coerce.number().int().min(18).max(150),
}).openapi("CreateCustomerRequest").refine((data) => data.username !== data.email, { path: ["username"], message: "Invariant violated: username != email" }).refine((data) => new RegExp("^[^@]+@[^@]+\\.[^@]+$").test(data.email) && data.email.length <= 120, { path: ["email"], message: "Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120" });
const CreateCustomerResponse = z.object({ id: z.string() }).openapi("CreateCustomerResponse");


const AllQuery = z.object({
}).openapi("AllQuery");
const ByEmailQuery = z.object({
  email: z.string(),
}).openapi("ByEmailQuery");
export const CustomerResponse = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  age: z.number().int(),
}).openapi("CustomerResponse");
export const CustomerListResponse = z.array(CustomerResponse).openapi("CustomerListResponse");
const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");

export function customerRoutes(repo: CustomerRepository): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["customers"],
      operationId: "createCustomer",
      request: {
        body: { content: { "application/json": { schema: CreateCustomerRequest } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: CreateCustomerResponse } },
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const created = Customer.create({ username: body.username, email: body.email, age: body.age });
      await repo.save(created);
      return c.json({ id: created.id as string }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["customers"],
      operationId: "getCustomerById",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: CustomerResponse } } },
        404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const found = await repo.findById(Ids.CustomerId(id));
      if (!found) return c.json({ error: "not_found" }, 404);
      return c.json(repo.toWire(found) as z.infer<typeof CustomerResponse>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["customers"],
      operationId: "allCustomer",
      responses: {
        200: { description: "OK", content: { "application/json": { schema: CustomerListResponse } } },
      },
    }),
    async (c) => {
      const result = await repo.all();
      return c.json(result.map((r) => repo.toWire(r)) as z.infer<typeof CustomerResponse>[], 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/by_email",
      tags: ["customers"],
      operationId: "byEmailCustomer",
      request: { query: ByEmailQuery },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: CustomerResponse } } },
        404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    }),
    async (c) => {
      const params = c.req.valid("query");
      const result = await repo.byEmail(params.email);
      if (result == null) return c.json({ error: "not_found" }, 404);
      return c.json(repo.toWire(result) as z.infer<typeof CustomerResponse>, 200);
    },
  );

  app.onError((err, c) => {
    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
    if (err instanceof ForbiddenError) return c.json({ error: err.message, trace_id }, 403);
    if (err instanceof DomainError) return c.json({ error: err.message, trace_id }, 400);
    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message, trace_id }, 404);
    if (err instanceof ExternHandlerError) { console.error(err); return c.json({ error: err.message, trace_id }, 500); }
    console.error(err);
    return c.json({ error: "internal", trace_id }, 500);
  });

  return app;
}
