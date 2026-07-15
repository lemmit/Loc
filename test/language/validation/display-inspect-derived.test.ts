import { wireFieldsFor } from "../../../src/ir/enrich/wire-projection.js";
// Display + inspect — reserved-name derived fields and the
// `string(aggregate)` lowering path.
//
// Two string forms — user-facing `display` for Selects / UI labels,
// developer-facing `inspect` for host-language debug hooks; never
// collide because they're reached via different call paths.

import { describe, expect, it } from "vitest";
import { allAggregates } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

describe("derived display (user-facing label)", () => {
  it("`derived display: string = name` parses and surfaces on the aggregate IR", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          name: string
          derived display: string = name
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    expect(u.displayDerived).toBeDefined();
    expect(u.displayDerived?.name).toBe("display");
    expect(u.displayDerived?.type).toEqual({ kind: "primitive", name: "string" });
  });

  it("rejects non-string `derived display` type", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Product {
          qty: int
          derived display: int = qty
        }
      }
    `);
    expect(errors.some((e) => /must have type 'string'/i.test(e))).toBe(true);
  });

  it("rejects multiple `derived display` fields", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Product {
          sku: string
          name: string
          derived display: string = sku
          derived display: string = name
        }
      }
    `);
    expect(errors.some((e) => /multiple 'derived display' fields/i.test(e))).toBe(true);
  });

  it("rejects `derived display` on a value object", async () => {
    const { errors } = await parseString(`
      context X {
        valueobject Money {
          amount: int
          currency: string
          derived display: string = currency
        }
      }
    `);
    expect(errors.some((e) => /only allowed on aggregates/i.test(e))).toBe(true);
  });
});

describe("string(aggregate) — explicit conversion via display", () => {
  it("aggregate with `derived display`: `string(user)` lowers to user.display", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          firstName: string
          lastName: string
          derived display: string = firstName
          derived greeting: string = string(this)
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    const greeting = u.derived.find((d) => d.name === "greeting")!;
    // `string(this)` → MemberAccess(this, "display")
    expect(greeting.expr).toMatchObject({
      kind: "member",
      member: "display",
      memberType: { kind: "primitive", name: "string" },
    });
  });

  it("aggregate without `derived display`: `string(user)` rejected with explicit error", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          name: string
          derived greeting: string = string(this)
        }
        repository Users for User { }
      }
    `);
    expect(errors.some((e) => /has no display form/i.test(e))).toBe(true);
  });
});

describe("implicit `string + aggregate` — admits when display present", () => {
  it("`'hi ' + user` lowers to `'hi ' + user.display` when display declared", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          name: string
          derived display: string = name
          derived greeting: string = "hi " + this
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    const greeting = u.derived.find((d) => d.name === "greeting")!;
    expect(greeting.expr.kind).toBe("binary");
    const bin = greeting.expr as Extract<typeof greeting.expr, { kind: "binary" }>;
    expect(bin.right).toMatchObject({
      kind: "member",
      member: "display",
    });
  });

  it("`'hi ' + user` rejected when no display", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate User {
          name: string
          derived greeting: string = "hi " + this
        }
        repository Users for User { }
      }
    `);
    // Should reject — aggregate without display can't participate in string concat.
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("auto-injected `derived inspect`", () => {
  it("every aggregate gets an `inspectDerived` after enrichment, even without explicit declaration", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          name: string
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    expect(u.inspectDerived).toBeDefined();
    expect(u.inspectDerived?.name).toBe("inspect");
  });

  it("user-declared `derived inspect` overrides the auto-injected default", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          name: string
          derived inspect: string = "custom: " + name
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    expect(u.inspectDerived?.expr.kind).toBe("binary");
    // The default would produce a 'User(id: ...' literal prefix; the
    // override starts with "custom: " instead.
    const bin = u.inspectDerived!.expr as Extract<typeof u.inspectDerived.expr, { kind: "binary" }>;
    expect(bin.left).toMatchObject({ kind: "literal", value: "custom: " });
  });

  it("synthesized inspect is NOT included in wireShape (debug-only)", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          name: string
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    const wireNames = wireFieldsFor(u).map((f) => f.name);
    expect(wireNames).not.toContain("inspect");
  });

  it("VO fields are expanded inline structurally — `[Money]` placeholder is gone", async () => {
    // First-cut synth (PR #524) emitted `[Money]` for any VO-typed
    // field — the developer saw `Product(price: [Money])` in their
    // logs.  PR C inlines the VO's own fields through `member`-access
    // expressions so the debug form shows the contents:
    //   Product(price: Money(amount: 99, currency: 'USD'))
    // Depth-1: VO fields whose own type is another VO / array /
    // optional still fall back to the placeholder, bounding the
    // expression and ducking cycle hazards on self-recursive VO
    // shapes.
    const loom = await buildLoomModel(`
      context X {
        valueobject Money {
          amount: int
          currency: string
        }
        aggregate Product {
          sku: string
          price: Money
        }
        repository Products for Product { }
      }
    `);
    const p = allAggregates(loom).find((a) => a.name === "Product")!;
    const seen: string[] = [];
    const walk = (e: typeof p.inspectDerived.expr): void => {
      if (e.kind === "binary") {
        walk(e.left);
        walk(e.right);
      } else if (e.kind === "literal") {
        seen.push(e.value);
      } else if (e.kind === "convert") {
        walk(e.value);
      } else if (e.kind === "member") {
        seen.push(`member:${e.member}`);
      } else if (e.kind === "ref") {
        seen.push(`ref:${e.name}`);
      } else if (e.kind === "id") {
        seen.push("id");
      }
    };
    walk(p.inspectDerived!.expr);
    // Structural envelope of the inlined VO.
    expect(seen).toContain("Money(");
    expect(seen).toContain("amount: ");
    expect(seen).toContain("currency: ");
    // Member-access through the VO field — both VO fields reachable.
    expect(seen).toContain("member:amount");
    expect(seen).toContain("member:currency");
    // The legacy opaque placeholder is gone.
    expect(seen).not.toContain("[Money]");
  });

  it("a sensitive VO field on the parent redacts the whole VO (no inlining leaks fields)", async () => {
    // `sensitive(...)` on the parent's VO-typed field marks the
    // ENTIRE VO opaque — inlining the VO's fields would defeat the
    // redaction contract.  Synth short-circuits to `<redacted>`
    // before reaching `inlineVO`.
    const loom = await buildLoomModel(`
      context X {
        valueobject Token {
          value: string
          algorithm: string
        }
        aggregate Session {
          userId: string
          authToken: Token sensitive(pii)
        }
        repository Sessions for Session { }
      }
    `);
    const s = allAggregates(loom).find((a) => a.name === "Session")!;
    const seen: string[] = [];
    const walk = (e: typeof s.inspectDerived.expr): void => {
      if (e.kind === "binary") {
        walk(e.left);
        walk(e.right);
      } else if (e.kind === "literal") {
        seen.push(e.value);
      } else if (e.kind === "member") {
        seen.push(`member:${e.member}`);
      }
    };
    walk(s.inspectDerived!.expr);
    expect(seen).toContain("<redacted>");
    // The VO's internal field names must NOT leak as labels or as
    // member accesses.
    expect(seen).not.toContain("value: ");
    expect(seen).not.toContain("algorithm: ");
    expect(seen).not.toContain("member:value");
    expect(seen).not.toContain("member:algorithm");
  });

  it("sensitive field INSIDE an inlined VO redacts only that field — siblings stay", async () => {
    // Per-field sensitivity inside a VO survives the inline.  Caller
    // sees structural slots for non-sensitive siblings; the
    // sensitive one shows `<redacted>` in place of its value.
    const loom = await buildLoomModel(`
      context X {
        valueobject CardInfo {
          brand: string
          number: string sensitive(pii)
        }
        aggregate Payment {
          card: CardInfo
        }
        repository Payments for Payment { }
      }
    `);
    const p = allAggregates(loom).find((a) => a.name === "Payment")!;
    const seen: string[] = [];
    const walk = (e: typeof p.inspectDerived.expr): void => {
      if (e.kind === "binary") {
        walk(e.left);
        walk(e.right);
      } else if (e.kind === "literal") {
        seen.push(e.value);
      } else if (e.kind === "member") {
        seen.push(`member:${e.member}`);
      } else if (e.kind === "convert") {
        walk(e.value);
      }
    };
    walk(p.inspectDerived!.expr);
    expect(seen).toContain("CardInfo(");
    expect(seen).toContain("brand: ");
    expect(seen).toContain("number: ");
    // Brand is still reached via member access; number is replaced.
    expect(seen).toContain("member:brand");
    expect(seen).not.toContain("member:number");
    expect(seen).toContain("<redacted>");
  });

  it("sensitive-tagged fields render as `<redacted>` in the synthesized inspect", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate User {
          name: string
          ssn: string sensitive(pii)
        }
        repository Users for User { }
      }
    `);
    const u = allAggregates(loom).find((a) => a.name === "User")!;
    // Stringify the expression tree to a flat literal sequence.  Walk
    // every literal leaf; the sensitive `ssn` field should appear as
    // `<redacted>` rather than as a `ref` to the field.
    const seen: string[] = [];
    const walk = (e: typeof u.inspectDerived.expr): void => {
      if (e.kind === "binary") {
        walk(e.left);
        walk(e.right);
      } else if (e.kind === "literal") {
        seen.push(e.value);
      } else if (e.kind === "convert") {
        walk(e.value);
      } else if (e.kind === "ref") {
        seen.push(`ref:${e.name}`);
      } else if (e.kind === "id") {
        seen.push("id");
      }
    };
    walk(u.inspectDerived!.expr);
    expect(seen).toContain("<redacted>");
    expect(seen).not.toContain("ref:ssn");
  });
});
