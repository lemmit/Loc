import { describe, expect, it } from "vitest";

import {
  diffSpecs,
  enumValueSets,
  isCleanDiff,
  type OpenApiSpec,
  responseBodySchemas,
  schemaNames,
} from "./openapi-normalize.js";

// Coverage for the structural drop-in dimensions: the wire surface is
// byte-identical across backends, so the gate compares names exactly and
// only genuinely-shared components count.  Each block isolates one rule.

describe("openapi-normalize — structural drop-in surface", () => {
  // Under drop-in replacement every backend emits the SAME named list
  // wrapper (`ProjectListResponse`); the gate compares the component name
  // exactly, and a backend that inlines `array<element>` instead drifts.
  describe("named list wrappers", () => {
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

    it("a named wrapper $ref reports the component name; an inline array reports array<element>", () => {
      expect(responseBodySchemas(named).get("GET /projects")).toBe("ProjectListResponse");
      expect(responseBodySchemas(inlined).get("GET /projects")).toBe("array<ProjectResponse>");
    });

    it("the list-wrapper component is part of the compared schema set", () => {
      expect(schemaNames(named).has("ProjectListResponse")).toBe(true);
      expect(schemaNames(named).has("ProjectResponse")).toBe(true);
    });

    it("named-wrapper vs inline-array is a DROP-IN BREAK (response-body + schema drift)", () => {
      const diff = diffSpecs({ name: "hono", spec: named }, { name: "dotnet", spec: inlined });
      expect(diff.responseBodyDiffs.length).toBe(1);
      expect(diff.onlySchemasRef).toEqual(["ProjectListResponse"]);
      expect(isCleanDiff(diff)).toBe(false);
    });

    it("two backends that BOTH name the wrapper are clean", () => {
      const diff = diffSpecs({ name: "hono", spec: named }, { name: "phoenix", spec: named });
      expect(diff.responseBodyDiffs).toEqual([]);
      expect(diff.onlySchemasRef).toEqual([]);
      expect(diff.onlySchemasOther).toEqual([]);
      expect(isCleanDiff(diff)).toBe(true);
    });
  });

  describe("non-contract schema filtering", () => {
    const spec: OpenApiSpec = {
      components: {
        schemas: {
          ProjectResponse: { type: "object", properties: { id: {} } },
          ProvenanceLineage: { type: "object", properties: { snapshotId: {} } },
          ValidationProblemDetails: { type: "object", properties: {} },
        },
      },
    };
    it("drops the TS-only ProvenanceLineage and .NET-only validation envelope, keeps the rest", () => {
      const names = schemaNames(spec);
      expect(names.has("ProvenanceLineage")).toBe(false);
      expect(names.has("ValidationProblemDetails")).toBe(false);
      expect(names.has("ProjectResponse")).toBe(true);
    });
    it("the shared RFC 7807 ProblemDetails body IS part of the compared set", () => {
      const withProblem: OpenApiSpec = {
        components: { schemas: { ProblemDetails: { type: "object", properties: {} } } },
      };
      expect(schemaNames(withProblem).has("ProblemDetails")).toBe(true);
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
