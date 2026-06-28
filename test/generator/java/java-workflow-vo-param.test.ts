// Java workflow value-object params + int money-literals.  Two
// pre-existing gradle-compile defects, surfaced together because they both
// bite a `workflow X { create(amount: Money) }`-shaped workflow:
//
//   1. The workflow Request DTO references `<Vo>Request` (the VO's request
//      record) but lives in a DIFFERENT package than the aggregate that
//      emits that record — so it must IMPORT it.  (The aggregate-create
//      Request DTO gets it for free by co-location.)  The same import + a
//      `to<Vo>(...)` mapper are needed in the workflow service.
//   2. A bare int literal flowing into a money/decimal create input
//      (`threshold: 0`, `Account.create({ threshold: 0 })`) wasn't promoted
//      to the typed `BigDecimal` literal in the workflow factory-let — Java
//      emitted a raw `int 0` into a `BigDecimal` position and failed to
//      compile.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S { subdomain Core { context Wallet {
  valueobject Money { amount: decimal  currency: string  invariant amount >= 0 }
  aggregate Account with crudish {
    balance: Money
    threshold: decimal = 0
  }
  repository Accounts for Account { }
  workflow topUp {
    create(amount: Money) {
      let acct = Account.create({ balance: amount, threshold: 0 })
    }
  }
} } api A from Core  storage pg { type: postgres }
  deployable api { platform: java  contexts: [Wallet]  serves: A  port: 8080 } }`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1];
  expect(hit, `${suffix} not emitted`).toBeDefined();
  return hit!;
}

describe("java workflow value-object params + int money-literals", () => {
  it("imports the VO request record into the workflow Request DTO", async () => {
    const files = await gen();
    const req = fileEndingWith(files, "TopUpRequest.java");
    // The component references MoneyRequest...
    expect(req).toContain("public record TopUpRequest(MoneyRequest amount)");
    // ...which lives in the aggregate's application package, so it's imported
    // (not left to the `domain.valueobjects.*` wildcard, where it isn't).
    expect(req).toContain("import com.loom.api.features.accounts.MoneyRequest;");
  });

  it("emits the to<Vo> mapper + its request import in the workflow service", async () => {
    const files = await gen();
    const svc = fileEndingWith(files, "WalletWorkflows.java");
    expect(svc).toContain("import com.loom.api.features.accounts.MoneyRequest;");
    expect(svc).toContain("private static Money toMoney(MoneyRequest request)");
    expect(svc).toContain("return new Money(request.amount(), request.currency());");
    // The param is converted through that mapper.
    expect(svc).toContain("var amount = toMoney(request.amount());");
  });

  it("promotes a bare int literal in a decimal create-input to BigDecimal", async () => {
    const files = await gen();
    const svc = fileEndingWith(files, "WalletWorkflows.java");
    // `threshold: 0` lowers to a money/decimal literal, so the factory call
    // passes `new BigDecimal("0")` — never a raw `int 0` into a BigDecimal arg.
    expect(svc).toContain('Account.create(amount, new BigDecimal("0"))');
    expect(svc).not.toMatch(/Account\.create\(amount,\s*0\)/);
  });
});
