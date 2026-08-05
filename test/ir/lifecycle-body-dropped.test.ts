// The canonical `create` / `destroy` body is lowered and then ignored.
//
// `canonicalCreate.statements` / `canonicalDestroy.statements` carry the full
// body — guards included — and no backend reads either.  `canonicalCreate` is
// consumed as a MARKER (its existence gates `POST /<aggs>` and the `static
// create` factory) plus `params`/`audited`; the factory body is synthesized
// from the field set.  So whatever the author wrote in the braces never reaches
// an emitter.
//
// `requires` USED TO BE THE WORST OF THESE and is no longer here: all five
// backends now render the lifecycle authorization gate (create — before the
// factory; destroy — after the row loads, so it may read `this`).  What
// survives is the one form the route genuinely cannot evaluate: a CREATE guard
// reading a create PARAMETER, which the field-derived request body has no slot
// for.  Everything else in the body — `precondition`, `emit`, a value-changing
// `assign` — is still dropped, and a named error beats a silent drop.
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
  it("ACCEPTS a principal-only `requires` in a create and a destroy — both render now", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        create(code: string) {
          requires currentUser.role == "admin"
          code := code
        }
        destroy { requires currentUser.role == "admin" }
      }`);
    // The enforcement itself is pinned per backend in
    // `test/generator/lifecycle-guard-render.test.ts`; here the point is only
    // that the validator no longer stands in the way.
    expect(codes).not.toContain(CODE);
  });

  it("rejects a create guard that reads a create PARAMETER — the body has no slot for it", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string, quantity: int) {
          requires currentUser.role == "admin" && quantity > 0
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
          precondition code.length > 0
          code := code
        }
      }`),
      ),
    );
    const d = diags.find((x) => x.code === CODE);
    // An author who reaches this needs to know the guard is not merely
    // undeclared (the find-403 case) but not RUNNING.
    expect(d?.message).toMatch(/never runs/);
    expect(d?.message).toMatch(/operation/);
  });

  it("rejects a `precondition` in a create", async () => {
    const codes = await codesFor(`
      aggregate Order {
        code: string
        status: string
        create(code: string) {
          precondition code.length > 0
          code := code
        }
      }`);
    expect(codes.filter((c) => c === CODE).length).toBe(1);
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
});
