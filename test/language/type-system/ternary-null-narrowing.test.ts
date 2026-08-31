// Ternary null-narrowing — `x != null ? <x is T> : <x is T?>` and its reverse.
//
// A `T?` is unusable in most positions (`+` wants two `string`s; an intrinsic
// call wants a non-null receiver) and Loom has no `??`, no `if let` outside a
// workflow, and no `match` over `T?`.  The ternary is the one guard the
// language already spells, and the EMITTED CODE was already right — the null
// test lives in the condition, so every backend's `ternary` leaf renders the
// same bytes either way.  Only the checker was missing, so this is a
// type-checker-only narrowing with byte-identical output.
//
// These tests pin BOTH directions, the negative cases (no leak into the other
// branch, no general flow analysis), and the soundness guard: a branch that
// calls a sibling `operation` can have the field reassigned under it, so it
// does not narrow.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

/** `path: string?` + a `label: string` slot.  `label := <ternary>` is the
 *  discriminator wherever the operand check would not fire: an un-narrowed
 *  branch makes the ternary `string?`, which cannot be assigned to `label`. */
const agg = (body: string) => `
  context X {
    aggregate Thing {
      path: string?
      label: string
      ${body}
    }
    repository Things for Thing { }
  }
`;

describe("ternary null-narrowing — the guarded branch", () => {
  it("`x != null ?` narrows the THEN branch for concatenation", async () => {
    const { errors } = await parseString(
      agg(`derived a: string = path != null ? path + "." : "r"`),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("`x != null ?` narrows the THEN branch for an intrinsic receiver", async () => {
    const { errors } = await parseString(
      agg(`derived a: string = path != null ? path.trim() : ""`),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("`x == null ?` narrows the ELSE branch (the reverse direction)", async () => {
    const { errors } = await parseString(
      agg(`derived a: string = path == null ? "r" : path + "."`),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("the null literal may sit on either side of the test", async () => {
    const { errors } = await parseString(
      agg(`derived a: string = null != path ? path + "." : "r"`),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("nested ternaries compose — the outer guard reaches an inner branch", async () => {
    const { errors } = await parseString(
      agg(`derived a: string = path != null ? (label != "" ? path + "." : path) : ""`),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });

  it("the narrowed ternary is assignable to a NON-optional slot", async () => {
    const { errors } = await parseString(
      agg(`operation c() { label := this.path != null ? this.path : "" }`),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });
});

describe("ternary null-narrowing — what must NOT narrow", () => {
  /** The two shapes an un-narrowed `string?` produces: the binary-operand
   *  report when it reaches a `+`, and the assignment report when the whole
   *  ternary lands in a `string` slot.  Returned (not asserted) so every case
   *  below carries its own `expect` — an assertion hidden in a helper is what
   *  `assertion-free-tests.test.ts` exists to catch. */
  const stillOptional = (errors: string[]) =>
    errors.some((e) => e.includes("left is 'string?'") || e.includes("Cannot assign 'string?'"));

  it("an unguarded use is still rejected", async () => {
    const { errors } = await parseString(agg(`derived a: string = path + "."`));
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  it("narrowing does NOT leak into the ELSE branch of `!= null`", async () => {
    const { errors } = await parseString(agg(`derived a: string = path != null ? "" : path + "."`));
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  it("narrowing does NOT leak into the THEN branch of `== null`", async () => {
    const { errors } = await parseString(agg(`derived a: string = path == null ? path + "." : ""`));
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  it("an `&&` chain is not a direct null test — deliberately no flow analysis", async () => {
    const { errors } = await parseString(
      agg(`derived a: string = path != null && label != "" ? path + "." : ""`),
    );
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  it("a test on a DIFFERENT path narrows nothing", async () => {
    const { errors } = await parseString(
      agg(`other: string?
           derived a: string = other != null ? path + "." : ""`),
    );
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  // SOUNDNESS.  Assignments are statements and a ternary branch is an
  // expression, so nothing in a branch can assign directly — but a branch CAN
  // call a sibling `operation`, whose body assigns freely, and the toolchain
  // accepts that source.  So `this.path` really can be nulled between the test
  // and the use, and such a branch must not narrow.  (A `function` cannot: it
  // is gated pure by `loom.function-block-impure`.)
  it("a branch calling a sibling operation does NOT narrow (the mutation vector)", async () => {
    const { errors } = await parseString(
      agg(`operation c() { label := this.path != null ? (this.bump() != "" ? this.path : this.path) : "" }
           private operation bump(): string { path := null }`),
    );
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  it("a bare (non-`this`) sibling-operation call in the branch also blocks it", async () => {
    const { errors } = await parseString(
      agg(`operation c() { label := this.path != null ? (bump() != "" ? this.path : this.path) : "" }
           private operation bump(): string { path := null }`),
    );
    expect(stillOptional(errors), JSON.stringify(errors)).toBe(true);
  });

  it("but a scalar intrinsic in the branch does NOT block narrowing (pure by catalogue)", async () => {
    const { errors } = await parseString(
      agg(
        `operation c() { label := this.path != null ? (this.label.trim() != "" ? this.path : this.path) : "" }`,
      ),
    );
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });
});
