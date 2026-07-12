// Auto-generated.  Do not edit by hand.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ProblemDetails, newApp } from "./problem-details";
import { Customer } from "../domain/customer";
import type { CustomerRepository } from "../db/repositories/customer-repository";
import * as Ids from "../domain/ids";
import { DomainError, AggregateNotFoundError, DisallowedError, ForbiddenError, ExternHandlerError } from "../domain/errors";


const CreateCustomerRequest = z.object({
  username: z.string().min(3).max(32),
  email: z.string(),
  age: z.coerce.number().int().min(18).max(150),
}).openapi("CreateCustomerRequest").refine((data) => data.username !== data.email, { path: ["username"], message: "Invariant violated: username != email" }).refine((data) => /^[^@]+@[^@]+\.[^@]+$/.test(data.email) && data.email.length <= 120, { path: ["email"], message: "Invariant violated: email check email.matches(\"^[^@]+@[^@]+\\\\.[^@]+$\") && email.length <= 120" });
const CreateCustomerResponse = z.object({ id: z.string() }).openapi("CreateCustomerResponse");

const UpdateCustomerRequest = z.object({
  username: z.string(),
  email: z.string(),
  age: z.coerce.number().int(),
}).openapi("UpdateCustomerRequest");

const ByEmailQuery = z.object({
  email: z.string(),
}).openapi("ByEmailQuery");
export const CustomerResponse = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  age: z.number().int(),
  display: z.string(),
}).openapi("CustomerResponse");
export const CustomerListResponse = z.array(CustomerResponse).openapi("CustomerListResponse");

export function customerRoutes(repo: CustomerRepository): OpenAPIHono {
  const app = newApp();

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
        400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },
        422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const created = Customer.create({ username: body.username, email: body.email, age: body.age });
      await repo.save(created);
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").info({ event: "aggregate_created", aggregate: "Customer", id: created.id as string });
      return c.json({ id: created.id as string }, 201);
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
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const params = c.req.valid("query");
      const result = await repo.byEmail(params.email);
      if (result == null) throw new AggregateNotFoundError("not_found");
      return c.json(repo.toWire(result) as z.infer<typeof CustomerResponse>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["customers"],
      operationId: "getCustomerById",
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: CustomerResponse } } },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const found = await repo.findById(Ids.CustomerId(id));
      if (!found) throw new AggregateNotFoundError("not_found");
      return c.json(repo.toWire(found) as z.infer<typeof CustomerResponse>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["customers"],
      operationId: "destroyCustomer",
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: "No Content" },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
        409: { description: "Conflict", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await repo.getById(Ids.CustomerId(id));
      try {
        await repo.delete(Ids.CustomerId(id));
      } catch (err) {
        if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23503")) {
          return c.body(JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, detail: "Customer is still referenced and cannot be deleted.", instance: c.req.path }), 409, { "content-type": "application/problem+json" });
        }
        throw err;
      }
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/update",
      tags: ["customers"],
      operationId: "updateCustomer",
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: UpdateCustomerRequest } } },
      },
      responses: {
        204: { description: "No content" },
        400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },
        422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").info({ event: "operation_invoked", aggregate: "Customer", op: "update", id });
      const aggregate = await repo.getById(Ids.CustomerId(id));
      aggregate.update(body.username, body.email, body.age);
      await repo.save(aggregate);
      return c.body(null, 204);
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

  app.onError((err, c) => {
    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
    const problem = (status: 400 | 403 | 404 | 409 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });
    if (err instanceof ForbiddenError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "forbidden", aggregate: "Customer", message: err.message, status: 403 });
      return problem(403, "Forbidden", err.message);
    }
    if (err instanceof DisallowedError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "disallowed", aggregate: "Customer", message: err.message, status: 409 });
      return problem(409, "Disallowed", err.message);
    }
    if (err instanceof DomainError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "domain_error", aggregate: "Customer", message: err.message, status: 400 });
      return problem(400, "Bad Request", err.message);
    }
    if (err instanceof AggregateNotFoundError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "not_found", aggregate: "Customer", status: 404 });
      return problem(404, "Not Found", err.message);
    }
    if (err instanceof ExternHandlerError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").error({ event: "extern_handler_threw", aggregate: err.aggName, op: err.opName, error: err.message });
      return problem(500, "Internal Server Error", err.message);
    }
    (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").error({ event: "internal_error", error: err instanceof Error ? err.message : String(err), status: 500 });
    return problem(500, "Internal Server Error", "internal");
  });

  return app;
}
