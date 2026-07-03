// C-tier medium remediation slices (full-review-remediation §C):
//   C1  — emit/function literal promotion parity
//   C2  — create/destroy params join the bare-aggregate type-position check
//   C3  — member-call statements (`total.bogus()`) are validated
//   C4  — root-level VO/payload legacy constructor-call rejection
//   C7  — `hosts:`-mounted uis get the same api-binding validation as `ui:`
//   C11 — bare collection accessors (`prices.sum`) are rejected
//
// Each slice's negative case pins the new diagnostic; the positive control
// proves the ergonomic/legal form still passes.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("C1 — emit/function literal promotion parity", () => {
  it("accepts an int literal into a money event field (emit promotion)", async () => {
    const { errors } = await parse(`
      context T {
        event Priced { amount: money }
        aggregate A {
          x: int
          operation price() { emit Priced { amount: 5 } }
        }
        repository As for A { }
      }
    `);
    expect(
      errors.some((e) => /amount/.test(e) && /money|expects/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("accepts an int literal as a money function's expression body", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          function fee(): money = 0
        }
        repository As for A { }
      }
    `);
    expect(
      errors.some((e) => /fee/.test(e) && /money/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("still rejects a genuinely mismatched emit field (string into money)", async () => {
    const { errors } = await parse(`
      context T {
        event Priced { amount: money }
        aggregate A {
          x: int
          operation price() { emit Priced { amount: "nope" } }
        }
        repository As for A { }
      }
    `);
    expect(
      errors.some((e) => /amount/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});

describe("C2 — create/destroy params join the bare-aggregate type check", () => {
  it("rejects a bare aggregate type on a `create` param", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Customer { name: string }
        aggregate Order {
          total: int
          create(c: Customer) { }
        }
        repository Cs for Customer { }
        repository Os for Order { }
      }
    `);
    expect(
      errors.some((e) => /Customer id/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts the `Customer id` link form on a create param", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Customer { name: string }
        aggregate Order {
          total: int
          create(c: Customer id) { }
        }
        repository Cs for Customer { }
        repository Os for Order { }
      }
    `);
    expect(
      errors.some((e) => /bare|Customer id/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});

describe("C3 — member-call statements are validated", () => {
  it("rejects a call to an unknown member (`total.bogus()`)", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          total: money
          operation f() { total.bogus() }
        }
        repository As for A { }
      }
    `);
    expect(
      errors.some((e) => /bogus/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts a legal function member call on a contained part", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          contains addr: Address
          entity Address {
            street: string
            function normalized(): string = street
          }
          operation f() { addr.normalized() }
        }
        repository As for A { }
      }
    `);
    expect(
      errors.some((e) => /normalized/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});

describe("C4 — root-level VO legacy constructor-call rejection", () => {
  it("rejects `Price(1)` when `Price` is a file-scope valueobject", async () => {
    const { errors } = await parse(`
      valueobject Price { amount: int }
      context T {
        aggregate A {
          x: int
          operation f() { let p = Price(1)  x := 0 }
        }
        repository As for A { }
      }
    `);
    expect(
      errors.some((e) => /Price/.test(e) && /builder-call|{ \.\.\. }|v2 syntax/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});

describe("C7 — hosts:-mounted uis get api-binding validation", () => {
  const withHostedUiApiParam = (mount: string) => `
    system S {
      subdomain M { context Sales { aggregate A { x: int } repository As for A { } } }
      api SalesApi from Sales
      ui WebApp { framework: react  api Sales: SalesApi }
      storage pg { type: postgres }
      resource s { for: Sales, kind: state, use: pg }
      deployable api { platform: node, contexts: [Sales], dataSources: [s], serves: SalesApi, port: 3000 }
      deployable web { platform: react, targets: api, ${mount}, port: 3001 }
    }
  `;

  it("flags a hosts:-mounted ui with unbound api params (no compose form)", async () => {
    const { errors } = await parse(withHostedUiApiParam("hosts: WebApp"));
    expect(
      errors.some((e) => /WebApp/.test(e) && /api parameter/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts the ui: compose form that binds the param", async () => {
    const { errors } = await parse(withHostedUiApiParam("ui: WebApp { Sales: api }"));
    expect(
      errors.some((e) => /api parameter/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});

describe("C11 — bare collection accessors are rejected", () => {
  it("rejects a bare `.sum` with no lambda", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order {
          contains lines: Line[]
          entity Line { price: money }
          derived total: money = lines.sum
        }
        repository Os for Order { }
      }
    `);
    expect(
      errors.some((e) => /sum/.test(e) && /lambda|renderable/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("accepts the documented `.sum(x => …)` lambda form", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order {
          contains lines: Line[]
          entity Line { price: money }
          derived total: money = lines.sum(l => l.price)
        }
        repository Os for Order { }
      }
    `);
    expect(
      errors.some((e) => /sum/.test(e) && /lambda|renderable/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("keeps bare `.count` working", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order {
          contains lines: Line[]
          entity Line { price: money }
          derived n: int = lines.count
        }
        repository Os for Order { }
      }
    `);
    expect(
      errors.some((e) => /count/.test(e) && /lambda|renderable/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
