// A MALFORMED path `{id}` — `GET /api/orders/not-a-uuid` — answers the
// declared wire-validation tier, 422, not the framework's own default.
//
// The contract is not ambiguous and was not invented here: the canonical
// per-operation error matrix (`src/ir/util/openapi-errors.ts`) already says so
// in as many words — "a path `{id}` is parsed as a uuid and a query parameter
// is parsed against its declared type, and a failure at either answers the
// same 422 the body tier does" — and every backend PUBLISHES 422 on `getById`
// / `destroy` because of it.  What differed was what they ANSWERED.
//
// Measured against booted backends (a minimal `aggregate Order with crudish`
// over postgres, curl `GET /api/orders/not-a-uuid`):
//
//   node   — 422 ✓  `z.string().uuid()` on the param → the shared `defaultHook`.
//   .NET   — 422 ✓  `[FromRoute] Guid id` → ModelState → the emitted
//                   `ApiBehaviorOptions.InvalidModelStateResponseFactory`
//                   (`Api/ValidationProblem.cs`).  ALREADY correct on `main`.
//   java   — 500 ✗  `@PathVariable UUID id` raises
//                   MethodArgumentTypeMismatchException, which does NOT
//                   implement `ErrorResponse`, so `ApiExceptionAdvice`'s
//                   catch-all reported a CLIENT fault as `500 "internal"` —
//                   telling the caller to retry a request that can never
//                   succeed.  Fixed by the dedicated arm asserted below.
//   python — the param bound as a bare `str` carrying a DOCUMENTATION-only
//            `format: uuid`, so nothing rejected it and the malformed value
//            reached the repository.  Fixed by making `Path(pattern=…)`
//            enforce the format the spec already published; a miss raises
//            `RequestValidationError`, which the emitted handler already
//            renders as the 422 problem envelope.
//
// These are EMITTED-CODE assertions; the runtime half is recorded above and in
// the PR body (booted .NET → 422, booted java → 422 with the arm and 500 with
// it deleted).
import { describe, expect, it } from "vitest";
import { errorStatuses, UNPROCESSABLE_ENTITY } from "../../src/ir/util/openapi-errors.js";
import { generateSystemFiles } from "../_helpers/generate.js";

const src = (platform: string): string => `
system MPI {
  subdomain D {
    context Sales {
      aggregate Order with crudish { name: string }
      repository Orders for Order { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable d { platform: ${platform}, contexts: [Sales], dataSources: [salesState], serves: A, port: 4000 }
}
`;

function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

describe("a malformed path {id} answers the DECLARED 422, not a framework default", () => {
  it("the contract itself: getById / destroy declare 422", () => {
    // The premise every assertion below rests on.  If this ever stops being
    // true the backends should follow the table, not the other way round.
    expect(errorStatuses("getById")).toContain(UNPROCESSABLE_ENTITY);
    expect(errorStatuses("destroy")).toContain(UNPROCESSABLE_ENTITY);
  });

  it("java: MethodArgumentTypeMismatchException gets its own 422 arm", async () => {
    const advice = fileEndingWith(
      await generateSystemFiles(src("java")),
      "api/ApiExceptionAdvice.java",
    );
    // Without a dedicated arm this fell into the catch-all `onUnhandled` and
    // answered 500 — the exception does NOT implement `ErrorResponse`, so the
    // 4xx branch there never saw it.
    expect(advice).toContain(
      "import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;",
    );
    expect(advice).toContain("@ExceptionHandler(MethodArgumentTypeMismatchException.class)");
    expect(advice).toContain(
      'var problem = problem(422, "Validation failed", "One or more fields are invalid.", request);',
    );
    // The same `errors[]` pointer shape the body tier emits — `/id`, the field,
    // not the whole document — so one client ACL handles both tiers.
    expect(advice).toContain('entry.put("pointer", "/" + e.getName());');
    expect(advice).toContain("return respond(problem, 422);");
    // The arm must sit BEFORE the catch-all in the file; Spring picks the most
    // specific handler, but ordering keeps the emitted file readable and makes
    // an accidental merge into `onUnhandled` obvious in review.
    expect(
      advice.indexOf("@ExceptionHandler(MethodArgumentTypeMismatchException.class)"),
    ).toBeLessThan(advice.indexOf("@ExceptionHandler(Exception.class)"));
  });

  it("python: the {id} path param ENFORCES the uuid format it publishes", async () => {
    const routes = fileEndingWith(
      await generateSystemFiles(src("python")),
      "app/http/order_routes.py",
    );
    // `json_schema_extra` alone was documentation: the param stayed a bare
    // `str` and a malformed id sailed through to the repository.
    expect(routes).toContain(
      'Path(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"',
    );
    // …and the published `format` is unchanged, so the cross-backend
    // path-param parity dimension (type + format) still compares equal.
    expect(routes).toContain('json_schema_extra={"format": "uuid"}');
  });

  it("node / .NET: the two that already answered 422 keep their mechanism", async () => {
    const hono = fileEndingWith(await generateSystemFiles(src("node")), "http/order.routes.ts");
    expect(hono).toContain("params: z.object({ id: z.string().uuid() })");

    const dotnet = await generateSystemFiles(src("dotnet"));
    // MVC's own ValidationProblemDetails is 400; the emitted factory replaces
    // it with the contract's 422.  Both halves must stay wired.
    const program = fileEndingWith(dotnet, "Program.cs");
    expect(program).toContain(
      "opts.InvalidModelStateResponseFactory = D.Api.ValidationProblem.FromModelState;",
    );
    const vp = fileEndingWith(dotnet, "Api/ValidationProblem.cs");
    expect(vp).toContain("Status = 422,");
    expect(vp).toContain("StatusCode = 422,");
    // The 400 branch is reserved for an UNREADABLE BODY, which no path-param
    // failure can reach (its model-state key is the param name, not `$`).
    expect(vp).toContain('Detail = "Malformed JSON in request body",');
  });
});
