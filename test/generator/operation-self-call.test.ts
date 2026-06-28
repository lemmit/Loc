import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python in-class operation self-calls must render against the SAME method
// name the def-site emits:
//   - a public `operation reserve` is `def reserve` (call `self.reserve()`);
//   - a `private operation helper` is `def _helper` (call `self._helper()`);
//   - a `function isDraft` is always private `def _is_draft` (`self._is_draft()`).
// Regression for the `self._reserve()` mis-naming — the privacy of the target
// op is carried on the lowered call IR (`targetPrivate`) so the call site
// matches the def site.
//
// (Elixir-vanilla operation→operation self-calls in expression position are a
// separate, deeper feature gap — the context fn is `<op>_<agg>(record, params)`
// returning a tagged tuple, not a pure-value arity-1 callable — so they are not
// covered here.  A `function` self-call on Elixir is the bare `is_draft(record)`
// and is unaffected.)
// ---------------------------------------------------------------------------

const SRC = (platform: string) => `
system S { subdomain D { context C {
  aggregate A ids guid {
    code: string
    status: string
    function isDraft(): bool = status == "draft"
    private operation helper(): string { return code }
    operation reserve(): string { return code }
    operation summarize(): string {
      precondition isDraft()
      return reserve()
    }
    operation viaHelper(): string { return helper() }
  }
}}
api X from D  storage pg { type: postgres }
resource r { for: C, kind: state, use: pg }
deployable d { platform: ${platform}  contexts: [C]  dataSources: [r]  serves: X  port: 4000 }
}`;

async function gen(platform: string): Promise<string> {
  const { model, errors } = await parseString(SRC(platform));
  if (errors.length) throw new Error(`validation errors:\n${errors.join("\n")}`);
  return [...generateSystems(model).files.entries()]
    .filter(([p]) => p.endsWith(".py"))
    .map(([, c]) => c)
    .join("\n\n");
}

describe("operation self-call naming", () => {
  it("python: public op self-call has no underscore; private op + function keep it", async () => {
    const out = await gen("python");
    // def-site
    expect(out).toContain("def reserve(self)");
    expect(out).toContain("def _helper(self)");
    expect(out).toContain("def _is_draft(self)");
    // call-site — the bug was `self._reserve()`
    expect(out).toContain("return self.reserve()");
    expect(out).not.toContain("self._reserve()");
    // a private operation self-call keeps the underscore (matches `def _helper`)
    expect(out).toContain("return self._helper()");
    // a function self-call keeps the underscore (functions are always private)
    expect(out).toContain("self._is_draft()");
  });
});
