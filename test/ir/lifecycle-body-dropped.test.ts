// The canonical `create` / `destroy` body is lowered and then ignored.
//
// `canonicalCreate.statements` / `canonicalDestroy.statements` carry the full
// body — guards included — and no backend reads either.  `canonicalCreate` is
// consumed as a MARKER (its existence gates `POST /<aggs>` and the `static
// create` factory) plus `params`/`audited`; the factory body is synthesized
// from the field set.  So whatever the author wrote in the braces never reaches
// an emitter.
//
// That makes a `requires` in a create silently NON-ENFORCING — it parses clean,
// emits no guard, and leaves an authorization-gated create open.  Until the
// bodies are actually rendered (the real fix: the IR is already correct, five
// emitters just don't read it), a named error beats a silent drop.
//
// The negative cases matter as much as the positive ones.  A diagnostic that
// fires where nothing is lost trains readers to ignore it — which is how the
// original silence got established — so the two idioms whose effect the emitted
// create ALREADY reproduces are pinned as explicitly allowed.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const CODE = "loom.lifecycle-body-dropped";

const wrap = (agg: string): string => `
system P {
  subdomain D {
    context Orders {
      enum Priority { low  high }
      valueobject Money { amount: decimal  currency: string }
${agg}
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}
`;

async function codesFor(agg: string): Promise<string[]> {
  const diags = validateLoomModel(await buildLoomModel(wrap(agg)));
  return diags.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("validator — the lifecycle body no backend renders", () => {
  it("rejects a `requires` in a state-based create — it would leave the route OPEN", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        create(code: string) {
          requires currentUser.role == "admin"
          code := code
        }
      }`);
    expect(codes).toContain(CODE);
  });

  it("names the consequence, not just the fact", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        wrap(`
      aggregate Order {
        code: string
        create(code: string) {
          requires currentUser.role == "admin"
          code := code
        }
      }`),
      ),
    );
    const d = diags.find((x) => x.code === CODE);
    // An author who reaches this needs to know the gate is not merely
    // undeclared (the find-403 case) but not RUNNING.
    expect(d?.message).toMatch(/OPEN/);
    expect(d?.message).toMatch(/operation/);
  });

  it("rejects a `precondition` in a create and a `requires` in a destroy", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        status: string
        create(code: string) {
          precondition code.length > 0
          code := code
        }
        destroy() { requires currentUser.role == "admin" }
      }`);
    // Two distinct sites, both dropped.
    expect(codes.filter((c) => c === CODE).length).toBe(2);
  });

  it("rejects a literal default written in the body with no matching field default", async () => {
    // The live case: `status := "New"` reads like a server-set default and is
    // silently promoted to a REQUIRED client field.  `test/fixtures/corpus/
    // audit-history.ddd` shipped this way, and its own e2e had to send
    // `status: 0` to compensate.
    const codes = await codesFor(`
      aggregate Order {
        code: string
        status: string
        create(code: string) {
          code := code
          status := "New"
        }
      }`);
    expect(codes).toContain(CODE);
  });

  it("allows `field := <same-named param>` — the input already supplies it", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        status: string
        create(code: string, status: string) {
          code := code
          status := status
        }
      }`);
    expect(codes).not.toContain(CODE);
  });

  it("allows a literal that matches the FIELD's declared default", async () => {
    // `status: string = "New"` reaches the wire schema as
    // `z.string().default("New")`, so restating it in the body changes nothing.
    const codes = await codesFor(`
      aggregate Order {
        code: string
        status: string = "New"
        create(code: string) {
          code := code
          status := "New"
        }
      }`);
    expect(codes).not.toContain(CODE);
  });

  it("exempts an event-sourced create — that path IS rendered", async () => {
    // `agg.creates[0]` drives the ES command path, which emits the body.
    // Gating it would reject working code.
    const codes = await codesFor(`
      event Opened { order: Order id }
      aggregate Order persistedAs: eventLog {
        code: string
        create(code: string) {
          emit Opened { order: id }
        }
        apply(e: Opened) { }
      }`);
    expect(codes).not.toContain(CODE);
  });

  // ── cases an adversarial review of this check surfaced ───────────────────
  // Each of these SILENTLY PASSED (or falsely fired) in the first version.

  it("does not exempt a `let` that merely SHADOWS the field name", async () => {
    // The exemption is `field := <same-named PARAM>`.  Matching on the name
    // alone let a computed local through — the exact drop the check exists for.
    const codes = await codesFor(`
      aggregate Order {
        code: string
        total: int
        create(code: string, qty: int) {
          let total = qty * 2
          code := code
          total := total
        }
      }`);
    expect(codes).toContain(CODE);
  });

  it("reports a collection mutation, which fell through the reason table", async () => {
    // `add`/`remove`/`call`/`expression`/`variant-match` all reported NOTHING
    // while being just as dropped as an `emit`.  The table is an exhaustive
    // switch now, so a new StmtIR kind is a compile error instead.
    const codes = await codesFor(`
      aggregate Order {
        code: string
        tags: string[]
        create(code: string, tag: string) { code := code  tags += tag }
      }`);
    expect(codes.filter((c) => c === CODE).length).toBe(1);
  });

  it("exempts an ENUM / VO / differently-spelled numeric default restated in the body", async () => {
    // The first version compared literal `value` strings, so it FALSELY FIRED
    // on every default that isn't a bare int/string literal — including the
    // enum spelling this check's own fixtures were rewritten into.
    for (const agg of [
      `aggregate Order {
        code: string
        priority: Priority = Priority.low
        create(code: string) { code := code  priority := Priority.low }
      }`,
      `aggregate Order {
        code: string
        total: decimal = 0
        create(code: string) { code := code  total := 0.0 }
      }`,
      `aggregate Order {
        code: string
        total: Money = Money { amount: 0, currency: "USD" }
        create(code: string) { code := code  total := Money { amount: 0, currency: "USD" } }
      }`,
    ]) {
      expect(await codesFor(agg), agg).not.toContain(CODE);
    }
  });

  it("still fires when the body value DIFFERS from the field default", async () => {
    // The guard against the exemption above swallowing real drops.
    const codes = await codesFor(`
      aggregate Order {
        code: string
        total: int = 0
        create(code: string) { code := code  total := 7 }
      }`);
    expect(codes).toContain(CODE);
  });
});
