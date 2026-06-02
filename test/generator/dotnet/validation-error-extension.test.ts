// .NET backend — validation-error extension emission (Phase B of
// docs/proposals/validation-error-extension.md).
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
    expect(filter).toMatch(
      /\.Select\(e => new \{ pointer = PointerOf\(e\.PropertyName\), message = e\.ErrorMessage \}\)/,
    );
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

  it("OpenAPI route declarations do NOT yet carry 422 (parity-deferred until Phase D)", async () => {
    // Phase B intentionally lands the runtime emission only; the central
    // matrix in src/ir/util/openapi-errors.ts is unchanged so the
    // cross-backend OpenAPI parity gate stays green.  This test will
    // be inverted in Phase D when all three backends grow the 422
    // declaration in lockstep.
    const model = await buildModel("examples/sales.ddd");
    const files = generateDotnet(model);
    // Sample one controller — the OpenAPI declaration is per-action.
    const controllerKey = [...files.keys()].find(
      (k) => k.endsWith("Controller.cs") && !k.endsWith("DomainExceptionFilter.cs"),
    );
    expect(controllerKey, "expected at least one Controller.cs").toBeDefined();
    const controller = files.get(controllerKey!)!;
    // No [ProducesResponseType(..., 422)] yet — only 400 / 404 / etc per
    // the existing openapi-errors matrix.
    expect(controller).not.toMatch(/ProducesResponseType\(typeof\(ProblemDetails\), 422\)/);
  });
});
