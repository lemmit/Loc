// Auto-generated.  Do not edit by hand.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ProblemDetails, newApp } from "./problem-details";
import { Product } from "../domain/product";
import type { ProductRepository } from "../db/repositories/product-repository";
import * as Ids from "../domain/ids";
import { DomainError, AggregateNotFoundError, DisallowedError, ForbiddenError, ExternHandlerError, ConcurrencyError } from "../domain/errors";
import { Money } from "../domain/value-objects";

const MoneySchema = z.object({
  amount: z.coerce.number().min(0),
  currency: z.string().length(3),
}).openapi("Money");

const CreateProductRequest = z.object({
  sku: z.string().min(1),
  price: MoneySchema,
}).openapi("CreateProductRequest");
const CreateProductResponse = z.object({ id: z.string() }).openapi("CreateProductResponse");

const UpdateProductRequest = z.object({
  sku: z.string().min(1),
  price: MoneySchema,
}).openapi("UpdateProductRequest");

const AllQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20),
  sort: z.string().default("id"),
  dir: z.string().default("asc"),
}).openapi("AllQuery");
const BySkuQuery = z.object({
  sku: z.string(),
}).openapi("BySkuQuery");
export const ProductResponse = z.object({
  id: z.string(),
  sku: z.string(),
  price: MoneySchema,
  version: z.number().int(),
  display: z.string(),
}).openapi("ProductResponse");
export const ProductListResponse = z.array(ProductResponse).openapi("ProductListResponse");
export const ProductPaged = z.object({ items: z.array(ProductResponse), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() }).openapi("ProductPaged");

export function productRoutes(repo: ProductRepository): OpenAPIHono {
  const app = newApp();

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["products"],
      operationId: "createProduct",
      request: {
        body: { content: { "application/json": { schema: CreateProductRequest } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: CreateProductResponse } },
        },
        400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },
        422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const created = Product.create({ sku: body.sku, price: new Money(body.price.amount, body.price.currency) });
      await repo.save(created);
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").info({ event: "aggregate_created", aggregate: "Product", id: created.id as string });
      return c.json({ id: created.id as string }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/by_sku",
      tags: ["products"],
      operationId: "bySkuProduct",
      request: { query: BySkuQuery },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: ProductResponse } } },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const params = c.req.valid("query");
      const result = await repo.bySku(params.sku);
      if (result == null) throw new AggregateNotFoundError("not_found");
      return c.json(repo.toWire(result) as z.infer<typeof ProductResponse>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: ["products"],
      operationId: "getProductById",
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: ProductResponse } } },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const found = await repo.findById(Ids.ProductId(id));
      if (!found) throw new AggregateNotFoundError("not_found");
      return c.json(repo.toWire(found) as z.infer<typeof ProductResponse>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["products"],
      operationId: "destroyProduct",
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: "No Content" },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
        409: { description: "Conflict", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await repo.getById(Ids.ProductId(id));
      try {
        await repo.delete(Ids.ProductId(id));
      } catch (err) {
        if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23503")) {
          return c.body(JSON.stringify({ type: "about:blank", title: "Conflict", status: 409, detail: "Product is still referenced and cannot be deleted.", instance: c.req.path }), 409, { "content-type": "application/problem+json" });
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
      tags: ["products"],
      operationId: "updateProduct",
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: UpdateProductRequest } } },
      },
      responses: {
        204: { description: "No content" },
        400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },
        422: { description: "Unprocessable Entity", content: { "application/problem+json": { schema: ProblemDetails } } },
        409: { description: "Conflict", content: { "application/problem+json": { schema: ProblemDetails } } },
        404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").info({ event: "operation_invoked", aggregate: "Product", op: "update", id });
      const aggregate = await repo.getById(Ids.ProductId(id));
      const ifMatch = c.req.header("if-match");
      const expectedVersion = ifMatch !== undefined ? Number(ifMatch) : aggregate.version;
      aggregate.update(body.sku, new Money(body.price.amount, body.price.currency));
      await repo.save(aggregate, expectedVersion);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["products"],
      operationId: "allProduct",
      request: { query: AllQuery },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: ProductPaged } } },
      },
    }),
    async (c) => {
      const params = c.req.valid("query");
      const result = await repo.all(params.page, params.pageSize, params.sort, params.dir);
      return c.json({ ...result, items: result.items.map((r) => repo.toWire(r)) } as z.infer<typeof ProductPaged>, 200);
    },
  );

  app.onError((err, c) => {
    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
    const problem = (status: 400 | 403 | 404 | 409 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });
    if (err instanceof ForbiddenError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "forbidden", aggregate: "Product", message: err.message, status: 403 });
      return problem(403, "Forbidden", err.message);
    }
    if (err instanceof DisallowedError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "disallowed", aggregate: "Product", message: err.message, status: 409 });
      return problem(409, "Disallowed", err.message);
    }
    if (err instanceof DomainError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "domain_error", aggregate: "Product", message: err.message, status: 400 });
      return problem(400, "Bad Request", err.message);
    }
    if (err instanceof AggregateNotFoundError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "not_found", aggregate: "Product", status: 404 });
      return problem(404, "Not Found", err.message);
    }
    if (err instanceof ConcurrencyError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "conflict", aggregate: "Product", message: err.message, status: 409 });
      return problem(409, "Conflict", err.message);
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
