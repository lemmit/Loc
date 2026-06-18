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
  operationIds,
  pathParamSignatures,
  requestBodySchemas,
  requiredSet,
  responseBodySchemas,
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
    it("strips the universal /api base so prefix representations collapse", () => {
      // hono/dotnet/java/python embed /api in the path; phoenix renders it
      // scope-relative.  Both must compare equal for op-set parity.
      expect(normalisePath("/api/builds")).toBe("/builds");
      expect(normalisePath("/api/builds/{id}")).toBe("/builds/{id}");
      expect(normalisePath("/api")).toBe("/");
      // …but only as a whole leading segment — `/apiKeys` is untouched.
      expect(normalisePath("/apiKeys")).toBe("/apiKeys");
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

    it("keeps the shared RFC 7807 ProblemDetails, filters .NET-only validation envelopes", () => {
      // The shared `ProblemDetails` error body is part of the compared
      // contract (#706) — all three backends publish it.  Swashbuckle's
      // model-state validation envelopes (`ValidationProblemDetails` /
      // `HttpValidationProblemDetails`) are .NET-only and stay filtered.
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
      expect(schemaNames(spec)).toEqual(new Set(["ProductResponse", "ProblemDetails"]));
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
              required: ["name", "sku"],
            },
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
              required: ["id", "name", "name_provenance"],
            },
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
            required: ["id", "name"],
          },
          CreateProductRequest: {
            type: "object",
            properties: { name: {}, sku: {} },
            required: ["name"],
          },
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
      expect(diff.paramTypeDiffs).toEqual([]);
      expect(diff.requestBodyDiffs).toEqual([]);
      expect(diff.responseBodyDiffs).toEqual([]);
      expect(diff.operationIdDiffs).toEqual([]);
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
        required: ["id", "name"],
      };
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
        required: ["id", "name", "sku"],
      };
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
        required: ["id", "name", "extra"],
      };
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

  // ---------------------------------------------------------------------
  // pathParamSignatures + paramTypeDiffs dimension
  // ---------------------------------------------------------------------

  describe("pathParamSignatures + paramTypeDiffs", () => {
    const withIdParam = (paramSchema: { type?: string; format?: string }): OpenApiSpec => ({
      paths: {
        "/products/{id}": {
          get: {
            parameters: [{ in: "path", name: "id", schema: paramSchema }],
            responses: {
              "200": {
                content: {
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          },
        },
      },
    });

    it("captures the type + format of a path parameter", () => {
      const sigs = pathParamSignatures(withIdParam({ type: "string", format: "uuid" }));
      expect(sigs.get("GET /products/{id}")).toBe("string:uuid");
    });

    it("captures type-only when no format declared", () => {
      const sigs = pathParamSignatures(withIdParam({ type: "string" }));
      expect(sigs.get("GET /products/{id}")).toBe("string");
    });

    it("emits an empty signature for ops with no path params", () => {
      const spec: OpenApiSpec = {
        paths: {
          "/products": {
            get: {
              responses: { "200": { content: { "application/json": { schema: {} } } } },
            },
          },
        },
      };
      expect(pathParamSignatures(spec).get("GET /products")).toBe("");
    });

    it("ignores query / header parameters (in != 'path')", () => {
      const spec: OpenApiSpec = {
        paths: {
          "/products/{id}": {
            get: {
              parameters: [
                { in: "path", name: "id", schema: { type: "string", format: "uuid" } },
                { in: "query", name: "limit", schema: { type: "integer" } },
                { in: "header", name: "x-trace-id", schema: { type: "string" } },
              ],
              responses: { "200": { content: { "application/json": { schema: {} } } } },
            },
          },
        },
      };
      // Only the path param ends up in the signature.
      expect(pathParamSignatures(spec).get("GET /products/{id}")).toBe("string:uuid");
    });

    it("uses sorted-name order so backend emission order doesn't trip the diff", () => {
      // Two path params in different emit orders.  Sorted-name keeps
      // the signature stable.
      const refSpec: OpenApiSpec = {
        paths: {
          "/orders/{orderId}/lines/{lineId}": {
            get: {
              parameters: [
                { in: "path", name: "orderId", schema: { type: "string", format: "uuid" } },
                { in: "path", name: "lineId", schema: { type: "integer" } },
              ],
              responses: { "200": { content: { "application/json": { schema: {} } } } },
            },
          },
        },
      };
      const otherSpec: OpenApiSpec = {
        paths: {
          "/orders/{orderId}/lines/{lineId}": {
            get: {
              parameters: [
                { in: "path", name: "lineId", schema: { type: "integer" } },
                { in: "path", name: "orderId", schema: { type: "string", format: "uuid" } },
              ],
              responses: { "200": { content: { "application/json": { schema: {} } } } },
            },
          },
        },
      };
      const refSigs = pathParamSignatures(refSpec);
      const otherSigs = pathParamSignatures(otherSpec);
      // normalisePath collapses {orderId} / {lineId} to {id} both times,
      // so the keys agree.  Signatures match by sorted name.
      const key = "GET /orders/{id}/lines/{id}";
      expect(refSigs.get(key)).toBe(otherSigs.get(key));
    });

    it("diffSpecs flags path-param TYPE drift on the op intersection", () => {
      const ref: OpenApiSpec = withIdParam({ type: "string", format: "uuid" });
      const other: OpenApiSpec = withIdParam({ type: "string" }); // Phoenix's current shape
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "phoenix", spec: other });
      expect(diff.paramTypeDiffs).toEqual([
        "GET /products/{id}: hono=[string:uuid], phoenix=[string]",
      ]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("diffSpecs paramTypeDiffs is empty when shapes agree", () => {
      const ref: OpenApiSpec = withIdParam({ type: "string", format: "uuid" });
      const other: OpenApiSpec = withIdParam({ type: "string", format: "uuid" });
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.paramTypeDiffs).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // requestBodySchemas + responseBodySchemas + per-op schema-ref diffs
  // ---------------------------------------------------------------------

  describe("requestBodySchemas + responseBodySchemas", () => {
    const opWithBodies = (
      requestRef: string | null,
      responseRef: string | null,
      responseArray = false,
    ): OpenApiSpec => ({
      paths: {
        "/products": {
          post: {
            ...(requestRef
              ? {
                  requestBody: {
                    content: {
                      "application/json": {
                        schema: { $ref: `#/components/schemas/${requestRef}` },
                      },
                    },
                  },
                }
              : {}),
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: responseArray
                      ? {
                          type: "array",
                          items: {
                            $ref: `#/components/schemas/${responseRef ?? "Anonymous"}`,
                          },
                        }
                      : responseRef
                        ? { $ref: `#/components/schemas/${responseRef}` }
                        : { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });

    it("requestBodySchemas extracts the component name from $ref", () => {
      const refs = requestBodySchemas(opWithBodies("CreateProductRequest", null));
      expect(refs.get("POST /products")).toBe("CreateProductRequest");
    });

    it("requestBodySchemas returns empty string when no body", () => {
      const refs = requestBodySchemas(opWithBodies(null, null));
      expect(refs.get("POST /products")).toBe("");
    });

    it("responseBodySchemas annotates array wrappers", () => {
      const refs = responseBodySchemas(opWithBodies(null, "ProductResponse", true));
      expect(refs.get("POST /products")).toBe("array<ProductResponse>");
    });

    it("responseBodySchemas extracts singular component refs", () => {
      const refs = responseBodySchemas(opWithBodies(null, "ProductResponse", false));
      expect(refs.get("POST /products")).toBe("ProductResponse");
    });

    it("responseBodySchemas returns empty string for inline schemas", () => {
      const refs = responseBodySchemas(opWithBodies(null, null, false));
      expect(refs.get("POST /products")).toBe("");
    });

    it("diffSpecs flags request-body schema-ref drift", () => {
      const ref = opWithBodies("CreateProductRequest", "ProductResponse");
      const other = opWithBodies("UpdateProductRequest", "ProductResponse");
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.requestBodyDiffs).toEqual([
        "POST /products: hono=CreateProductRequest, dotnet=UpdateProductRequest",
      ]);
      expect(diff.responseBodyDiffs).toEqual([]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("diffSpecs flags response-body schema-ref drift (same cardinality, different element)", () => {
      // Both backends return an array — cardMismatches stays clean —
      // but the element schemas differ.  Without responseBodyDiffs
      // this would be invisible.
      const ref = opWithBodies(null, "ProductResponse", true);
      const other = opWithBodies(null, "ProductListItem", true);
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.cardMismatches).toEqual([]);
      expect(diff.responseBodyDiffs).toEqual([
        "POST /products: hono=array<ProductResponse>, dotnet=array<ProductListItem>",
      ]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("diffSpecs request/response diffs are empty when refs match", () => {
      const ref = opWithBodies("CreateProductRequest", "ProductResponse", true);
      const other = opWithBodies("CreateProductRequest", "ProductResponse", true);
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.requestBodyDiffs).toEqual([]);
      expect(diff.responseBodyDiffs).toEqual([]);
    });

    it("diffSpecs surfaces (none) when one side has a body and the other doesn't", () => {
      const ref = opWithBodies("CreateProductRequest", null);
      const other = opWithBodies(null, null);
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.requestBodyDiffs).toEqual([
        "POST /products: hono=CreateProductRequest, dotnet=(none)",
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // operationIds + operationIdDiffs dimension
  // ---------------------------------------------------------------------

  describe("operationIds + operationIdDiffs", () => {
    const opWithId = (id: string | undefined): OpenApiSpec => ({
      paths: {
        "/products": {
          get: {
            ...(id !== undefined ? { operationId: id } : {}),
            responses: { "200": { content: { "application/json": { schema: {} } } } },
          },
        },
      },
    });

    it("operationIds extracts the declared id per op", () => {
      const ids = operationIds(opWithId("listProducts"));
      expect(ids.get("GET /products")).toBe("listProducts");
    });

    it("operationIds returns empty string when op omits operationId", () => {
      const ids = operationIds(opWithId(undefined));
      expect(ids.get("GET /products")).toBe("");
    });

    it("operationIds skips infra paths (/health, /openapi.json, /swagger)", () => {
      const spec: OpenApiSpec = {
        paths: {
          "/health": { get: { operationId: "healthcheck" } },
          "/products": { get: { operationId: "listProducts" } },
        },
      };
      const ids = operationIds(spec);
      expect(ids.has("GET /health")).toBe(false);
      expect(ids.get("GET /products")).toBe("listProducts");
    });

    it("diffSpecs flags operationId drift between backends", () => {
      const ref = opWithId("listProducts");
      const other = opWithId("getAllProducts");
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.operationIdDiffs).toEqual([
        "GET /products: hono=listProducts, dotnet=getAllProducts",
      ]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("diffSpecs surfaces (none) when one side omits operationId", () => {
      const ref = opWithId("listProducts");
      const other = opWithId(undefined);
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.operationIdDiffs).toEqual(["GET /products: hono=listProducts, dotnet=(none)"]);
    });

    it("diffSpecs operationIdDiffs is empty when ids match", () => {
      const ref = opWithId("listProducts");
      const other = opWithId("listProducts");
      const diff = diffSpecs({ name: "hono", spec: ref }, { name: "dotnet", spec: other });
      expect(diff.operationIdDiffs).toEqual([]);
    });
  });
});
