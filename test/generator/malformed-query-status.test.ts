// A MALFORMED QUERY STRING — `GET /api/customers?=%C3%A0`, a parameter with an
// EMPTY NAME — is a client fault and must answer 4xx, not 500.
//
// This is the third instance of one recurring bug in the Java backend's
// `ApiExceptionAdvice`, and the second one its own file already documents:
// an exception that carries a client fault but does NOT implement Spring's
// `ErrorResponse` interface falls past the 4xx branch of `onUnhandled` and the
// catch-all answers `500 "internal"` — telling the caller that the SERVER
// broke and the request is worth retrying, when it can never succeed.
//
//   1. wrong verb / unknown path / missing param  → fixed by the
//      `instanceof ErrorResponse` branch in `onUnhandled`.
//   2. `GET /api/orders/not-a-uuid`               → fixed by the dedicated
//      MethodArgumentTypeMismatchException arm (malformed-path-id-status.test.ts).
//   3. `GET /api/customers?=%C3%A0`               → THIS one.  Tomcat refuses
//      to parse the chunk and throws `org.apache.tomcat.util.http.
//      InvalidParameterException` out of the first `getParameter()` call, which
//      on a paged read is Spring's own argument resolution.  It extends
//      IllegalStateException; it implements nothing.
//
// ── How this was found, and why the repro is written out in full ────────────
// The schemathesis nightly (F24) reported `not_a_server_error` on every paged
// collection read, with the repro `GET /api/customers?=%C3%A0&pageSize=467`.
// The `pageSize=467` half is a RED HERRING — it is under the published
// `@Max(500)` and answers 200 on its own.  An earlier triage pass read the
// repro and proposed validating `sort`/`dir`; measured on a booted app, both
// answer 200 with any value and are not involved either.  Only the empty
// parameter name matters, which is why the assertion below is about the
// exception type and not about any query parameter the DSL declares.
//
// Measured on a booted generated backend (postgres + `gradle bootJar`, the
// storefront-system fixture the schemathesis leg itself uses):
//
//                                        before      after
//   GET /api/customers?=%C3%A0&pageSize=467   500        400   ← the four F24 findings
//   GET /api/orders?=%C3%A0&pageSize=467      500        400
//   GET /api/products?=%C3%A0&pageSize=467    500        400
//   GET /api/wallets?=%C3%A0&pageSize=467     500        400
//   GET /api/customers                        200        200   ← no regression
//   GET /api/customers?pageSize=467           200        200
//   GET /api/customers?pageSize=0             400        400   ← the @Min/@Max bound,
//   GET /api/customers?page=0                 400        400      untouched
//
// NOTE the 400 stays UNDOCUMENTED on read routes — `GET /api/customers`
// declares only 200 and 422.  That is a separate, pre-existing finding (F25,
// waived as W32): the `@Min`/`@Max` bounds already answered an undocumented
// 400 before this change.  Fixing the server-error is not a fix for F25 and
// does not pretend to be one; W32 stays.
//
// The other four backends never reached this arm — node/python answer their
// own 4xx for a malformed query and are clean on this check in the same run —
// so the assertion is Java-only by nature, not by omission.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const src = `
system MQS {
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

describe("a malformed query string answers 4xx, not 500", () => {
  it("java: Tomcat's InvalidParameterException gets its own arm", async () => {
    const file = await advice();
    expect(file).toContain(
      "@ExceptionHandler(org.apache.tomcat.util.http.InvalidParameterException.class)",
    );
    expect(file).toContain("public ResponseEntity<ProblemDetail> onMalformedQuery(");
  });

  it("the status comes from Tomcat's own decision, not a hardcoded literal", async () => {
    const file = await advice();
    // `getErrorCode()` IS the status Tomcat would have sent had Spring not
    // turned the throw into a 500 — take it rather than re-deciding, and floor
    // it at 400 so an unset code can never emit a 2xx or 3xx for a fault.
    expect(file).toContain("var status = e.getErrorCode() >= 400 ? e.getErrorCode() : 400;");
    expect(file).toContain(
      'return respond(problem(status, reason, "Malformed query string", request), status);',
    );
  });

  it("the type is fully qualified, so the advice's import block is unchanged", async () => {
    const file = await advice();
    // Same convention as the validation annotations in `emit/common.ts`: name
    // the class inline so no import is added to a file every backend feature
    // also writes into. `spring-boot-starter-web` is emitted unconditionally
    // and brings Tomcat, so the class is always on the classpath.
    expect(file).not.toContain("import org.apache.tomcat.");
  });

  it("the arm sits BEFORE the catch-all", async () => {
    const file = await advice();
    // Spring picks the most specific handler regardless, but ordering keeps the
    // emitted file readable and makes an accidental merge into `onUnhandled`
    // — which is exactly how this bug class keeps recurring — obvious in review.
    const arm = file.indexOf(
      "@ExceptionHandler(org.apache.tomcat.util.http.InvalidParameterException.class)",
    );
    // Assert PRESENCE before ordering. `indexOf` returns -1 for a missing arm,
    // and -1 is less than any real index — so the comparison alone passes most
    // loudly when the thing under test is gone entirely. (Caught by the
    // mutation proof: deleting the emitter arm left this case green.)
    expect(arm, "the arm is not emitted at all").toBeGreaterThan(-1);
    expect(arm).toBeLessThan(file.indexOf("@ExceptionHandler(Exception.class)"));
  });

  it("the catch-all still answers 500 for a genuine server fault", async () => {
    const file = await advice();
    // The point of the fix is to NARROW the catch-all, not to defang it: an
    // unexpected exception must still be a 500. A change that made everything
    // a 400 would pass every assertion above and be far worse than the bug.
    expect(file).toContain("@ExceptionHandler(Exception.class)");
    expect(file).toContain(
      'return respond(problem(500, "Internal Server Error", "internal", request), 500);',
    );
  });
});
