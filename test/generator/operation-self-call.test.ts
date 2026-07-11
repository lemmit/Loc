import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// In-class operation self-calls must render against the SAME def-site each
// backend emits:
//
//   Python — a public `operation reserve` is `def reserve` (call
//   `self.reserve()`); a `private operation helper` is `def _helper`
//   (`self._helper()`); a `function isDraft` is always private `def _is_draft`
//   (`self._is_draft()`).  The target op's privacy rides the lowered call IR
//   (`targetPrivate`) so the call site matches the def site.
//
//   Elixir (vanilla) — every op (public OR private) is a context fn
//   `<op>_<agg>(record, params)` returning a tagged `{:ok,_}|{:error,_}` tuple,
//   so a `return reserve()` self-call passes that tuple THROUGH unchanged
//   (`reserve_a(record, %{})`, no re-wrap); a private-op self-call resolves the
//   same way (`helper_a(record, %{})`); a `function` self-call stays the bare
//   arity-1 `is_draft(record)`.  Non-tail op-calls are gated by
//   `loom.vanilla-op-call-position` (see test/ir/vanilla-op-self-call-position).
// ---------------------------------------------------------------------------

const SRC = (platform: string) => `
system S { subdomain D { context C {
  aggregate A {
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

async function gen(platform: string, ext: string): Promise<string> {
  const { model, errors } = await parseString(SRC(platform));
  if (errors.length) throw new Error(`validation errors:\n${errors.join("\n")}`);
  return [...generateSystems(model).files.entries()]
    .filter(([p]) => p.endsWith(ext))
    .map(([, c]) => c)
    .join("\n\n");
}

describe("operation self-call naming", () => {
  it("python: public op self-call has no underscore; private op + function keep it", async () => {
    const out = await gen("python", ".py");
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

  it("elixir: op self-call → <op>_<agg> passthrough; function stays bare", async () => {
    const out = await gen("elixir", ".ex");
    // def-site context fns (arity 2 for ops, arity 1 for the function)
    expect(out).toContain("def reserve_a(%D.C.A{} = record, params)");
    expect(out).toContain("def helper_a(%D.C.A{} = record, params)");
    expect(out).toContain("def is_draft(%D.C.A{} = record)");
    // call-site — the bug was the undefined arity-1 `reserve(record)` AND a
    // double `{:ok, …}` wrap; the fix passes the tagged tuple through.
    expect(out).toContain("reserve_a(record, %{})");
    expect(out).not.toMatch(/\{:ok, reserve/);
    expect(out).not.toMatch(/[^_]reserve\(record\)/);
    // a PRIVATE op self-call resolves the same way (private ops are still
    // emitted as a context fn, just without a controller route)
    expect(out).toContain("helper_a(record, %{})");
    // a function self-call stays the bare arity-1 name
    expect(out).toContain("is_draft(record)");
  });
});
