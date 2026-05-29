import { describe, expect, it } from "vitest";

import {
  diffSpecs,
  enumValueSets,
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

  // TEMPORARY DROP-IN TOLERANCE (#706): once Hono + Phoenix emit the shared
  // RFC 7807 `ProblemDetails` body, this flips to "ProblemDetails IS part of
  // the compared schema set" and only ValidationProblemDetails / the TS-only
  // ProvenanceLineage stay filtered.
  describe("idiomatic schema filtering", () => {
    const spec: OpenApiSpec = {
      components: {
        schemas: {
          ProjectResponse: { type: "object", properties: { id: {} } },
          ErrorResponse: { type: "object", properties: { error: {} } },
          ProvenanceLineage: { type: "object", properties: { snapshotId: {} } },
          ProblemDetails: { type: "object", properties: {} },
        },
      },
    };
    it("drops ErrorResponse / ProvenanceLineage / ProblemDetails", () => {
      const names = schemaNames(spec);
      expect(names.has("ErrorResponse")).toBe(false);
      expect(names.has("ProvenanceLineage")).toBe(false);
      expect(names.has("ProblemDetails")).toBe(false);
      expect(names.has("ProjectResponse")).toBe(true);
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
