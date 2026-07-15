// `loom.unknown-member` — accessing a field that doesn't exist on a
// fully-resolved record receiver (aggregate / entity / value object / event /
// payload, or an `X id` resolving to one) is an error.  Previously such a
// typo cascaded to `T.unknown` and was silently swallowed by the
// operand-check suppression, so the mistake produced no diagnostic at all.
//
// The check is fail-open: it must NOT fire on arrays (collection ops),
// primitives (`.length`), magic identifiers (`currentUser`), or any receiver
// that already typed as `unknown`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const wrap = (members: string) => `system S { subdomain M { context C {
  ${members}
}}}`;

const errs = async (members: string): Promise<string[]> =>
  (await parseString(wrap(members), { validate: true })).errors;

const unknownMember = (e: string[]) => e.filter((s) => /is not a member of/.test(s));

describe("loom.unknown-member — undefined field access", () => {
  it("flags a typo on an aggregate property", async () => {
    const e = await errs(`aggregate Order { total: int
      operation f() { let x = this.totl + 1 } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/'totl' is not a member of 'Order'/);
  });

  it("flags a typo on a value object", async () => {
    const e = await errs(`valueobject Money { amount: int currency: string
      derived label: string = currency }
      aggregate A { m: Money operation f() { let x = this.m.amont } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/'amont' is not a member of 'Money'/);
  });

  it("flags a typo on an event/payload param field", async () => {
    const e = await errs(`aggregate Order { total: int }
      repository Orders for Order { }
      event PaymentReceived { order: Order id, amount: int }
      workflow W { count: int
        create(paid: PaymentReceived) by paid.order { let x = paid.amont == 5 } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/'amont' is not a member of 'PaymentReceived'/);
  });

  it("flags a typo across an `X id` reference", async () => {
    const e = await errs(`aggregate Customer { name: string display }
      aggregate Order { customerId: Customer id
        operation f() { let x = this.customerId.naem } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/'naem' is not a member of 'Customer'/);
  });

  it("reports only the first bad access in a chain (no cascade)", async () => {
    const e = await errs(`aggregate Customer { name: string display }
      aggregate Order { customerId: Customer id
        operation f() { let x = this.customerId.naem.nope } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(1);
  });

  // --- fail-open / no false positives ---

  it("accepts a valid property, `id`, and an operation call", async () => {
    const e = await errs(`aggregate Order { total: int
      operation bump() { total := total + 1 }
      operation f() { let a = this.total  let b = this.id  this.bump() } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(0);
  });

  it("accepts a derived prop and a function member", async () => {
    const e = await errs(`aggregate Order { total: int
      derived doubled: int = total * 2
      function half(): int { total / 2 }
      operation f() { let a = this.doubled  let b = this.half() } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(0);
  });

  it("does not flag collection ops on an array, or string `.length`", async () => {
    const e = await errs(`aggregate Order { name: string
      lines: Line id[]
      operation f() { let a = lines.count  let b = name.length } }
      aggregate Line { qty: int }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(0);
  });

  it("does not flag a field inherited from an abstract base (`extends`)", async () => {
    const e = await errs(`abstract aggregate Contact inheritanceUsing: sharedTable {
        displayName: string
        email: string
        derived display: string = displayName
      }
      aggregate PersonContact extends Contact { firstName: string }
      repository PersonContacts for PersonContact {
        find byEmail(q: string): PersonContact? where this.email == q
      }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(0);
  });

  it("still flags a genuine typo on an inheriting subtype", async () => {
    const e = await errs(`abstract aggregate Contact inheritanceUsing: sharedTable {
        displayName: string
        email: string
        derived display: string = displayName
      }
      aggregate PersonContact extends Contact { firstName: string
        operation f() { let x = this.emial } }
      repository PersonContacts for PersonContact { }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(1);
    expect(e.join("\n")).toMatch(/'emial' is not a member of 'PersonContact'/);
  });

  it("does not flag access on the magic `currentUser`", async () => {
    const e = await errs(`user { id: string, role: string }
      aggregate Order { total: int
        operation f() { let r = currentUser.role } }`);
    expect(unknownMember(e), e.join("\n")).toHaveLength(0);
  });
});
