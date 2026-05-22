import { describe, expect, it } from "vitest";
import {
  classifyShape,
  collectOps,
  collectResponseShapes,
  fieldSet,
  normalisePath,
  type OpenApiSpec,
} from "./openapi-normalize.js";

describe("openapi-normalize", () => {
  describe("normalisePath", () => {
    it("collapses path parameters to {id}", () => {
      expect(normalisePath("/products/{productId}")).toBe("/products/{id}");
      expect(normalisePath("/orders/{orderId}/lines/{lineId}")).toBe("/orders/{id}/lines/{id}");
    });
    it("strips trailing slashes and keeps root", () => {
      expect(normalisePath("/products/")).toBe("/products");
      expect(normalisePath("/")).toBe("/");
      expect(normalisePath("")).toBe("/");
    });
  });

  describe("collectOps", () => {
    const spec: OpenApiSpec = {
      paths: {
        "/products": { get: {}, post: {} },
        "/products/{id}": { get: {} },
        "/health": { get: {} },
        "/openapi.json": { get: {} },
        "/swagger/v1/swagger.json": { get: {} },
      },
    };
    it("collects METHOD+path pairs, uppercased and normalised", () => {
      expect(collectOps(spec)).toEqual(
        new Set(["GET /products", "POST /products", "GET /products/{id}"]),
      );
    });
    it("strips infrastructure endpoints", () => {
      const ops = collectOps(spec);
      expect([...ops].some((o) => o.includes("/health"))).toBe(false);
      expect([...ops].some((o) => o.includes("/swagger"))).toBe(false);
      expect([...ops].some((o) => o.includes("/openapi.json"))).toBe(false);
    });
  });

  describe("fieldSet", () => {
    const spec: OpenApiSpec = {
      components: {
        schemas: {
          ProductResponse: { type: "object", properties: { id: {}, sku: {}, price: {} } },
          Empty: { type: "object" },
        },
      },
    };
    it("returns the property-name set of a named schema", () => {
      expect(fieldSet(spec, "ProductResponse")).toEqual(new Set(["id", "sku", "price"]));
    });
    it("returns empty for missing schema or no properties", () => {
      expect(fieldSet(spec, "Nope").size).toBe(0);
      expect(fieldSet(spec, "Empty").size).toBe(0);
    });
  });

  describe("classifyShape", () => {
    const spec: OpenApiSpec = {
      components: {
        schemas: {
          ProductResponse: { type: "object", properties: { id: {} } },
          ProductListResponse: {
            type: "array",
            items: { $ref: "#/components/schemas/ProductResponse" },
          },
        },
      },
    };
    it("classifies a direct array", () => {
      expect(classifyShape({ type: "array", items: {} }, spec)).toBe("array");
    });
    it("classifies a $ref to a list component as array", () => {
      expect(classifyShape({ $ref: "#/components/schemas/ProductListResponse" }, spec)).toBe(
        "array",
      );
    });
    it("classifies Swashbuckle nullable (nullable: true)", () => {
      expect(classifyShape({ type: "object", nullable: true }, spec)).toBe("nullable");
    });
    it("classifies zod-openapi nullable (oneOf/anyOf with null)", () => {
      expect(classifyShape({ oneOf: [{ $ref: "#/x" }, { type: "null" }] }, spec)).toBe("nullable");
      expect(classifyShape({ anyOf: [{ $ref: "#/x" }, { type: "null" }] }, spec)).toBe("nullable");
    });
    it("classifies a plain object, and defaults missing schema to object", () => {
      expect(classifyShape({ type: "object" }, spec)).toBe("object");
      expect(classifyShape({ $ref: "#/components/schemas/ProductResponse" }, spec)).toBe("object");
      expect(classifyShape(undefined, spec)).toBe("object");
    });
  });

  describe("collectResponseShapes", () => {
    it("maps each route's 2xx body to its cardinality", () => {
      const spec: OpenApiSpec = {
        paths: {
          "/products": {
            get: {
              responses: {
                "200": {
                  content: { "application/json": { schema: { type: "array", items: {} } } },
                },
              },
            },
            post: {
              responses: {
                "201": {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/ProductResponse" },
                    },
                  },
                },
              },
            },
          },
          "/products/by_sku": {
            get: {
              responses: {
                "200": { content: { "application/json": { schema: { nullable: true } } } },
              },
            },
          },
        },
        components: { schemas: { ProductResponse: { type: "object", properties: { id: {} } } } },
      };
      const shapes = collectResponseShapes(spec);
      expect(shapes.get("GET /products")).toBe("array");
      expect(shapes.get("POST /products")).toBe("object");
      expect(shapes.get("GET /products/by_sku")).toBe("nullable");
    });
  });
});
