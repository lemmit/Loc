// .NET backend — validation-error extension emission (Phase B of
// docs/old/proposals/validation-error-extension.md).
//
// Activates the dormant `applied` path in the frontend ACL for the .NET
// backend.  When a FluentValidation rule fails, the DomainExceptionFilter
// now emits a 422 ProblemDetails with the RFC 7807 §3.2 `errors[]`
// extension shape that `applyServerErrors` consumes.  Same wire body as
// Hono's defaultHook (shipped #782), so the frontend ACL works against
// either backend without per-target code.
//
// What this protects:
//  - The FluentValidation arm of DomainExceptionFilter emits 422
//    (not 400) ProblemDetails with `Extensions["errors"]` carrying
//    `{ pointer, message }` per FV issue.
//  - The PointerOf static helper converts FluentValidation property
//    paths (e.g. `Price.Amount`, `Items[0].Qty`) to RFC 6901 JSON
//    pointers matching the wire shape the frontend expects.
//  - The PascalCase → camelCase conversion (matching the app's
//    JsonNamingPolicy.CamelCase) so pointers align with the wire body.
//  - Array indexer notation (`Items[0]`) converts to a numeric path
//    segment.
//  - RFC 6901 segment escapes (`~` → `~0`, `/` → `~1`) are applied.
//  - The using directives needed for the helper (System.Collections.Generic,
//    System.Linq, System.Text.Json) are emitted when usesValidators.
//
// What is intentionally NOT asserted (Phase D — deferred until all
// three backends declare 422 in lockstep via the central matrix in
// src/ir/util/openapi-errors.ts):
//  - The 422 HTTP code on OpenAPI route response declarations.
//  - The `errors[]` extension as a declared field on the OpenAPI
//    `ProblemDetails` component schema.
//
// The cross-backend parity gate (`test/_helpers/openapi-normalize.ts`)
// keeps `fieldSet("ProblemDetails")` + per-operation `errorResponses()`
// byte-equal across all three backends.  The runtime body Hono and
// .NET emit is more specific than their OpenAPI schemas admit; the
// frontend ACL reads the body directly.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

async function buildModel(file: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe(".NET validation-error extension — DomainExceptionFilter emission", () => {
  it('FluentValidation arm emits 422 ProblemDetails with Extensions["errors"]', async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    // Catches FluentValidation.ValidationException.
    expect(filter).toMatch(/is FluentValidation\.ValidationException fv/);
    // RFC 7807 body — base shape lifted into a ProblemDetails instance.
    expect(filter).toMatch(/var problem = new ProblemDetails/);
    expect(filter).toMatch(/Type = "about:blank"/);
    expect(filter).toMatch(/Title = "Validation failed"/);
    expect(filter).toMatch(/Status = 422/);
    expect(filter).toMatch(/Detail = "One or more fields are invalid\."/);
    expect(filter).toMatch(/Instance = context\.HttpContext\.Request\.Path/);
    // §3.2 errors[] extension lives on Extensions["errors"] — the
    // ProblemDetails component schema isn't yet declared with `errors`
    // (Phase D), so the array rides as a JSON extension key.
    expect(filter).toMatch(/problem\.Extensions\["errors"\] = fv\.Errors/);
    // Each error is a Dictionary so the optional `code` key is OMITTED for a
    // message-less rule (byte-identical body) and PRESENT for a messaged rule
    // whose `.WithErrorCode("msg.<hash>")` surfaces the content-hash wire code.
    expect(filter).toMatch(/\["pointer"\] = PointerOf\(e\.PropertyName\)/);
    expect(filter).toMatch(/\["message"\] = e\.ErrorMessage/);
    expect(filter).toMatch(/e\.ErrorCode\.StartsWith\("msg\.", StringComparison\.Ordinal\)/);
    expect(filter).toMatch(/err\["code"\] = e\.ErrorCode/);
    expect(filter).toMatch(/\.ToArray\(\)/);
    // Response shape: 422 + application/problem+json + x-request-id.
    expect(filter).toMatch(/x-request-id"\] = trace_id/);
    expect(filter).toMatch(/StatusCode = 422/);
    expect(filter).toMatch(/ContentTypes = \{ "application\/problem\+json" \}/);
    // No survivors of the old { error, trace_id, failures } envelope.
    expect(filter).not.toMatch(/failures = fv\.Errors/);
    expect(filter).not.toMatch(/BadRequestObjectResult\(new\s*\{\s*error = "Validation failed"/);
  });

  it("PointerOf helper converts FluentValidation paths to RFC 6901 JSON pointers", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/private static string PointerOf\(string propertyName\)/);
    // Empty input → empty pointer (the whole document, per RFC 6901).
    expect(filter).toMatch(/if \(string\.IsNullOrEmpty\(propertyName\)\) return "";/);
    // Walk segments split on `.` — the FluentValidation path notation.
    expect(filter).toMatch(/propertyName\.Split\('\.'\)/);
    // PascalCase → camelCase to match JsonNamingPolicy.CamelCase wire shape.
    expect(filter).toMatch(/JsonNamingPolicy\.CamelCase\.ConvertName/);
    // Array indexer parsing — `Items[0]` → "items" then "0" as separate segments.
    expect(filter).toMatch(/IndexOf\('\['/);
    expect(filter).toMatch(/IndexOf\(']'/);
    // RFC 6901 segment escapes — `~` → `~0`, `/` → `~1`.
    expect(filter).toMatch(/Replace\("~", "~0"\)/);
    expect(filter).toMatch(/Replace\("\/", "~1"\)/);
    // Output shape: "/" + slash-joined escaped segments.
    expect(filter).toMatch(/return "\/" \+ string\.Join\("\/"/);
  });

  it("emits the using directives the helper needs when validators are present", async () => {
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).toMatch(/using System\.Collections\.Generic;/);
    expect(filter).toMatch(/using System\.Linq;/);
    expect(filter).toMatch(/using System\.Text\.Json;/);
  });

  it("does NOT emit the helper or extra usings when no validators are needed", async () => {
    // Plain aggregate with no wire-translatable invariants → no
    // FluentValidation pipeline → no PointerOf helper → no
    // System.Linq / System.Text.Json / System.Collections.Generic usings.
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(
      `
        context Plain {
          aggregate Note {
            title: string
            derived display: string = title
            body:  string
          }
          repository Notes for Note { }
        }
      `,
      { validation: true },
    );
    const files = generateDotnet(doc.parseResult.value as Model);
    const filter = files.get("Api/DomainExceptionFilter.cs")!;
    expect(filter).not.toMatch(/PointerOf/);
    expect(filter).not.toMatch(/is FluentValidation\.ValidationException/);
    expect(filter).not.toMatch(/using System\.Collections\.Generic;/);
    expect(filter).not.toMatch(/using System\.Linq;/);
    expect(filter).not.toMatch(/using System\.Text\.Json;/);
  });

  it("OpenAPI route declarations carry [ProducesResponseType(typeof(ProblemDetails), 422)]", async () => {
    // Phase D shipped: all three backends declare 422 in lockstep via
    // the central matrix in src/ir/util/openapi-errors.ts.  .NET
    // controllers' create / operation / workflow actions carry
    // [ProducesResponseType(typeof(ProblemDetails), 422)] alongside the
    // existing 400 attribute.  See docs/old/proposals/validation-error-extension.md.
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const controllerKey = [...files.keys()].find(
      (k) => k.endsWith("Controller.cs") && !k.endsWith("DomainExceptionFilter.cs"),
    );
    expect(controllerKey, "expected at least one Controller.cs").toBeDefined();
    const controller = files.get(controllerKey!)!;
    expect(controller).toMatch(/ProducesResponseType\(typeof\(ProblemDetails\), 422\)/);
  });

  it("ProblemDetailsResponsesFilter augments the OpenAPI schema with the errors[] extension", async () => {
    // The Microsoft.AspNetCore.Mvc.ProblemDetails OpenAPI schema is
    // auto-generated by Swashbuckle from the C# type.  Phase D extends
    // the existing ProblemDetailsResponsesFilter to amend the schema
    // declaration with the §3.2 `errors[]` array (per-field
    // `{ pointer, message }`) the runtime FluentValidation arm emits,
    // so the published OpenAPI contract matches the actual wire body.
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    const filter = files.get("Api/ProblemDetailsResponsesFilter.cs")!;
    expect(filter).toMatch(/AugmentProblemDetailsSchema/);
    // The augmentation runs on the SchemaRepository so it's idempotent
    // across operations and survives Swashbuckle's $ref deduplication.
    expect(filter).toMatch(/repo\.Schemas\.TryGetValue\("ProblemDetails", out var problemSchema\)/);
    expect(filter).toMatch(/problem\.Properties\.ContainsKey\("errors"\)/);
    expect(filter).toMatch(/problem\.Properties\["errors"\] = new OpenApiSchema/);
    // Array of { pointer, message } — the locked frontend-ACL wire shape.
    // Microsoft.OpenApi 2.0: schema type is the JsonSchemaType flags enum
    // (the null flag serializes back to `nullable: true` in the 3.0 writer).
    expect(filter).toMatch(/Type = JsonSchemaType\.Array \| JsonSchemaType\.Null/);
    expect(filter).toMatch(/Required = new HashSet<string> \{ "pointer", "message" \}/);
    expect(filter).toMatch(/\["pointer"\] = new OpenApiSchema \{ Type = JsonSchemaType\.String \}/);
    expect(filter).toMatch(/\["message"\] = new OpenApiSchema \{ Type = JsonSchemaType\.String \}/);
    // Imports the namespace it now needs (Phase D-specific).
    expect(filter).toMatch(/using System\.Collections\.Generic;/);
    expect(filter).toMatch(/using Microsoft\.OpenApi;/);
  });
});
