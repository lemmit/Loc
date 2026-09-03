// The java wire boundary must REFUSE what the domain cannot take — instead of
// letting it through and reporting the crash as a 500.
//
// Three separate escapes, one boundary. Measured on a booted Spring app
// (postgres, `aggregate Order with crudish { sku, qty, placedAt: datetime,
// price: Money, invariant sku.length > 0 }`), `POST /api/orders`:
//
//   body                                   before   after
//   placedAt: ""                            500      422   /placedAt
//   placedAt: "not-a-date"                  500      422   /placedAt
//   sku: null                               500      422   /sku
//   price: null                             500      422   /price
//   price: {amount: null}                   500      422   /price/amount
//   sku: ""            (the invariant)      422      422   /sku   ← unmoved
//   a valid body                            201      201          ← unmoved
//
// ── F19: money and datetime cross the wire as STRINGS ──────────────────────
// The service parsed them bare — `Instant.parse(request.placedAt())`,
// `new BigDecimal(...)` — and the resulting DateTimeParseException /
// NumberFormatException matched no `@ExceptionHandler`, so the catch-all
// answered `500 "internal"`: a server fault for input the server itself
// refused. `WireFormatException.instant/decimal` are those same parses
// wrapped, and the advice renders them as the 422 + `errors[]` envelope .NET's
// own WireFormatException arm has emitted since M-T6.48.
//
// The guard is OPT-IN per call site, via the `pointer` argument: the wire
// boundary passes one, and the emitters that are NOT the wire boundary (seeds,
// the channel decoder, the emitted tests) keep the bare parse byte-identical.
//
// ── F23: a required member arriving as JSON `null` ─────────────────────────
// Operation bodies have carried `@NotNull` since RS-26; the CREATE body never
// did, so `{"sku": null}` bound null and the domain dereferenced it
// (`Cannot invoke "String.codePoints()" because "sku" is null`). `@Valid` on a
// nested record makes the walk DESCEND, which is what turns
// `{"price":{"amount":null}}` from an NPE inside `toMoney` into a 422 naming
// `/price/amount`.
//
// ── …and the null-skip that F23 needed second ─────────────────────────────
// Adding `@NotNull` alone did NOT fix `sku: null`, and the reason is worth
// keeping: the emitted invariant `Validator` is a Spring `Validator` that Bean
// Validation runs ALONGSIDE the record's annotations, not after them, so the
// length check still reached `sku.codePoints()` first and threw. Measured, not
// assumed — the stack trace named `CreateOrderValidator.validate` line 23. A
// null now SKIPS its bound, leaving the absence to the annotation that
// describes it, exactly as .NET's FluentValidation arms already do
// (`v == null || …`).
//
// ── Not in scope, and still failing ───────────────────────────────────────
// A NUL character inside a declared string still reaches Postgres and 500s
// (F20) — on .NET too. That is a storage-layer refusal, not a parse, and it is
// its own slice.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const src = `
system Shop {
  subdomain D {
    context Shop {
      valueobject Money { amount: decimal  currency: string }
      aggregate Order with crudish {
        sku: string
        qty: int
        placedAt: datetime
        price: Money
        note: string?
        invariant sku.length > 0
      }
      repository Orders for Order { }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable jv { platform: java, contexts: [Shop], dataSources: [shopState], serves: A, port: 4000 }
}
`;

async function file(suffix: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key as string) as string;
}

describe("java — F19: a malformed wire string is refused, not parsed into a 500", () => {
  it("the service parses datetime through the guard, with the field's pointer", async () => {
    const service = await file("orders/OrderService.java");
    expect(service).toContain('WireFormatException.instant("/placedAt", request.placedAt())');
    // The bare parse is what threw past every advice arm.
    expect(service).not.toContain("Instant.parse(request.placedAt())");
  });

  it("the guarded parse is imported only where it is emitted", async () => {
    const service = await file("orders/OrderService.java");
    expect(service).toContain("import com.loom.jv.domain.common.WireFormatException;");
  });

  it("WireFormatException carries the pointer and wraps both string parses", async () => {
    const ex = await file("domain/common/WireFormatException.java");
    expect(ex).toContain("public String fieldPointer()");
    expect(ex).toContain("public static java.time.Instant instant(String pointer, String raw)");
    expect(ex).toContain("public static java.math.BigDecimal decimal(String pointer, String raw)");
    // Wrapping, not re-implementing: the parse itself must stay the same one.
    expect(ex).toContain("java.time.Instant.parse(raw)");
    expect(ex).toContain("new java.math.BigDecimal(raw)");
  });

  it("the advice answers 422 with the field's own pointer", async () => {
    const advice = await file("api/ApiExceptionAdvice.java");
    expect(advice).toContain("@ExceptionHandler(WireFormatException.class)");
    expect(advice).toContain('entry.put("pointer", e.fieldPointer());');
    // Ahead of the catch-all, or the catch-all's 500 answers first.
    const arm = advice.indexOf("@ExceptionHandler(WireFormatException.class)");
    const catchAll = advice.indexOf("@ExceptionHandler(Exception.class)");
    expect(arm).toBeGreaterThan(-1);
    expect(catchAll).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(catchAll);
  });
});

describe("java — F23: a required member arriving as null is refused", () => {
  it("required create-body members carry @NotNull", async () => {
    const req = await file("orders/CreateOrderRequest.java");
    expect(req).toContain("@NotNull String sku");
    expect(req).toContain("@NotNull String placedAt");
  });

  it("a nested record also carries @Valid, so the walk descends into it", async () => {
    // Without @Valid the outer null is caught and `{"price":{"amount":null}}`
    // still NPEs inside the mapper. Measured: the pointer is `/price/amount`.
    const req = await file("orders/CreateOrderRequest.java");
    expect(req).toContain("@NotNull @Valid MoneyRequest price");
    const money = await file("orders/MoneyRequest.java");
    expect(money).toContain("@NotNull BigDecimal amount");
    expect(money).toContain("@NotNull String currency");
  });

  it("a PRIMITIVE component gets no @NotNull — it would be inert", async () => {
    // A primitive is never null, and the absence it would describe is already
    // answered: Jackson 3 enables FAIL_ON_NULL_FOR_PRIMITIVES, so a missing
    // `int qty` is a hard read failure.
    const req = await file("orders/CreateOrderRequest.java");
    expect(req).toContain("int qty");
    expect(req).not.toContain("@NotNull int qty");
  });

  it("an OPTIONAL member is not made required by this", async () => {
    const req = await file("orders/CreateOrderRequest.java");
    expect(req).toMatch(/(?<!@NotNull )String note/);
  });

  it("a RESPONSE record is not annotated — it is serialized, never validated", async () => {
    const resp = await file("orders/OrderResponse.java");
    expect(resp).not.toContain("@NotNull");
  });
});

describe("java — the invariant validator skips a null instead of dereferencing it", () => {
  it("a length bound is guarded by a null check", async () => {
    // The Spring `Validator` runs ALONGSIDE the record's @NotNull, not after
    // it, so without this the length check reaches `sku.codePoints()` first.
    const validator = await file("orders/CreateOrderValidator.java");
    expect(validator).toContain("sku == null || ((int) sku.codePoints().count()) >= 1");
  });

  it("the bound itself is unchanged — an empty string still fails", async () => {
    // Narrowness: skipping NULL must not skip EMPTY. `""` is present and
    // violates the invariant; it answered 422 before and answers 422 after.
    const validator = await file("orders/CreateOrderValidator.java");
    expect(validator).toContain('errors.rejectValue("sku", "loom.invariant"');
    expect(validator).toContain(">= 1");
  });
});
