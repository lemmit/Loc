// A REFUSED PAGED BOUND — `GET /api/customers?pageSize=0` — answers the
// wire-validation tier's 422, not Spring's own 400.
//
// #2555 gave `page`/`pageSize` declared, ENFORCED limits on every backend
// (`JAVA_PAGED_QUERY_PARAMS` in `emit/common.ts` carries the `@Min`/`@Max`).
// Java enforced them with a status nobody else answers and its own spec does
// not publish (schemathesis F25).
//
// ── Java was the outlier; the matrix was right ─────────────────────────────
// The register first read this as a contract question — "the shared matrix
// declares 422, java answers 400, which is wrong?" — and left it open. It is
// not a question. All four other backends already answer 422 for the identical
// request, each through its own wire-validation funnel:
//
//   node    z.coerce.number().int().min(1).max(500)  → Hono's `defaultHook`
//   python  Annotated[int, Query(ge=1, le=500)]      → RequestValidationError
//   .NET    [Range(1, 500)]                          → InvalidModelStateResponseFactory
//   java    @Min(1) @Max(500)                        → 400  ← the outlier
//
// and java's own published response set for these routes is `[200, 422]`, with
// no 400 anywhere. Only the runtime answer diverged.
//
// ── Why it diverged ────────────────────────────────────────────────────────
// `HandlerMethodValidationException` — unlike `MethodArgumentTypeMismatch-
// Exception` and Tomcat's `InvalidParameterException`, the two arms beside it —
// DOES implement Spring's `ErrorResponse`, and declares itself a 400. So the
// `instanceof ErrorResponse` branch in `onUnhandled`, which exists to stop
// client faults being answered as 500s, answered this one with the wrong 4xx.
// Hence a dedicated arm: the interface match is right for the framework
// exceptions it was written for, and wrong for a validation failure that
// belongs to a tier the contract already names.
//
// ── Measured on a booted backend ───────────────────────────────────────────
// storefront-system + postgres + `gradle bootJar`:
//
//                                    before   after
//   GET /api/customers?pageSize=0      400     422  {"pointer":"/pageSize",
//                                                    "message":"must be greater
//                                                     than or equal to 1"}
//   GET /api/customers?pageSize=99999  400     422
//   GET /api/customers?page=0          400     422  {"pointer":"/page", …}
//   GET /api/customers?page=99999999   400     422
//   GET /api/customers?pageSize=467    200     200   ← in-contract, no change
//   GET /api/customers                 200     200
//   GET /api/customers?sort=bogus      200     200   ← `sort`/`dir` are
//                                                      unvalidated by design
//
// The 400 that REMAINS on these routes is a different fault — an unparseable
// query string (`?=%C3%A0`), which Tomcat rejects in its own parser before any
// handler runs. That one is correct as a 400 and is tracked as F28/W35; see
// `test/generator/malformed-query-status.test.ts`.
import { describe, expect, it } from "vitest";
import { UNPROCESSABLE_ENTITY } from "../../../src/ir/util/openapi-errors.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const src = `
system PB {
  subdomain D {
    context Sales {
      aggregate Order with crudish { name: string }
      repository Orders for Order { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable d { platform: java, contexts: [Sales], dataSources: [salesState], serves: A, port: 4000 }
}
`;

async function advice(): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith("api/ApiExceptionAdvice.java"));
  expect(key, "ApiExceptionAdvice.java not emitted").toBeDefined();
  return files.get(key as string) as string;
}

const ARM =
  "@ExceptionHandler(org.springframework.web.method.annotation.HandlerMethodValidationException.class)";

/** Just this arm's source — from its `@ExceptionHandler` to the next one.
 *  Every neighbouring arm in this advice shares the 422 envelope lines, so a
 *  whole-file substring check cannot tell whether THIS arm emits them. */
function armBody(file: string): string {
  const start = file.indexOf(ARM);
  expect(start, "the arm is not emitted at all").toBeGreaterThan(-1);
  const next = file.indexOf("@ExceptionHandler(", start + ARM.length);
  return file.slice(start, next === -1 ? undefined : next);
}

describe("a refused paged bound answers the declared 422", () => {
  it("HandlerMethodValidationException gets its own arm", async () => {
    const file = await advice();
    const arm = file.indexOf(
      "@ExceptionHandler(org.springframework.web.method.annotation.HandlerMethodValidationException.class)",
    );
    // Presence before ordering: `indexOf` returns -1 for a missing arm, and -1
    // is less than any real index, so a bare comparison passes loudest when the
    // thing under test is gone.
    expect(arm, "the arm is not emitted at all").toBeGreaterThan(-1);
    // Must precede the catch-all, whose `instanceof ErrorResponse` branch is
    // what answered the wrong 400 — that branch still exists and still matches
    // this exception, so only the dedicated arm's precedence keeps the 422.
    expect(arm).toBeLessThan(file.indexOf("@ExceptionHandler(Exception.class)"));
  });

  it("it answers 422, from the shared constant rather than a literal", async () => {
    const file = await advice();
    expect(UNPROCESSABLE_ENTITY).toBe(422);
    // Scoped to THIS arm's body. A whole-file `toContain` passes on the
    // neighbouring MethodArgumentTypeMismatch arm, which emits the identical
    // 422 lines — so it stayed green with this arm deleted, asserting nothing
    // about the thing under test. (Caught by the mutation proof.)
    expect(armBody(file)).toContain(
      `var problem = problem(${UNPROCESSABLE_ENTITY}, "Validation failed", "One or more fields are invalid.", request);`,
    );
    expect(armBody(file)).toContain(`return respond(problem, ${UNPROCESSABLE_ENTITY});`);
  });

  it("the errors[] entry carries a real pointer, through the shared RFC 6901 helper", async () => {
    const file = await advice();
    // The same envelope the body tier emits, so one client ACL handles both.
    // `pointerOf` (not a raw "/" + name) is what keeps the pointer spelling
    // identical to the nested-body case that test/generator/java/
    // errors-pointer-rfc6901.test.ts pins.
    expect(file).toContain("for (var result : e.getParameterValidationResults()) {");
    expect(file).toContain("var name = result.getMethodParameter().getParameterName();");
    expect(file).toContain('entry.put("pointer", pointerOf(name != null ? name : ""));');
    expect(file).toContain("for (var err : result.getResolvableErrors()) {");
  });

  it("a missing parameter name degrades to the whole-document pointer, not `/null`", async () => {
    const file = await advice();
    // `getParameterName()` needs javac's `-parameters`. Spring Boot's Gradle
    // plugin sets it, and the controllers already depend on it (their
    // `@RequestParam`s name no value) — but a toolchain that dropped it must
    // still emit a legal pointer rather than the string "null".
    expect(file).toContain('name != null ? name : ""');
  });

  it("the bounds themselves are unchanged — this moves the STATUS, not the contract", async () => {
    // The fix must not quietly relax what is enforced or published. If a bound
    // moved, the 422 would be answered for a different set of requests than the
    // spec advertises, which is the bug one layer over.
    const files = await generateSystemFiles(src);
    const common = [...files].find(([p]) => p.endsWith("Api/OrderController.java"))?.[1] ?? "";
    const anyController =
      common ||
      ([...files].find(([p]) => p.endsWith("Controller.java"))?.[1] as string | undefined) ||
      "";
    expect(anyController).toContain("jakarta.validation.constraints.Min(1)");
    expect(anyController).toContain("jakarta.validation.constraints.Max(500)");
  });
});
