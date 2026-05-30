import { describe, expect, it } from "vitest";

import {
  diffSpecs,
  enumValueSets,
  errorResponses,
  isCleanDiff,
  type OpenApiSpec,
  propertyFormats,
  propertyTypes,
  queryParamSignatures,
  responseBodySchemas,
  schemaNames,
} from "./openapi-normalize.js";

// Coverage for the behavioural-equivalence dimensions added when the
// parity gate moved from structural 1:1 to "idiomatic per backend,
// behaviourally equal".  Each block isolates one relaxation / addition.

describe("openapi-normalize — behavioural equivalence", () => {
  // All three backends now name the list response as a component
  // (`ProjectListResponse`) — .NET via the ListResponseWrapperFilter (#705).
  // The wrapper is compared by NAME (the tolerance that resolved it to an
  // inline `array<element>` is gone): named-vs-named is clean; a
  // hypothetical inline-array backend now drifts.
  describe("list-wrapper naming", () => {
    const named: OpenApiSpec = {
      paths: {
        "/projects": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/ProjectListResponse" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ProjectResponse: { type: "object", properties: { id: {} } },
          ProjectListResponse: {
            type: "array",
            items: { $ref: "#/components/schemas/ProjectResponse" },
          },
        },
      },
    };
    const inlined: OpenApiSpec = {
      paths: {
        "/projects": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { $ref: "#/components/schemas/ProjectResponse" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { ProjectResponse: { type: "object", properties: { id: {} } } } },
    };

    it("compares a named array-wrapper $ref by name; inline array stays array<element>", () => {
      expect(responseBodySchemas(named).get("GET /projects")).toBe("ProjectListResponse");
      expect(responseBodySchemas(inlined).get("GET /projects")).toBe("array<ProjectResponse>");
    });

    it("includes the list-wrapper component in schemaNames", () => {
      expect(schemaNames(named).has("ProjectListResponse")).toBe(true);
      expect(schemaNames(named).has("ProjectResponse")).toBe(true);
    });

    it("two named-wrapper specs are clean; named-vs-inline now drifts", () => {
      const clean = diffSpecs({ name: "hono", spec: named }, { name: "dotnet", spec: named });
      expect(isCleanDiff(clean)).toBe(true);

      const drift = diffSpecs({ name: "hono", spec: named }, { name: "dotnet", spec: inlined });
      // The wrapper schema is one-sided + the response body refs differ.
      expect(drift.onlySchemasRef).toEqual(["ProjectListResponse"]);
      expect(drift.responseBodyDiffs.length).toBe(1);
      expect(isCleanDiff(drift)).toBe(false);
    });
  });

  // The shared RFC 7807 `ProblemDetails` body is compared (#706); only the
  // .NET-only validation envelopes and the TS-only provenance lineage stay
  // filtered.
  describe("schema filtering", () => {
    const spec: OpenApiSpec = {
      components: {
        schemas: {
          ProjectResponse: { type: "object", properties: { id: {} } },
          ProblemDetails: { type: "object", properties: {} },
          ValidationProblemDetails: { type: "object", properties: {} },
          ProvenanceLineage: { type: "object", properties: { snapshotId: {} } },
        },
      },
    };
    it("keeps ProblemDetails + ProjectResponse, drops ValidationProblemDetails / ProvenanceLineage", () => {
      const names = schemaNames(spec);
      expect(names.has("ProblemDetails")).toBe(true);
      expect(names.has("ProjectResponse")).toBe(true);
      expect(names.has("ValidationProblemDetails")).toBe(false);
      expect(names.has("ProvenanceLineage")).toBe(false);
    });
  });

  // RFC 7807 error responses (#706): each operation declares the same
  // 4xx/5xx set, each carrying ProblemDetails under application/problem+json.
  describe("error responses", () => {
    const op = (errors: Record<string, string>): OpenApiSpec => {
      const responses: Record<string, unknown> = {
        "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/X" } } } },
      };
      for (const [code, ct] of Object.entries(errors)) {
        responses[code] = {
          content: { [ct]: { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
        };
      }
      return { paths: { "/projects": { post: { responses } } } };
    };

    it("extracts the sorted 4xx set under application/problem+json", () => {
      const m = errorResponses(op({ "400": "application/problem+json" }));
      expect(m.get("POST /projects")).toBe("400:ProblemDetails");
    });

    it("an error served as application/json (not problem+json) reads as (none) and drifts", () => {
      const good = op({ "400": "application/problem+json" });
      const wrongCt = op({ "400": "application/json" });
      const diff = diffSpecs({ name: "hono", spec: good }, { name: "phoenix", spec: wrongCt });
      expect(diff.errorResponseDiffs.length).toBe(1);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("a missing error status drifts; identical sets are clean", () => {
      const both = op({ "400": "application/problem+json", "404": "application/problem+json" });
      const missing = op({ "400": "application/problem+json" });
      expect(
        diffSpecs({ name: "hono", spec: both }, { name: "dotnet", spec: missing })
          .errorResponseDiffs.length,
      ).toBe(1);
      expect(
        diffSpecs({ name: "hono", spec: both }, { name: "dotnet", spec: both }).errorResponseDiffs,
      ).toEqual([]);
    });
  });

  // Per-property type drift — closes the same-name-different-type blind spot.
  describe("property types", () => {
    const withProp = (name: string, prop: Record<string, unknown>): OpenApiSpec => ({
      components: {
        schemas: { ProductResponse: { type: "object", properties: { [name]: prop } } },
      },
    });

    it("normalises a scalar property to its JSON type", () => {
      expect(
        propertyTypes(withProp("qty", { type: "integer" }), "ProductResponse").get("qty"),
      ).toBe("integer");
    });

    it("folds nullable union (oneOf with null) to the underlying type", () => {
      const zod = withProp("name", { oneOf: [{ type: "string" }, { type: "null" }] });
      const swashbuckle = withProp("name", { type: "string", nullable: true });
      // Both read as `string` — nullable representation is folded out.
      expect(propertyTypes(zod, "ProductResponse").get("name")).toBe("string");
      expect(propertyTypes(swashbuckle, "ProductResponse").get("name")).toBe("string");
      expect(
        diffSpecs({ name: "hono", spec: zod }, { name: "dotnet", spec: swashbuckle })
          .propertyTypeDiffs,
      ).toEqual([]);
    });

    it("renders arrays + $refs structurally", () => {
      expect(
        propertyTypes(
          withProp("tags", { type: "array", items: { type: "string" } }),
          "ProductResponse",
        ).get("tags"),
      ).toBe("array<string>");
      expect(
        propertyTypes(
          withProp("price", { $ref: "#/components/schemas/Money" }),
          "ProductResponse",
        ).get("price"),
      ).toBe("ref:Money");
    });

    it("flags string-vs-integer drift on a shared property", () => {
      const a = withProp("qty", { type: "string" });
      const b = withProp("qty", { type: "integer" });
      const diff = diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: b });
      expect(diff.propertyTypeDiffs).toEqual(["ProductResponse.qty: hono=string, dotnet=integer"]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("ignores a property missing on one side (caught by fieldDiffs instead)", () => {
      const a = withProp("qty", { type: "integer" });
      const b: OpenApiSpec = {
        components: { schemas: { ProductResponse: { type: "object", properties: {} } } },
      };
      expect(
        diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: b }).propertyTypeDiffs,
      ).toEqual([]);
    });
  });

  // Per-property format drift — conservative: only flags when BOTH sides
  // declare a format and they differ.
  describe("property formats", () => {
    const withProp = (prop: Record<string, unknown>): OpenApiSpec => ({
      components: { schemas: { ProductResponse: { type: "object", properties: { at: prop } } } },
    });

    it("extracts a declared format, folding through a nullable union", () => {
      expect(
        propertyFormats(withProp({ type: "string", format: "date-time" }), "ProductResponse").get(
          "at",
        ),
      ).toBe("date-time");
      const nullable = withProp({
        oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
      });
      expect(propertyFormats(nullable, "ProductResponse").get("at")).toBe("date-time");
    });

    it("flags format drift only when both sides declare one", () => {
      const a = withProp({ type: "string", format: "date-time" });
      const b = withProp({ type: "string", format: "date" });
      const drift = diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: b });
      expect(drift.propertyFormatDiffs).toEqual([
        "ProductResponse.at: hono=date-time, dotnet=date",
      ]);
      expect(isCleanDiff(drift)).toBe(false);
    });

    it("does NOT flag one-sided format (dialect asymmetry)", () => {
      const declared = withProp({ type: "string", format: "uuid" });
      const bare = withProp({ type: "string" });
      expect(
        diffSpecs({ name: "hono", spec: declared }, { name: "phoenix", spec: bare })
          .propertyFormatDiffs,
      ).toEqual([]);
    });
  });

  // Per-op query-parameter drift (the parameterized finds' filters).
  describe("query parameters", () => {
    const find = (
      params: Array<{ name: string; type?: string; required?: boolean }>,
    ): OpenApiSpec => ({
      paths: {
        "/products/by_name": {
          get: {
            parameters: params.map((p) => ({
              in: "query",
              name: p.name,
              required: p.required ?? false,
              schema: { type: p.type ?? "string" },
            })),
            responses: { "200": {} },
          },
        },
      },
    });

    it("captures name:type:req|opt, sorted by name", () => {
      const sig = queryParamSignatures(find([{ name: "name", required: true }]));
      expect(sig.get("GET /products/by_name")).toBe("name:string:req");
    });

    it("flags a query param present on one backend, missing on the other", () => {
      const a = find([{ name: "name", required: true }]);
      const b = find([]);
      const drift = diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: b });
      expect(drift.queryParamDiffs.length).toBe(1);
      expect(isCleanDiff(drift)).toBe(false);
    });

    it("flags type / required drift on a shared query param; identical is clean", () => {
      const a = find([{ name: "name", type: "string", required: true }]);
      const b = find([{ name: "name", type: "integer", required: true }]);
      expect(
        diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: b }).queryParamDiffs.length,
      ).toBe(1);
      expect(
        diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: a }).queryParamDiffs,
      ).toEqual([]);
    });
  });

  describe("enum value-sets", () => {
    const withEnum = (vals: string[]): OpenApiSpec => ({
      components: { schemas: { Visibility: { type: "string", enum: vals } as never } },
    });

    it("extracts and sorts enum value-sets", () => {
      const m = enumValueSets(withEnum(["Public", "Internal", "Private"]));
      expect(m.get("Visibility")).toEqual(["Internal", "Private", "Public"]);
    });

    it("agreeing enums are clean; diverging value-sets drift", () => {
      const a = withEnum(["Private", "Internal", "Public"]);
      const b = withEnum(["Private", "Internal", "Public"]);
      expect(
        diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: b }).enumValueDiffs,
      ).toEqual([]);
      const c = withEnum(["Private", "Public"]);
      const drift = diffSpecs({ name: "hono", spec: a }, { name: "dotnet", spec: c });
      expect(drift.enumValueDiffs.length).toBe(1);
      expect(isCleanDiff(drift)).toBe(false);
    });
  });

  // Drop-in replacement requires byte-identical operationIds across
  // backends — they become client-codegen function names.  The gate is
  // EXACT: identical ids are clean; any casing or token difference drifts.
  describe("operationId exact comparison", () => {
    const op = (id: string): OpenApiSpec => ({
      paths: { "/projects": { post: { operationId: id, responses: { "201": {} } } } },
    });
    it("identical camelCase ids are clean", () => {
      const diff = diffSpecs(
        { name: "hono", spec: op("createProject") },
        { name: "phoenix", spec: op("createProject") },
      );
      expect(diff.operationIdDiffs).toEqual([]);
    });
    it("a casing difference (snake_case vs camelCase) drifts", () => {
      const diff = diffSpecs(
        { name: "hono", spec: op("createProject") },
        { name: "phoenix", spec: op("create_project") },
      );
      expect(diff.operationIdDiffs.length).toBe(1);
    });
    it("a different token sequence drifts", () => {
      const diff = diffSpecs(
        { name: "hono", spec: op("allProject") },
        { name: "phoenix", spec: op("listProject") },
      );
      expect(diff.operationIdDiffs.length).toBe(1);
    });
  });
});
