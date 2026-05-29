import { describe, expect, it } from "vitest";

import {
  diffSpecs,
  enumValueSets,
  errorResponses,
  isCleanDiff,
  type OpenApiSpec,
  responseBodySchemas,
  schemaNames,
} from "./openapi-normalize.js";

// Coverage for the behavioural-equivalence dimensions added when the
// parity gate moved from structural 1:1 to "idiomatic per backend,
// behaviourally equal".  Each block isolates one relaxation / addition.

describe("openapi-normalize — behavioural equivalence", () => {
  // A backend (Hono/Phoenix) that names its list response as a component
  // `{type: array, items: $ref}` must compare equal to one (.NET) that
  // inlines `array<element>` at the operation.
  // TEMPORARY DROP-IN TOLERANCE (#705): once .NET emits the named wrapper
  // these assertions flip to "exact name comparison; inline-array drifts".
  describe("list-wrapper resolution", () => {
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

    it("resolves a named array-wrapper $ref to array<element>", () => {
      expect(responseBodySchemas(named).get("GET /projects")).toBe("array<ProjectResponse>");
      expect(responseBodySchemas(inlined).get("GET /projects")).toBe("array<ProjectResponse>");
    });

    it("excludes the list-wrapper component from schemaNames", () => {
      expect(schemaNames(named).has("ProjectListResponse")).toBe(false);
      expect(schemaNames(named).has("ProjectResponse")).toBe(true);
    });

    it("named-wrapper and inline-array specs are a clean diff", () => {
      const diff = diffSpecs({ name: "hono", spec: named }, { name: "dotnet", spec: inlined });
      expect(diff.responseBodyDiffs).toEqual([]);
      expect(diff.onlySchemasRef).toEqual([]);
      expect(diff.onlySchemasOther).toEqual([]);
      expect(isCleanDiff(diff)).toBe(true);
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
        diffSpecs({ name: "hono", spec: both }, { name: "dotnet", spec: missing }).errorResponseDiffs
          .length,
      ).toBe(1);
      expect(
        diffSpecs({ name: "hono", spec: both }, { name: "dotnet", spec: both }).errorResponseDiffs,
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
