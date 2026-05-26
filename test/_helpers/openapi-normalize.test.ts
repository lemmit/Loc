import { describe, expect, it } from "vitest";
import {
  classifyShape,
  collectOps,
  collectResponseShapes,
  fieldSet,
  normalisePath,
  type OpenApiSpec,
  requiredSet,
  schemaNames,
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
    it("excludes `<field>_provenance` keys (TS/Hono-only wire extension)", () => {
      const provSpec: OpenApiSpec = {
        components: {
          schemas: {
            OrderResponse: {
              type: "object",
              properties: { id: {}, total: {}, total_provenance: {} },
            },
          },
        },
      };
      expect(fieldSet(provSpec, "OrderResponse")).toEqual(new Set(["id", "total"]));
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

  describe("schemaNames", () => {
    it("returns every component schema by name", () => {
      const spec: OpenApiSpec = {
        components: {
          schemas: {
            ProductResponse: { type: "object" },
            CreateProductRequest: { type: "object" },
            ProductListResponse: { type: "array" },
          },
        },
      };
      const names = schemaNames(spec);
      expect(names).toEqual(
        new Set(["ProductResponse", "CreateProductRequest", "ProductListResponse"]),
      );
    });

    it("filters framework-emitted noise (Swashbuckle error envelopes)", () => {
      // .NET (Swashbuckle) emits a `ProblemDetails` schema even when no
      // application code references it.  The other two backends don't.
      // Filtering here keeps the parity diff focused on app-authored
      // contracts instead of framework boilerplate.
      const spec: OpenApiSpec = {
        components: {
          schemas: {
            ProductResponse: { type: "object" },
            ProblemDetails: { type: "object" },
            ValidationProblemDetails: { type: "object" },
            HttpValidationProblemDetails: { type: "object" },
          },
        },
      };
      expect(schemaNames(spec)).toEqual(new Set(["ProductResponse"]));
    });

    it("returns empty set when no schemas declared", () => {
      expect(schemaNames({} as OpenApiSpec)).toEqual(new Set());
      expect(schemaNames({ components: {} } as OpenApiSpec)).toEqual(new Set());
    });
  });

  describe("requiredSet", () => {
    it("returns the required-field list as a Set", () => {
      const spec: OpenApiSpec = {
        components: {
          schemas: {
            CreateProductRequest: {
              type: "object",
              properties: { name: {}, sku: {}, description: {} },
              // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
              required: ["name", "sku"],
            } as any,
          },
        },
      };
      expect(requiredSet(spec, "CreateProductRequest")).toEqual(new Set(["name", "sku"]));
    });

    it("strips `_provenance` co-located fields (TS-only wire extension)", () => {
      const spec: OpenApiSpec = {
        components: {
          schemas: {
            ProductResponse: {
              type: "object",
              // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
              required: ["id", "name", "name_provenance"],
            } as any,
          },
        },
      };
      // `_provenance` companion fields are filtered the same way fieldSet
      // filters them — TS persists lineage, the others don't, so they
      // shouldn't surface as a required-set divergence.
      expect(requiredSet(spec, "ProductResponse")).toEqual(new Set(["id", "name"]));
    });

    it("returns empty set when schema has no required clause", () => {
      const spec: OpenApiSpec = {
        components: { schemas: { ProductResponse: { type: "object" } } },
      };
      expect(requiredSet(spec, "ProductResponse")).toEqual(new Set());
      expect(requiredSet(spec, "Nonexistent")).toEqual(new Set());
    });
  });
});
