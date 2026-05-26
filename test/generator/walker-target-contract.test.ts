// ---------------------------------------------------------------------------
// Walker target contract conformance.
//
// `WalkerTarget` (src/generator/_walker/target.ts) is the cross-
// framework lowering seam contract every frontend (React via
// `tsxTarget`, Phoenix via `heexTarget`, future Vue/Svelte/Blazor)
// implements.  This test pins two things:
//
//   1. STRUCTURAL — both shipped implementations conform to the
//      interface at the type level + every method is callable on a
//      minimal canned input.  Catches drift if a method is removed
//      from one impl while the other gains it (type system catches
//      removal locally; this test catches the cross-target gap).
//
//   2. BEHAVIORAL DELTA — for a single canned input, the two
//      targets produce DIFFERENT output.  Validates the contract
//      isn't accidentally collapsing into a single-framework hard-
//      code where TSX and HEEx would diverge in practice.  Drift on
//      either side surfaces here.
//
// What this test DOES NOT do — assert byte-identical TSX/HEEx output
// against the inline walker implementations.  That's the next-PR
// gate (when each walker switches to delegate to its target).  The
// inline walkers and standalone targets are intentionally separate
// today so the refactor can land incrementally.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { ApiCallSite, StateRef, WalkerTarget } from "../../src/generator/_walker/target.js";
import { heexTarget } from "../../src/generator/phoenix-live-view/heex-target.js";
import { tsxTarget } from "../../src/generator/react/walker/tsx-target.js";

const SAMPLE_STATE_REF: StateRef = {
  field: { name: "step", type: { kind: "primitive", name: "int" } },
  name: "step",
};

const SAMPLE_API_CALL_MUTATION: ApiCallSite = {
  apiHandle: "Sales",
  aggregateName: "Customer",
  operation: "create",
  kind: "mutation",
  args: [],
};

const SAMPLE_API_CALL_QUERY: ApiCallSite = {
  apiHandle: "Sales",
  aggregateName: "Customer",
  operation: "all",
  kind: "query",
  args: [],
};

const TARGETS: ReadonlyArray<{ name: string; target: WalkerTarget }> = [
  { name: "tsxTarget", target: tsxTarget },
  { name: "heexTarget", target: heexTarget },
];

describe("WalkerTarget — every shipped target conforms", () => {
  for (const { name, target } of TARGETS) {
    it(`${name}: framework discriminator is non-empty`, () => {
      expect(target.framework).toBeTruthy();
    });

    it(`${name}: every contract method is a function`, () => {
      // Type-level conformance is enforced by the import; runtime
      // check guards against `undefined` slots from a typo (e.g.
      // `renderStateRead` defined but `renderStateWrite` left off
      // the object literal).
      expect(typeof target.renderStateRead).toBe("function");
      expect(typeof target.renderStateWrite).toBe("function");
      expect(typeof target.renderStateInit).toBe("function");
      expect(typeof target.renderApiCall).toBe("function");
      expect(typeof target.renderApiHoisting).toBe("function");
      expect(typeof target.renderHelperImports).toBe("function");
      expect(typeof target.renderMatch).toBe("function");
      expect(typeof target.renderNavigate).toBe("function");
      expect(typeof target.defaultInitFor).toBe("function");
    });

    it(`${name}: every method produces a string (or string[]) on a canned input`, () => {
      expect(typeof target.renderStateRead(SAMPLE_STATE_REF, "template")).toBe("string");
      expect(typeof target.renderStateWrite(SAMPLE_STATE_REF, "1")).toBe("string");
      expect(typeof target.renderStateInit(SAMPLE_STATE_REF.field, undefined)).toBe("string");
      expect(typeof target.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}")).toBe("string");
      expect(Array.isArray(target.renderApiHoisting([SAMPLE_API_CALL_MUTATION]))).toBe(true);
      expect(Array.isArray(target.renderHelperImports(new Set(), []))).toBe(true);
      expect(typeof target.renderMatch([], undefined)).toBe("string");
      expect(typeof target.renderNavigate("/path", [])).toBe("string");
      expect(typeof target.defaultInitFor({ kind: "primitive", name: "int" })).toBe("string");
    });
  }
});

describe("WalkerTarget — TSX and HEEx diverge per seam (anti-collapse)", () => {
  it("renderStateRead diverges: TSX is bare name, HEEx is `@field` (template)", () => {
    const tsx = tsxTarget.renderStateRead(SAMPLE_STATE_REF, "template");
    const heex = heexTarget.renderStateRead(SAMPLE_STATE_REF, "template");
    expect(tsx).toBe("step");
    expect(heex).toBe("@step");
    expect(tsx).not.toBe(heex);
  });

  it("renderStateRead position-dependent on HEEx, position-invariant on TSX", () => {
    const tsxTemplate = tsxTarget.renderStateRead(SAMPLE_STATE_REF, "template");
    const tsxHandler = tsxTarget.renderStateRead(SAMPLE_STATE_REF, "handler");
    expect(tsxTemplate).toBe(tsxHandler);

    const heexTemplate = heexTarget.renderStateRead(SAMPLE_STATE_REF, "template");
    const heexHandler = heexTarget.renderStateRead(SAMPLE_STATE_REF, "handler");
    expect(heexTemplate).not.toBe(heexHandler);
    expect(heexHandler).toBe("socket.assigns.step");
  });

  it("renderStateWrite diverges: TSX is setter call, HEEx is pipe-assign", () => {
    const tsx = tsxTarget.renderStateWrite(SAMPLE_STATE_REF, "value");
    const heex = heexTarget.renderStateWrite(SAMPLE_STATE_REF, "value");
    expect(tsx).toBe("setStep(value)");
    expect(heex).toBe("|> assign(:step, value)");
  });

  it("renderApiCall diverges: TSX hoists via hook var; HEEx calls directly", () => {
    const tsx = tsxTarget.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}");
    const heex = heexTarget.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}");
    expect(tsx).toMatch(/customerCreate\.mutate\(\{\}\)/);
    expect(heex).toMatch(/create_customer!\(\{\}\)/);
  });

  it("renderApiCall: query (`.all`) routes to `.data` (TSX) vs list_*! (HEEx)", () => {
    const tsx = tsxTarget.renderApiCall(SAMPLE_API_CALL_QUERY, "");
    const heex = heexTarget.renderApiCall(SAMPLE_API_CALL_QUERY, "");
    expect(tsx).toBe("customerAll.data");
    expect(heex).toBe("list_customers()");
  });

  it("renderApiHoisting: TSX emits one const-decl per usage, HEEx is empty", () => {
    const tsx = tsxTarget.renderApiHoisting([SAMPLE_API_CALL_MUTATION]);
    const heex = heexTarget.renderApiHoisting([SAMPLE_API_CALL_MUTATION]);
    expect(tsx).toHaveLength(1);
    expect(tsx[0]).toMatch(/const customerCreate = useCreateCustomer\(\)/);
    expect(heex).toEqual([]);
  });

  it("renderHelperImports diverges: TSX `import { x } from`; HEEx `alias`", () => {
    const used = new Set(["fmt"]);
    const decls = [{ name: "fmt", path: "../helpers/fmt" }];
    const tsx = tsxTarget.renderHelperImports(used, decls);
    const heex = heexTarget.renderHelperImports(used, decls);
    expect(tsx[0]).toMatch(/^import \{ fmt \} from "/);
    expect(heex[0]).toMatch(/^alias .*, as: Fmt$/);
  });

  it("renderMatch diverges: TSX ternary chain, HEEx `cond do … end`", () => {
    const arms = [{ predicate: "x > 0", value: '"pos"' }];
    const tsx = tsxTarget.renderMatch(arms, '"zero"');
    const heex = heexTarget.renderMatch(arms, '"zero"');
    expect(tsx).toBe('(x > 0) ? ("pos") : "zero"');
    expect(heex).toContain("cond do");
    expect(heex).toContain("true -> ");
  });

  it("renderNavigate diverges: TSX React-Router call, HEEx `push_navigate` + ~p", () => {
    const tsx = tsxTarget.renderNavigate("/orders", []);
    const heex = heexTarget.renderNavigate("/orders", []);
    expect(tsx).toBe('navigate("/orders")');
    expect(heex).toBe('push_navigate(socket, to: ~p"/orders")');
  });

  it("defaultInitFor diverges on optional: TSX `undefined`, HEEx `nil`", () => {
    const ty = { kind: "optional" as const, inner: { kind: "primitive" as const, name: "string" } };
    expect(tsxTarget.defaultInitFor(ty)).toBe("undefined");
    expect(heexTarget.defaultInitFor(ty)).toBe("nil");
  });
});
