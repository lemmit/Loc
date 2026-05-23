// Auto-generated.  Do not edit by hand.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Product } from "../domain/product";
import { ProductRepository } from "../db/repositories/product-repository";
import * as Ids from "../domain/ids";
import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";
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


const AllQuery = z.object({
}).openapi("AllQuery");
const BySkuQuery = z.object({
  sku: z.string(),
}).openapi("BySkuQuery");
export const ProductResponse = z.object({
  id: z.string(),
  sku: z.string(),
  price: MoneySchema,
}).openapi("ProductResponse");
export const ProductListResponse = z.array(ProductResponse).openapi("ProductListResponse");
const ErrorResponse = z.object({ error: z.string() }).openapi("ErrorResponse");

export function productRoutes(repo: ProductRepository): OpenAPIHono {
  const app = new OpenAPIHono();

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
      path: "/{id}",
      tags: ["products"],
      operationId: "getProductById",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: ProductResponse } } },
        404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const found = await repo.findById(Ids.ProductId(id));
      if (!found) return c.json({ error: "not_found" }, 404);
      return c.json(repo.toWire(found) as z.infer<typeof ProductResponse>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["products"],
      operationId: "allProduct",
      responses: {
        200: { description: "OK", content: { "application/json": { schema: ProductListResponse } } },
      },
    }),
    async (c) => {
      const result = await repo.all();
      return c.json(result.map((r) => repo.toWire(r)) as z.infer<typeof ProductResponse>[], 200);
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
        404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    }),
    async (c) => {
      const params = c.req.valid("query");
      const result = await repo.bySku(params.sku);
      if (result == null) return c.json({ error: "not_found" }, 404);
      return c.json(repo.toWire(result) as z.infer<typeof ProductResponse>, 200);
    },
  );

  app.onError((err, c) => {
    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
    if (err instanceof ForbiddenError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "forbidden", aggregate: "Product", message: err.message, status: 403 });
      return c.json({ error: err.message, trace_id }, 403);
    }
    if (err instanceof DomainError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "domain_error", aggregate: "Product", message: err.message, status: 400 });
      return c.json({ error: err.message, trace_id }, 400);
    }
    if (err instanceof AggregateNotFoundError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").warn({ event: "not_found", aggregate: "Product", status: 404 });
      return c.json({ error: err.message, trace_id }, 404);
    }
    if (err instanceof ExternHandlerError) {
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").error({ event: "extern_handler_threw", aggregate: err.aggName, op: err.opName, error: err.message });
      return c.json({ error: err.message, trace_id }, 500);
    }
    (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").error({ event: "internal_error", error: err instanceof Error ? err.message : String(err), status: 500 });
    return c.json({ error: "internal", trace_id }, 500);
  });

  return app;
}
