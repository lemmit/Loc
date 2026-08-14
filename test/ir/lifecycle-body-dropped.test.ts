// The canonical `create` / `destroy` body is lowered and then MOSTLY ignored.
//
// `canonicalCreate.statements` / `canonicalDestroy.statements` carry the full
// body.  `canonicalCreate` is otherwise consumed as a MARKER (its existence
// gates `POST /<aggs>` and the `static create` factory) plus `params`/`audited`;
// the factory body is synthesized from the field set.  So a `precondition`, an
// `emit`, a computed `assign` in the braces still never reaches an emitter, and
// a named error beats a silent drop.
//
// The ONE statement that IS rendered now is `requires` (M-T3.16 step 5): every
// backend evaluates a lifecycle gate at its own chokepoint and denies with 403,
// so it must NOT be reported as dropped — the emitted gate would be unreachable
// from any valid source.  What it may READ is enforced separately
// (`loom.lifecycle-guard-unreadable`), and an EVENT-SOURCED lifecycle guard is
// refused outright (`loom.lifecycle-guard-event-sourced`) because it would
// render into a domain `_init` with no principal in scope.
//
// The negative cases matter as much as the positive ones.  A diagnostic that
// fires where nothing is lost trains readers to ignore it — which is how the
// original silence got established — so the two idioms whose effect the emitted
// create ALREADY reproduces are pinned as explicitly allowed.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const CODE = "loom.lifecycle-body-dropped";

// #2536's `loom.guard-principal-without-auth` requires a principal-reading
// guard to have the auth module that supplies `currentUser` — so the wrapper
// carries the same minimal auth block that validator's own tests use.
const wrap = (agg: string): string => `
system P {
  user { role: string }
  auth { oidc { issuer: "https://idp.example.com"  clientId: "app" } }
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
  deployable d { platform: node contexts: [Orders] dataSources: [st] auth: required port: 3000 }
}
`;

// The principal-guard cases need a legal principal: `loom.guard-principal-
// without-auth` (its own suite) refuses `requires currentUser…` on an
// auth-less deployable, so these two fixtures declare the auth the guard
// reads.
const wrapWithAuth = (agg: string): string => `
system P {
  user { role: string }
  auth { oidc { issuer: "https://idp.example.com"  clientId: "app" } }
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
  deployable d { platform: node contexts: [Orders] dataSources: [st] auth: required port: 3000 }
}
`;

async function codesFor(agg: string): Promise<string[]> {
  const diags = validateLoomModel(await buildLoomModel(wrap(agg)));
  return diags.filter((d) => d.severity === "error").map((d) => d.code);
}

async function codesForWithAuth(agg: string): Promise<string[]> {
  const diags = validateLoomModel(await buildLoomModel(wrapWithAuth(agg)));
  return diags.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("validator — the lifecycle body no backend renders", () => {
  it("ACCEPTS a `requires` in a state-based create — the gate is emitted now", async () => {
    // The inverse of what this test asserted before M-T3.16 step 5.  Keeping the
    // drop-report would make the emitted gate unreachable from any valid source,
    // which is the same "the source and the runtime disagree" failure in the
    // other direction.
    const codes = await codesForWithAuth(`
      aggregate Order {
        code: string
        create(code: string) {
          requires currentUser.role == "admin"
          code := code
        }
      }`);
    expect(codes).not.toContain(CODE);
    expect(codes).toEqual([]);
  });

  it("ACCEPTS a `requires` in a destroy that reads the loaded row", async () => {
    // The destroy gate runs after the by-id load every backend already performs,
    // so `this` IS a legitimate receiver there (unlike in a create).
    const codes = await codesForWithAuth(`
      aggregate Order {
        code: string
        status: string
        destroy() { requires currentUser.role == "admin" && status == "draft" }
      }`);
    expect(codes).toEqual([]);
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
    // undeclared but not RUNNING.
    expect(d?.message).toMatch(/unchecked/);
    expect(d?.message).toMatch(/operation/);
  });

  it("still rejects a `precondition` in a create — that one is NOT rendered", async () => {
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
    // Exactly ONE drop: the `precondition`.  The destroy's `requires` is a
    // rendered gate — a count of 2 here is the regression this pins.
    expect(codes.filter((c) => c === CODE).length).toBe(1);
  });

  it("refuses an EVENT-SOURCED lifecycle guard by its own name", async () => {
    // Its body renders into the domain `_init`, which has no principal in
    // scope: `currentUser` is a free identifier there, so the guard does not
    // deny — it does not compile.  Naming it keeps the state-based emission
    // from resting on a false premise about the ES path.
    const codes = await codesFor(`
      event Opened { order: Order id }
      aggregate Order persistedAs: eventLog {
        code: string
        create(code: string) {
          requires currentUser.role == "admin"
          emit Opened { order: id }
        }
        apply(e: Opened) { }
      }`);
    expect(codes).toContain("loom.lifecycle-guard-event-sourced");
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
