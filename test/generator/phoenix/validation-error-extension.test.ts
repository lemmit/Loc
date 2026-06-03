// Phoenix backend — validation-error extension emission (Phase C of
// docs/proposals/validation-error-extension.md).
//
// Activates the dormant `applied` path in the frontend ACL for the
// Phoenix backend.  When an Ash code-interface bang call raises
// `Ash.Error.Invalid`, the controller's Plug.ErrorHandler callback
// routes to the shared `<App>Web.ProblemDetails` module which emits the
// RFC 7807 §3.2 `errors[]` extension shape that `applyServerErrors`
// consumes.  Same wire body as Hono's defaultHook (#782) and .NET's
// FluentValidation arm (#829).
//
// What this protects:
//  - The shared ProblemDetails module is emitted at
//    `lib/<app>_web/problem_details.ex` once per project.
//  - The module exports `validation_error_response/2` (422 + errors[])
//    and `problem_response/4` (base 4xx ProblemDetails) — shared by
//    every error path that produces an RFC 7807 envelope.
//  - The per-aggregate controllers `use Plug.ErrorHandler` and route
//    `Ash.Error.Invalid` through `validation_error_response/2`.
//  - The workflows controller's `error_response/2` extends its
//    pattern-match to dispatch `%Ash.Error.Invalid{}` reasons to
//    `validation_error_response/2` and falls back to `problem_response/4`
//    for forbidden / generic domain errors.
//  - The `pointer_of/1` walker camelCases atom segments (matching the
//    JsonCamelCase encoder), applies RFC 6901 escapes (`~` → `~0`,
//    `/` → `~1`), and emits `""` for the empty path (root error).
//
// As of Phase D, the OpenAPI surface has been brought into lockstep with
// the runtime body across all three backends:
//  - 422 declared alongside 400 on body-bearing routes
//    (create / operation / workflow) via the central matrix in
//    src/ir/util/openapi-errors.ts.
//  - The `ProblemDetails` OpenAPI component schema now declares
//    `errors: [{ pointer, message }]` so OpenAPI codegen and other
//    spec consumers see the validation-failure shape they should expect.
//
// The cross-backend parity gate (`test/_helpers/openapi-normalize.ts`)
// keeps `fieldSet("ProblemDetails")` + per-operation `errorResponses()`
// byte-equal across all three backends.  Phase D moved all three
// together so the gate stays green.

import { describe, expect, it } from "vitest";
import { emitApiControllers } from "../../../src/generator/phoenix-live-view/api-emit.js";
import { emitOpenApiSpec } from "../../../src/generator/phoenix-live-view/openapi-emit.js";
import { renderProblemDetailsModule } from "../../../src/generator/phoenix-live-view/problem-details-emit.js";
import type {
  AggregateIR,
  BoundedContextIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  Platform,
  SystemIR,
} from "../../../src/ir/types/loom-ir.js";

const phoenixPlatform: Platform = "phoenixLiveView";

// Minimal stub aggregate / context / system that triggers the per-aggregate
// controller emission without dragging in every other emit path.
function stubModel(): {
  contexts: EnrichedBoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
} {
  const agg: AggregateIR = {
    name: "Order",
    parts: [],
    fields: [
      {
        name: "id",
        type: { kind: "primitive", name: "uuid" },
        optional: false,
        access: "editable",
      },
      {
        name: "subject",
        type: { kind: "primitive", name: "string" },
        optional: false,
        access: "editable",
      },
    ],
    invariants: [],
    operations: [],
    storedFields: [],
    derivedFields: [],
    embeddedParts: [],
    wireShape: [],
    repositoryName: "Orders",
    canonicalDestroy: null,
    canonicalCreate: null,
  };
  const ctx: EnrichedBoundedContextIR = {
    name: "Sales",
    aggregates: [agg],
    enums: [],
    valueObjects: [],
    events: [],
    repositories: [
      { name: "Orders", aggregateName: "Order", finds: [{ name: "all", params: [] }] },
    ],
    workflows: [],
    views: [],
    storage: {} as never,
    moduleName: undefined,
  } as unknown as EnrichedBoundedContextIR;
  const deployable: DeployableIR = {
    name: "phoenixApi",
    platform: phoenixPlatform,
    port: 4000,
    serves: ["SalesApi"],
    moduleNames: ["Sales"],
  } as unknown as DeployableIR;
  const sys: SystemIR = {
    name: "Stub",
    deployables: [deployable],
    uis: [],
    contexts: [ctx as unknown as BoundedContextIR],
  } as unknown as SystemIR;
  return { contexts: [ctx], deployable, sys };
}

describe("Phoenix validation-error extension — shared ProblemDetails module", () => {
  it("renderProblemDetailsModule emits the public API surface (validation + base)", () => {
    const src = renderProblemDetailsModule("PhoenixApp");
    // Module name + alias.
    expect(src).toMatch(/defmodule PhoenixAppWeb\.ProblemDetails do/);
    // Two public entry points.
    expect(src).toMatch(
      /def validation_error_response\(conn, %Ash\.Error\.Invalid\{errors: errors\}\)/,
    );
    expect(src).toMatch(/def problem_response\(conn, status, title, detail\)/);
    // Defensive arms for Ash error wrappers other than Invalid and for
    // a raw list of error structs.
    expect(src).toMatch(/def validation_error_response\(conn, %\{__exception__: true\} = err\)/);
    expect(src).toMatch(/def validation_error_response\(conn, errors\) when is_list\(errors\)/);
  });

  it("validation_error_response builds the RFC 7807 §3.2 body shape", () => {
    const src = renderProblemDetailsModule("PhoenixApp");
    // Body uses Jason.encode! on a map with the locked field set.
    expect(src).toMatch(/Jason\.encode!\(%\{/);
    expect(src).toMatch(/type: "about:blank"/);
    expect(src).toMatch(/title: "Validation failed"/);
    expect(src).toMatch(/status: 422/);
    expect(src).toMatch(/detail: "One or more fields are invalid\."/);
    expect(src).toMatch(/instance: conn\.request_path/);
    expect(src).toMatch(/errors: pointer_errors/);
    // Response wiring: 422 + application/problem+json + x-request-id.
    expect(src).toMatch(/put_resp_content_type\("application\/problem\+json"\)/);
    expect(src).toMatch(/put_resp_header\("x-request-id", trace_id\)/);
    expect(src).toMatch(/send_resp\(422, body\)/);
  });

  it("pointer_of/1 implements the RFC 6901 wire-shape rules", () => {
    const src = renderProblemDetailsModule("PhoenixApp");
    // Empty path → empty pointer (root error per RFC 6901).
    expect(src).toMatch(/defp pointer_of\(\[\]\), do: ""/);
    // Non-empty path: "/" + slash-joined escaped segments.
    expect(src).toMatch(/"\/" <> Enum\.join\(encoded, "\/"\)/);
    // Atom segments → camelize (matches JsonCamelCase wire shape).
    expect(src).toMatch(
      /segment_to_string\(seg\) when is_atom\(seg\), do: camelize\(Atom\.to_string\(seg\)\)/,
    );
    // Integer segments → bare string (array indices like /items/0/qty).
    expect(src).toMatch(
      /segment_to_string\(seg\) when is_integer\(seg\), do: Integer\.to_string\(seg\)/,
    );
    // RFC 6901 segment escapes.
    expect(src).toMatch(/String\.replace\("~", "~0"\)/);
    expect(src).toMatch(/String\.replace\("\/", "~1"\)/);
    // camelize mirrors JsonCamelCase exactly.
    expect(src).toMatch(/defp camelize\(str\)/);
    expect(src).toMatch(/String\.split\(str, "_"\)/);
  });

  it("walks Ash error tree using path + field/fields for segment construction", () => {
    const src = renderProblemDetailsModule("PhoenixApp");
    // The error-tree walker pulls .path AND .field (or .fields) off each
    // Ash error struct — the canonical place Ash records the failing
    // attribute.  The emit uses pipeline syntax, e.g.
    //   path = err |> Map.get(:path, []) |> List.wrap()
    expect(src).toMatch(/Map\.get\(:path, \[\]\)/);
    expect(src).toMatch(/Map\.get\(:field\)/);
    expect(src).toMatch(/Map\.get\(:fields, \[\]\)/);
    // Each Ash error contributes one { pointer, message } map.
    expect(src).toMatch(/%\{pointer: pointer_of\(segments\), message:/);
  });
});

describe("Phoenix validation-error extension — per-aggregate controller wiring", () => {
  it("per-aggregate controllers use Plug.ErrorHandler and route Ash.Error.Invalid to the shared responder", () => {
    const { contexts, deployable, sys } = stubModel();
    const { files } = emitApiControllers({
      contexts,
      deployable,
      sys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const ctrlKey = [...files.keys()].find(
      (k) => k.endsWith("orders_controller.ex") || k.endsWith("order_controller.ex"),
    );
    expect(ctrlKey, "expected an orders controller to be emitted").toBeDefined();
    const ctrl = files.get(ctrlKey!)!;
    // Plug.ErrorHandler wires the handle_errors/2 callback that intercepts
    // raised exceptions before Phoenix's render_errors pipeline runs.
    expect(ctrl).toMatch(/use Plug\.ErrorHandler/);
    expect(ctrl).toMatch(/@impl Plug\.ErrorHandler/);
    // The Ash.Error.Invalid arm dispatches to the shared module.
    expect(ctrl).toMatch(
      /def handle_errors\(conn, %\{reason: %Ash\.Error\.Invalid\{\} = err\}\) do[\s\S]*?ProblemDetails\.validation_error_response\(conn, err\)/,
    );
    // The catch-all arm leaves the connection alone so non-validation
    // exceptions fall through to Phoenix's default render_errors.
    expect(ctrl).toMatch(/def handle_errors\(conn, _assigns\), do: conn/);
  });
});

describe("Phoenix validation-error extension — workflows controller wiring", () => {
  it("workflows error_response/2 routes Ash.Error.Invalid through the shared validation responder", () => {
    // Need a workflow-bearing context, so build a minimal stub with one.
    const sys: SystemIR = {
      name: "Stub",
      deployables: [],
      uis: [],
      contexts: [],
    } as unknown as SystemIR;
    const deployable: DeployableIR = {
      name: "phoenixApi",
      platform: phoenixPlatform,
      port: 4000,
      serves: [
        {
          apiName: "SalesApi",
          scopes: [{ contextName: "Sales", workflowNames: ["placeOrder"] }],
        },
      ],
      moduleNames: ["Sales"],
    } as unknown as DeployableIR;
    const ctx: EnrichedBoundedContextIR = {
      name: "Sales",
      aggregates: [],
      enums: [],
      valueObjects: [],
      events: [],
      repositories: [],
      workflows: [
        {
          name: "placeOrder",
          params: [{ name: "subject", type: { kind: "primitive", name: "string" } }],
          statements: [],
        },
      ],
      views: [],
      storage: {} as never,
      moduleName: undefined,
    } as unknown as EnrichedBoundedContextIR;

    const { files } = emitApiControllers({
      contexts: [ctx],
      deployable,
      sys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const wfCtrl = files.get("lib/phoenix_app_web/controllers/workflows_controller.ex");
    expect(wfCtrl, "expected workflows controller to be emitted").toBeDefined();
    // The pattern-match arm for Ash.Error.Invalid dispatches to the
    // shared validation responder.
    expect(wfCtrl!).toMatch(
      /defp error_response\(conn, %Ash\.Error\.Invalid\{\} = err\) do[\s\S]*?PhoenixAppWeb\.ProblemDetails\.validation_error_response\(conn, err\)/,
    );
    // The generic arm dispatches to the base ProblemDetails responder
    // (was inline put_resp_* calls before Phase C).
    expect(wfCtrl!).toMatch(
      /defp error_response\(conn, reason\) do[\s\S]*?PhoenixAppWeb\.ProblemDetails\.problem_response\(conn, status, title, inspect\(reason\)\)/,
    );
  });
});

describe("Phoenix validation-error extension — OpenAPI surface (Phase D)", () => {
  it("ProblemDetails OpenApiSpex schema declares the §3.2 errors[] extension", () => {
    const { contexts, deployable, sys } = stubModel();
    const { files } = emitOpenApiSpec({
      contexts,
      deployable,
      sys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const schemaKey = [...files.keys()].find((k) => k.endsWith("/schemas/problem_details.ex"));
    expect(schemaKey, "expected ProblemDetails OpenApiSpex schema module").toBeDefined();
    const schema = files.get(schemaKey!)!;
    // Base 5 RFC 7807 fields still declared.
    expect(schema).toMatch(/type: %OpenApiSpex\.Schema\{type: :string\}/);
    expect(schema).toMatch(/title: %OpenApiSpex\.Schema\{type: :string\}/);
    expect(schema).toMatch(/status: %OpenApiSpex\.Schema\{type: :integer\}/);
    expect(schema).toMatch(/detail: %OpenApiSpex\.Schema\{type: :string\}/);
    expect(schema).toMatch(/instance: %OpenApiSpex\.Schema\{type: :string\}/);
    // §3.2 errors[] extension — array of { pointer, message }, both required
    // per element, matching the wire shape the frontend ACL consumes.
    expect(schema).toMatch(/errors: %OpenApiSpex\.Schema\{[\s\S]*?type: :array/);
    expect(schema).toMatch(/required: \[:pointer, :message\]/);
    expect(schema).toMatch(/pointer: %OpenApiSpex\.Schema\{type: :string\}/);
    expect(schema).toMatch(/message: %OpenApiSpex\.Schema\{type: :string\}/);
  });

  it("Per-action OpenAPI route declarations carry 422 alongside 400 for body-bearing routes", () => {
    // The central matrix (src/ir/util/openapi-errors.ts) now returns
    // [400, 422] for create / [400, 404, 422] for operation /
    // [400, 422] for workflow.  Phoenix's emitOpenApiSpec renders those
    // through `OpenApiSpex.Response` blocks per action.
    const { contexts, deployable, sys } = stubModel();
    const { files } = emitOpenApiSpec({
      contexts,
      deployable,
      sys,
      appName: "phoenix_app",
      appModule: "PhoenixApp",
    });
    const specKey = [...files.keys()].find((k) => k.endsWith("_api_spec.ex"));
    expect(specKey, "expected per-context API spec module").toBeDefined();
    const spec = files.get(specKey!)!;
    // Both 400 and 422 declared, both pointing at the ProblemDetails schema.
    expect(spec).toMatch(/400 => %OpenApiSpex\.Response\{[\s\S]*?Schemas\.ProblemDetails/);
    expect(spec).toMatch(/422 => %OpenApiSpex\.Response\{[\s\S]*?Schemas\.ProblemDetails/);
  });
});
