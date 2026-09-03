// `requires <DomainService>.<operation>(...)` typing (F2-CB-C9,
// wave-1 sweeper).
//
// `typeOfPostfixChain` had a `<Repository>.<method>(...)` arm and an
// `<Aggregate>.create(...)` arm, but no `<DomainService>.<operation>(...)`
// arm — so a bare `requires Rules.isCancellable(this.qty)` typed the call
// `unknown`, and the `requires` gate (statements.ts) rejected it as
// "must be of type 'bool', got 'unknown'" even though `Rules.isCancellable`
// genuinely returns `bool` — while `requires Rules.isCancellable(this.qty)
// && true` validated clean, because `BinaryChain`'s `&&` arm types to `bool`
// unconditionally and `checkSingleBinaryOperands` suppresses on an `unknown`
// operand. The IR layer (`lower-expr.ts`) already resolved this correctly,
// and every backend already emits the call from a `requires` guard — only
// the AST type gate disagreed with the rest of the pipeline.
//
// The fix mirrors the `<Repository>.<method>(...)` arm directly above it in
// `typeOfPostfixChain`: resolve the domain service by bare name, look up the
// called operation, and type the call to its declared `returnType`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const system = (): string => `
  context Sales {
    aggregate Order {
      qty: int
      operation cancel() {
        requires Rules.isCancellable(this.qty)
      }
    }
    domainService Rules {
      operation isCancellable(qty: int): bool {
        return qty > 0
      }
      operation qtyOf(qty: int): int {
        return qty
      }
    }
  }
`;

// Same shape, but the `requires` calls the int-returning operation instead —
// the "refused with the bool message" half of the assignment.
const systemWithIntReturn = (): string => `
  context Sales {
    aggregate Order {
      qty: int
      operation cancel() {
        requires Rules.qtyOf(this.qty)
      }
    }
    domainService Rules {
      operation isCancellable(qty: int): bool {
        return qty > 0
      }
      operation qtyOf(qty: int): int {
        return qty
      }
    }
  }
`;

// The `&& true` form — pre-fix, this validated clean even for the int-return
// case (masking, not resolving, the underlying type) because the `&&` arm
// suppresses on an `unknown` LHS. Post-fix it should behave IDENTICALLY to
// the bare bool-returning form (clean), not merely "still happen to pass".
const systemWithAndTrue = (): string => `
  context Sales {
    aggregate Order {
      qty: int
      operation cancel() {
        requires Rules.isCancellable(this.qty) && true
      }
    }
    domainService Rules {
      operation isCancellable(qty: int): bool {
        return qty > 0
      }
    }
  }
`;

describe("requires <DomainService>.<operation>(...) typing (F2-CB-C9)", () => {
  it("a bool-returning domain-service op in a bare `requires` validates clean", async () => {
    const { errors } = await parseString(system());
    expect(errors).toEqual([]);
  });

  it("an int-returning domain-service op in a bare `requires` is refused with the bool message", async () => {
    const { errors } = await parseString(systemWithIntReturn());
    expect(errors.join("\n")).toMatch(/'requires' must be of type 'bool', got 'int'\./);
    // Not the pre-fix wording — the call itself must type to 'int', not
    // 'unknown' (which would mean the arm never actually resolved the call).
    expect(errors.join("\n")).not.toMatch(/got 'unknown'/);
  });

  it("the `&& true` form behaves identically to the bare form (both clean, not just the `&&` one)", async () => {
    const { errors } = await parseString(systemWithAndTrue());
    expect(errors).toEqual([]);
  });
});
