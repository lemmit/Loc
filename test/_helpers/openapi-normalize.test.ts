import { describe, expect, it } from "vitest";
import {
  classifyShape,
  collectOps,
  collectResponseShapes,
  diffSpecs,
  fieldSet,
  isCleanDiff,
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

  // ---------------------------------------------------------------------
  // diffSpecs — the cross-backend comparator the e2e parity test uses.
  // ---------------------------------------------------------------------

  describe("diffSpecs + isCleanDiff", () => {
    // Minimal but representative spec: one CRUD op, one custom op, two
    // schemas (response + request).  Each test mutates a copy to inject
    // one specific divergence so the per-dimension assertion isolates.
    const baseSpec = (): OpenApiSpec => ({
      paths: {
        "/products": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                  },
                },
              },
            },
          },
          post: {
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Product" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Product: {
            type: "object",
            properties: { id: {}, name: {}, sku: {} },
            // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
            required: ["id", "name"],
          } as any,
          CreateProductRequest: {
            type: "object",
            properties: { name: {}, sku: {} },
            // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
            required: ["name"],
          } as any,
        },
      },
    });

    it("returns an all-empty diff when the two specs agree", () => {
      const diff = diffSpecs(
        { name: "ref", spec: baseSpec() },
        { name: "other", spec: baseSpec() },
      );
      expect(diff.onlyRef).toEqual([]);
      expect(diff.onlyOther).toEqual([]);
      expect(diff.cardMismatches).toEqual([]);
      expect(diff.onlySchemasRef).toEqual([]);
      expect(diff.onlySchemasOther).toEqual([]);
      expect(diff.fieldDiffs).toEqual([]);
      expect(diff.requiredDiffs).toEqual([]);
      expect(isCleanDiff(diff)).toBe(true);
    });

    it("flags an op present only on the reference side", () => {
      const other = baseSpec();
      delete other.paths!["/products"]!.get;
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.onlyRef).toEqual(["GET /products"]);
      expect(diff.onlyOther).toEqual([]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("flags an op present only on the other side", () => {
      const other = baseSpec();
      other.paths!["/products/{id}"] = {
        delete: {
          responses: {
            "204": { content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      };
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.onlyRef).toEqual([]);
      expect(diff.onlyOther).toEqual(["DELETE /products/{id}"]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("flags response-cardinality drift on the same op", () => {
      const other = baseSpec();
      // Other backend returns the array as an object wrapper instead.
      other.paths!["/products"]!.get = {
        responses: {
          "200": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Product" } },
            },
          },
        },
      };
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.cardMismatches).toEqual(["GET /products: ref=array, other=object"]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("flags schemas declared on only one side", () => {
      const other = baseSpec();
      delete other.components!.schemas!.CreateProductRequest;
      other.components!.schemas!.OtherOnlySchema = { type: "object" };
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.onlySchemasRef).toEqual(["CreateProductRequest"]);
      expect(diff.onlySchemasOther).toEqual(["OtherOnlySchema"]);
      // Field/required diffs only run on the schema intersection, so a
      // missing schema doesn't double-count.
      expect(diff.fieldDiffs).toEqual([]);
      expect(diff.requiredDiffs).toEqual([]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("flags property-name drift on a shared schema (the casing case the parity series fixed)", () => {
      const other = baseSpec();
      // Phoenix-style snake_case vs the camelCase Hono / .NET serve.
      other.components!.schemas!.Product = {
        type: "object",
        properties: { id: {}, name: {}, sku_alt: {} },
        // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
        required: ["id", "name"],
      } as any;
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.fieldDiffs).toEqual(["Product: only-ref=[sku] only-other=[sku_alt]"]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("flags required-set drift on the property intersection only", () => {
      const other = baseSpec();
      // Same properties; one side flips `sku` to required.
      other.components!.schemas!.Product = {
        type: "object",
        properties: { id: {}, name: {}, sku: {} },
        // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
        required: ["id", "name", "sku"],
      } as any;
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.requiredDiffs).toEqual([
        "Product: required-only-ref=[] required-only-other=[sku]",
      ]);
      // Property names match; the field-set diff stays empty.
      expect(diff.fieldDiffs).toEqual([]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("does NOT double-count a required-only field as also field-missing", () => {
      // Property `extra` only exists on `other` — fieldDiffs catches it,
      // requiredDiffs filters it out via the intersection.
      const other = baseSpec();
      other.components!.schemas!.Product = {
        type: "object",
        properties: { id: {}, name: {}, sku: {}, extra: {} },
        // biome-ignore lint/suspicious/noExplicitAny: test-only spec literal
        required: ["id", "name", "extra"],
      } as any;
      const diff = diffSpecs({ name: "ref", spec: baseSpec() }, { name: "other", spec: other });
      expect(diff.fieldDiffs).toEqual(["Product: only-ref=[] only-other=[extra]"]);
      // `extra` filtered out of the required diff (not in ref's properties);
      // the intersection's required sets agree.
      expect(diff.requiredDiffs).toEqual([]);
    });

    it("preserves ref/other names in divergence strings (for human-readable logging)", () => {
      const other = baseSpec();
      other.components!.schemas!.Product = {
        type: "object",
        properties: { id: {}, name: {}, sku_alt: {} },
      } as OpenApiSpec["components"] extends infer C
        ? C extends { schemas?: infer S }
          ? S extends Record<string, infer V>
            ? V
            : never
          : never
        : never;
      const diff = diffSpecs({ name: "hono", spec: baseSpec() }, { name: "phoenix", spec: other });
      // The names should appear verbatim in the human-readable diff line.
      expect(diff.fieldDiffs[0]).toContain("only-hono=");
      expect(diff.fieldDiffs[0]).toContain("only-phoenix=");
    });
  });
});
