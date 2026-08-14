// What a lifecycle `requires` may READ — the contract that makes route-level
// gating of a canonical `create` / `destroy` possible at all.
//
// This exists because the first attempt at gating ASSUMED the contract and
// shipped a regression on the strength of it.  `create() { requires quantity
// == 0 }` parses, lowers to a `this-prop` ref, and emits an unbound receiver on
// every backend — `this._quantity` inside a module-scope handler (Hono),
// `cannot find symbol` (Java), CS1061 (.NET), `F821 Undefined name self`
// (Python), an undefined `record` (Elixir).  Four non-compiling projects out of
// source that parsed clean, which is strictly worse than the silent drop the
// work set out to fix.
//
// The lesson, and the reason this file is a peer of the emission rather than a
// footnote in it: a contract nothing enforces is a comment.  The emission may
// only assume what a check has already made true.
//
// The two actions differ, and the difference is not cosmetic:
//   create  — `currentUser` only.  No instance exists until the factory runs,
//             and the emitted POST takes the FIELD-DERIVED create input rather
//             than the declared parameter list, so a `param` ref has no wire
//             slot to be read from either.
//   destroy — `currentUser` plus `this`, because the route already loads the
//             row for its 404 probe.  `param` stays out: a DELETE has no body.
//
// ONE TEST PER SPELLING, not per `refKind`.  The first version of the check
// keyed on `refKind` alone, and "reads the instance" has FOUR spellings in this
// grammar of which only ONE lowers to a `ref` — so it caught 1 of 4 while its
// own comment claimed the contract.  A per-refKind test suite would have been
// green the whole time.  The spellings, and what they lower to:
//
//   requires quantity == 0       `ref` (`this-prop`)
//   requires this.quantity == 0  `member` over `{kind:"this"}`   — no ref node
//   requires isEmpty()           `call` (`callKind:"function"`)  — no ref node
//   requires this.isEmpty()      `method-call` over `{kind:"this"}`
//   requires isEmpty             `ref` (`helper-fn`) — was ALLOWLISTED
//
// FIVE, not the four the review named: the fifth turned up while
// mutation-proving the fourth, because re-allowlisting `helper-fn` failed to
// break any test — that arm was aimed at a spelling the `this` rule already
// covered.  `requires isEmpty` (no parens) is the one that reaches it, and it
// renders `this.isEmpty` — on TypeScript a truthy FUNCTION REFERENCE, so the
// gate would read `if (!(this.isEmpty))` and never deny.  A mutation that fails
// to fail is information: it said the arm was untested, and the untested arm
// turned out to hold the spelling with the worst failure mode of the five.
//
// Three of the five (`this.<fn>()`, a `private operation` call, and this bare
// ref) are ALSO refused one layer up, where the guard types as `unknown`.  That
// message is incidental to this contract — it is about RESOLUTION, and it would
// stop firing the day those spellings resolve a `bool` — so those cases assert
// BOTH facts: the AST layer refuses them today, and the contract catches the
// shape on its own (`irCodesFor`).
//
// Each renders the same unbound receiver: `{kind:"this"}` renders as
// `ctx.thisName`, and a `function` / `private-operation` call renders
// `this.<fn>(…)` on every backend.  So each gets its own case here, and each was
// mutation-proved by reverting its arm of the predicate.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";
import { toLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.lifecycle-guard-unreadable";

const wrap = (agg: string): string => `
system P {
  user { id: string  role: string }
  subdomain D {
    context Orders {
${agg}
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}`;

async function codesFor(agg: string): Promise<string[]> {
  const diags = validateLoomModel(await buildLoomModel(wrap(agg)));
  return diags.filter((d) => d.severity === "error").map((d) => d.code);
}

/** Codes from the IR validator ALONE, with the AST validation gate bypassed.
 *
 *  Three of the five spellings (`this.<fn>()`, a `private operation` call, and a
 *  bare `helper-fn` ref) are ALSO refused one layer up, because none of them
 *  resolves a return type there and the guard then types as `unknown`.  Asserting that message instead would test
 *  the wrong thing twice over: it is about RESOLUTION, not about the contract, so
 *  it would go green the day the type resolves — and it says nothing about the
 *  gate.  Both facts are asserted separately below: the AST layer refuses them
 *  today, AND the IR contract catches the shape on its own. */
async function irCodesFor(agg: string): Promise<string[]> {
  const { model } = await parseString(wrap(agg), { validate: false });
  return validateLoomModel(toLoomModel(model))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

/** AST-level (phase ④) errors for a source — the layer above this contract. */
async function astErrorsFor(agg: string): Promise<string[]> {
  return (await parseString(wrap(agg), { validate: true })).errors;
}

describe("a lifecycle `requires` may only read what the gate can see", () => {
  it("rejects a CREATE guard reading a field — the regression this check exists for", async () => {
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string) { requires quantity == 0 }
      }`),
    ).toContain(CODE);
  });

  // ── one case per SPELLING of "reads the instance" ────────────────────────
  // Spellings 2-4 produce NO `ref` node, so the original refKind-only predicate
  // returned empty for all three and the emission was told it could assume a
  // contract that three of the four spellings walked around.

  it("rejects a CREATE guard with an explicit `this.` receiver", async () => {
    // `member` over `{kind:"this"}` — the headline defect spelled with the
    // receiver the grammar also accepts (`ddd.langium` `{infer ThisRef} 'this'`).
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string) { requires this.quantity == 0 }
      }`),
    ).toContain(CODE);
  });

  it("rejects a CREATE guard calling an aggregate `function`", async () => {
    // `call` with `callKind: "function"` — an IMPLICIT receiver.  Renders
    // `this.isEmpty()` on every backend with no `this` node in the IR to notice.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        create(code: string) { requires isEmpty() }
      }`),
    ).toContain(CODE);
  });

  it("rejects a CREATE guard calling an aggregate `function` through `this.`", async () => {
    // `method-call` over `{kind:"this"}` — the fourth spelling, and the one the
    // `helper-fn` allowlist used to wave through.  Refused at the AST layer too
    // (it types as `unknown` there), so both facts are asserted.
    const src = `
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        create(code: string) { requires this.isEmpty() }
      }`;
    expect(await irCodesFor(src)).toContain(CODE);
    expect(await astErrorsFor(src)).not.toEqual([]);
  });

  it("rejects a CREATE guard calling a `private operation`", async () => {
    // Same implicit receiver as an aggregate `function` (`callKind:
    // "private-operation"`), and additionally a MUTATION inside an authorization
    // predicate.  Also refused at the AST layer today.
    const src = `
      aggregate Order {
        code: string
        quantity: int
        private operation bump(): bool { quantity := quantity + 1  return true }
        create(code: string) { requires bump() }
      }`;
    expect(await irCodesFor(src)).toContain(CODE);
    expect(await astErrorsFor(src)).not.toEqual([]);
  });

  it("rejects a CREATE guard naming an aggregate `function` WITHOUT calling it", async () => {
    // The fifth spelling, found while mutation-proving the fourth.  `requires
    // isEmpty` (no parens) lowers to a bare `refKind: "helper-fn"` ref — the
    // refKind this check used to ALLOWLIST — and every backend renders it
    // `this.<fn>` / `<record>.<fn>`: an unbound receiver, and on TypeScript a
    // truthy function reference, so the emitted gate would read
    // `if (!(this.isEmpty))` and never deny.  A gate that silently never denies
    // is the worst failure mode available to this feature.
    //
    // It is refused at the AST layer today as well (typing `unknown`), so both
    // facts are asserted — but the allowlist was still wrong: that message is
    // about resolution, and the classification has to be right on its own.
    const src = `
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        create(code: string) { requires isEmpty }
      }`;
    expect(await irCodesFor(src)).toContain(CODE);
    expect(await astErrorsFor(src)).not.toEqual([]);
  });

  it("names the spelling it found — `this` for a bare receiver", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        wrap(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string) { requires this.quantity == 0 }
      }`),
      ),
    );
    expect(diags.find((d) => d.code === CODE)?.message).toMatch(/`this`/);
  });

  it("names the spelling it found — `isEmpty()` for a bare call", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        wrap(`
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        create(code: string) { requires isEmpty() }
      }`),
      ),
    );
    expect(diags.find((d) => d.code === CODE)?.message).toMatch(/`isEmpty\(\)`/);
  });

  // ── the same four spellings stay LEGAL on a destroy ──────────────────────

  it("accepts every instance-reading spelling on a DESTROY", async () => {
    // The receiver exists there (the caller loads the row for its 404 probe), so
    // widening the predicate must not narrow the destroy half — the failure mode
    // of a node-based rule written without this case.  `this.<fn>()` is left out
    // of the conjunction only because the AST layer refuses it independently of
    // the action; `irCodesFor` covers it below.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        destroy {
          requires currentUser.role == "admin" && quantity == 0 && this.quantity == 0 && isEmpty()
        }
      }`),
    ).not.toContain(CODE);
  });

  it("accepts `this.<fn>()` on a DESTROY at the contract layer", async () => {
    expect(
      await irCodesFor(`
      aggregate Order {
        code: string
        quantity: int
        function isEmpty(): bool { return quantity == 0 }
        destroy { requires this.isEmpty() }
      }`),
    ).not.toContain(CODE);
  });

  it("defers to the ES REFUSAL on an event-sourced create, and reports only that", async () => {
    // The two-layer decision, asserted rather than described.  The contract
    // check runs unconditionally for every other shape — that is what closed the
    // hole where an ES create's guard was never checked at all, because it sat
    // below the `continue` that exempts a RENDERED create body from the DROP
    // report ("is this body dropped" and "what may this guard read" are two
    // questions; one `continue` was answering both).
    //
    // But an ES lifecycle guard cannot be enforced AT ALL — its body renders
    // into a domain `_init` with no principal in scope — so
    // `loom.lifecycle-guard-event-sourced` refuses the whole construct, and
    // adding "…and it reads something the gate cannot see" to that is noise
    // about a gate that will never exist.  One clause, one error, the more
    // specific one.  On #2487 alone (before this refusal exists) the same source
    // draws the contract error instead, which is what keeps the hole closed in
    // the interim.
    const codes = await codesFor(`
      event Opened { order: Order id }
      aggregate Order persistedAs: eventLog {
        code: string
        quantity: int
        create(code: string) {
          requires this.quantity == 0
          emit Opened { order: id }
        }
        apply(e: Opened) { }
      }`);
    expect(codes).toContain("loom.lifecycle-guard-event-sourced");
    expect(codes).not.toContain(CODE);
  });

  it("rejects a CREATE guard reading a declared parameter", async () => {
    // The parameter list never reaches the wire — the create input is derived
    // from the FIELD set — so there is nowhere to read the value from.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        create(code: string, qty: int) { requires currentUser.role == "admin" && qty > 0 }
      }`),
    ).toContain(CODE);
  });

  it("rejects a DESTROY guard reading a parameter — a DELETE carries no body", async () => {
    // `destroy` was skipped entirely on the reasoning that it takes no
    // parameters.  The grammar accepts them, so the reasoning was not a check.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        destroy(reason: string) { requires reason.length > 0 }
      }`),
    ).toContain(CODE);
  });

  it("names the offending ref rather than gesturing at the clause", async () => {
    const diags = validateLoomModel(
      await buildLoomModel(
        wrap(`
      aggregate Order {
        code: string
        quantity: int
        create(code: string) { requires quantity == 0 }
      }`),
      ),
    );
    expect(diags.find((d) => d.code === CODE)?.message).toMatch(/`quantity`/);
  });

  it("accepts a principal-only CREATE guard", async () => {
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        create(code: string) { requires currentUser.role == "admin" }
      }`),
    ).not.toContain(CODE);
  });

  it("accepts a DESTROY guard reading `this` alongside the principal", async () => {
    // The half that must NOT be rejected: the route loads the row before the
    // gate, so a state precondition on deletion is legitimate — and it is what
    // makes 404-before-403 observable.
    expect(
      await codesFor(`
      aggregate Order {
        code: string
        quantity: int
        destroy { requires currentUser.role == "admin" && quantity == 0 }
      }`),
    ).not.toContain(CODE);
  });
});
