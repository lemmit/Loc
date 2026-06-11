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
import type { DetectedApiCall } from "../../../src/generator/_walker/api-hook-detector.js";
import type { ApiCallSite, StateRef, WalkerTarget } from "../../../src/generator/_walker/target.js";
import { heexTarget } from "../../../src/generator/elixir/heex-target.js";
import { tsxTarget } from "../../../src/generator/react/walker/tsx-target.js";
import { svelteTarget } from "../../../src/generator/svelte/walker/svelte-target.js";
import { vueTarget } from "../../../src/generator/vue/walker/vue-target.js";

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
  { name: "svelteTarget", target: svelteTarget },
  { name: "vueTarget", target: vueTarget },
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
      expect(typeof target.buildHookUse).toBe("function");
      expect(typeof target.renderApiCall).toBe("function");
      expect(typeof target.renderApiHoisting).toBe("function");
      expect(typeof target.renderMatch).toBe("function");
      expect(typeof target.renderNavigate).toBe("function");
      expect(typeof target.defaultInitFor).toBe("function");
      expect(typeof target.renderInterpolation).toBe("function");
      expect(typeof target.renderAttrBinding).toBe("function");
    });

    it(`${name}: every method produces a string (or string[]) on a canned input`, () => {
      expect(typeof target.renderStateRead(SAMPLE_STATE_REF, "template")).toBe("string");
      expect(typeof target.renderStateWrite(SAMPLE_STATE_REF, "1")).toBe("string");
      expect(typeof target.renderStateInit(SAMPLE_STATE_REF.field, undefined)).toBe("string");
      expect(typeof target.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}")).toBe("string");
      expect(Array.isArray(target.renderApiHoisting([SAMPLE_API_CALL_MUTATION]))).toBe(true);
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

  it("svelteTarget diverges from TSX where runes differ, matches where shared", () => {
    // `$state` runes read as the bare name (same spelling as TSX —
    // position-invariant), but writes are plain assignment, not the
    // useState setter call.
    const read = svelteTarget.renderStateRead(SAMPLE_STATE_REF, "template");
    const write = svelteTarget.renderStateWrite(SAMPLE_STATE_REF, "value");
    expect(read).toBe(tsxTarget.renderStateRead(SAMPLE_STATE_REF, "template"));
    expect(write).not.toBe(tsxTarget.renderStateWrite(SAMPLE_STATE_REF, "value"));
    expect(write).toBe("step = value");
    // Text escaping is shared with TSX by design (same HTML-entity set).
    expect(svelteTarget.escapeText("a < b & c")).toBe(tsxTarget.escapeText("a < b & c"));
  });

  it("renderApiCall diverges by design: TSX returns var only, HEEx returns full call", () => {
    // TSX uses React Query — the hook is hoisted via
    // `renderApiHoisting`; the call site is just the var
    // reference, and any chained property access (`.data`,
    // `.mutate(args)`, `.isPending`) comes from the surrounding IR
    // walk via standard member / method-call rendering.
    //
    // HEEx calls the Ash code interface directly; the call site
    // IS the invocation — no hoisting, no chained access pattern.
    const tsx = tsxTarget.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}");
    const heex = heexTarget.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}");
    expect(tsx).toBe("customerCreate");
    expect(heex).toMatch(/create_customer!\(\{\}\)/);
  });

  it("renderApiCall: query (`.all`) — TSX `customerAll`, HEEx `list_customers!()`", () => {
    const tsx = tsxTarget.renderApiCall(SAMPLE_API_CALL_QUERY, "");
    const heex = heexTarget.renderApiCall(SAMPLE_API_CALL_QUERY, "");
    expect(tsx).toBe("customerAll");
    expect(heex).toBe("list_customers!()");
  });

  it("renderApiCall: TSX honours pre-resolved varName override (View-hook shape)", () => {
    // Views don't follow the aggregate+op formula
    // (`<viewCamel>View` is per-view, not per-aggregate-op).  The
    // walker passes the pre-resolved varName through; target
    // returns it verbatim.
    const tsx = tsxTarget.renderApiCall(
      {
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query",
        args: [],
        varName: "activeOrdersView",
      },
      "",
    );
    expect(tsx).toBe("activeOrdersView");
  });

  it("renderApiHoisting: TSX emits one const-decl per usage, HEEx is empty", () => {
    const tsx = tsxTarget.renderApiHoisting([SAMPLE_API_CALL_MUTATION]);
    const heex = heexTarget.renderApiHoisting([SAMPLE_API_CALL_MUTATION]);
    expect(tsx).toHaveLength(1);
    expect(tsx[0]).toMatch(/const customerCreate = useCreateCustomer\(\)/);
    expect(heex).toEqual([]);
  });

  it("renderApiHoisting: pre-resolved varName/hookName/argsRendered override aggregate+op formula", () => {
    // The View-hook case the walker emits today: varName + hookName
    // don't match the aggregate+op formula (View has no aggregate).
    // The optional fields on ApiCallSite let the walker pass
    // pre-resolved values through.
    const tsx = tsxTarget.renderApiHoisting([
      {
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query",
        args: [],
        varName: "activeOrdersView",
        hookName: "useActiveOrdersView",
        argsRendered: [],
      },
    ]);
    expect(tsx).toEqual(["const activeOrdersView = useActiveOrdersView();"]);
  });

  it("renderApiHoisting: argsRendered are interpolated into the hook call", () => {
    const tsx = tsxTarget.renderApiHoisting([
      {
        apiHandle: "",
        aggregateName: "",
        operation: "",
        kind: "query",
        args: [],
        varName: "customerById",
        hookName: "useCustomerById",
        argsRendered: ["id"],
      },
    ]);
    expect(tsx).toEqual(["const customerById = useCustomerById(id);"]);
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

  it("renderNavigate stateExpr escape hatch: TSX wraps verbatim, HEEx falls back to args-empty", () => {
    // Source like `navigate(Page, someRef)` where someRef is a
    // ref/method-call/etc. rather than an object literal.  The
    // contract's stateExpr param embeds the pre-rendered expression
    // as the `state:` value (TSX) and is opaque to HEEx routing
    // (no way to embed an arbitrary expr into a ~p sigil's query
    // string), so HEEx falls back to the args-empty push_navigate.
    const tsx = tsxTarget.renderNavigate("/orders", [], "myStateObj");
    const heex = heexTarget.renderNavigate("/orders", [], "myStateObj");
    expect(tsx).toBe('navigate("/orders", { state: myStateObj })');
    expect(heex).toBe('push_navigate(socket, to: ~p"/orders")');
  });

  it("renderNavigate stateExpr takes precedence over args[]", () => {
    // When both are supplied, the contract reserves stateExpr as
    // the escape hatch — it wins.  Callers pick one or the other.
    const tsx = tsxTarget.renderNavigate(
      "/orders",
      [{ name: "ignored", value: "1" }],
      "overrideState",
    );
    expect(tsx).toBe('navigate("/orders", { state: overrideState })');
  });

  // --- buildHookUse: detection-to-naming translation ---------------------

  it("buildHookUse: TSX produces React-Query naming for the standard ops", () => {
    const detected: DetectedApiCall = {
      aggregateName: "Customer",
      operation: "create",
      args: [],
      kind: "aggregate",
    };
    const renderArg = (_e: unknown): string => {
      throw new Error("renderArg should not be called on a paramless `create`");
    };
    const use = tsxTarget.buildHookUse(detected, renderArg);
    expect(use.varName).toBe("customerCreate");
    expect(use.hookName).toBe("useCreateCustomer");
    expect(use.importFrom).toBe("../api/customer");
    expect(use.argsRendered).toEqual([]);
  });

  it("buildHookUse: TSX `all` op pluralises (`useAllCustomers`)", () => {
    const detected: DetectedApiCall = {
      aggregateName: "Customer",
      operation: "all",
      args: [],
      kind: "aggregate",
    };
    const use = tsxTarget.buildHookUse(detected, () => "");
    expect(use.varName).toBe("customerAll");
    expect(use.hookName).toBe("useAllCustomers");
  });

  it("buildHookUse: TSX `byId` op is suffixed (`useCustomerById`)", () => {
    const detected: DetectedApiCall = {
      aggregateName: "Customer",
      operation: "byId",
      args: [],
      kind: "aggregate",
    };
    const use = tsxTarget.buildHookUse(detected, () => "");
    expect(use.hookName).toBe("useCustomerById");
  });

  it("buildHookUse: TSX renders args via the caller-supplied renderArg", () => {
    const detected: DetectedApiCall = {
      aggregateName: "Customer",
      operation: "byId",
      args: [
        { kind: "ref", name: "id", refKind: "param" },
        { kind: "literal", lit: "string", value: "v" },
      ],
      kind: "aggregate",
    };
    // The renderArg callback receives each arg in source order.  The
    // walker's real renderer is `emitExpr(arg, ctx)`; here we substitute
    // an identifying string so we can assert the args reach the target.
    let calls = 0;
    const renderArg = (e: { kind: string }): string => {
      calls++;
      return `<<${e.kind}>>`;
    };
    const use = tsxTarget.buildHookUse(detected, renderArg);
    expect(calls).toBe(2);
    expect(use.argsRendered).toEqual(["<<ref>>", "<<literal>>"]);
  });

  it("buildHookUse: TSX view-kind goes through the dedicated view-hook naming", () => {
    const detected: DetectedApiCall = {
      aggregateName: "activeOrders",
      operation: "activeOrders",
      args: [],
      kind: "view",
    };
    const use = tsxTarget.buildHookUse(detected, () => "");
    expect(use.varName).toBe("activeOrdersView");
    expect(use.hookName).toBe("useActiveOrdersView");
    expect(use.importFrom).toBe("../api/views");
  });

  it("buildHookUse: HEEx throws (Phoenix LiveView doesn't hoist hooks)", () => {
    const detected: DetectedApiCall = {
      aggregateName: "Customer",
      operation: "create",
      args: [],
      kind: "aggregate",
    };
    expect(() => heexTarget.buildHookUse(detected, () => "")).toThrow(
      /Phoenix LiveView does not hoist/,
    );
  });

  it("defaultInitFor diverges on optional: TSX `undefined`, HEEx `nil`", () => {
    const ty = { kind: "optional" as const, inner: { kind: "primitive" as const, name: "string" } };
    expect(tsxTarget.defaultInitFor(ty)).toBe("undefined");
    expect(heexTarget.defaultInitFor(ty)).toBe("nil");
  });
});

// ---------------------------------------------------------------------------
// Vue target — the ref-position seams, the vue-router navigation shape,
// and the structural `<template v-if>` conditional that distinguish
// `vueTarget` from TSX, plus the naming parities that are DELIBERATE
// (composable naming matches React so the api-builder is shareable).
// ---------------------------------------------------------------------------

describe("WalkerTarget — vueTarget (vue-frontend-plan.md)", () => {
  it("renderStateRead is position-dependent: bare name in template, `.value` in handler", () => {
    // Vue auto-unwraps top-level refs in template position only;
    // script-position code (hoisted handlers) sees the raw Ref.
    expect(vueTarget.renderStateRead(SAMPLE_STATE_REF, "template")).toBe("step");
    expect(vueTarget.renderStateRead(SAMPLE_STATE_REF, "handler")).toBe("step.value");
  });

  it("renderStateWrite assigns through `.value` (writes hoist to script position)", () => {
    expect(vueTarget.renderStateWrite(SAMPLE_STATE_REF, "value")).toBe("step.value = value");
  });

  it("renderApiCall is var-only, like TSX (composable handle hoisted once)", () => {
    expect(vueTarget.renderApiCall(SAMPLE_API_CALL_MUTATION, "{}")).toBe("customerCreate");
    expect(vueTarget.renderApiCall(SAMPLE_API_CALL_QUERY, "")).toBe("customerAll");
  });

  it("renderApiHoisting emits script-position const-decls with TSX-identical shape", () => {
    const lines = vueTarget.renderApiHoisting([SAMPLE_API_CALL_MUTATION, SAMPLE_API_CALL_QUERY]);
    expect(lines).toEqual([
      "const customerCreate = useCreateCustomer();",
      "const customerAll = useAllCustomers();",
    ]);
  });

  it("buildHookUse naming deliberately matches TSX (shared api-module surface)", () => {
    const detected: DetectedApiCall = {
      aggregateName: "Customer",
      operation: "all",
      args: [],
      kind: "aggregate",
    };
    const vue = vueTarget.buildHookUse(detected, () => "");
    const tsx = tsxTarget.buildHookUse(detected, () => "");
    expect(vue).toEqual(tsx);
  });

  it("renderNavigate is vue-router push: bare path, history-state args, stateExpr precedence", () => {
    expect(vueTarget.renderNavigate("/orders", [])).toBe('router.push("/orders")');
    expect(vueTarget.renderNavigate("/orders", [{ name: "id", value: "x" }])).toBe(
      'router.push({ path: "/orders", state: { id: x } })',
    );
    expect(
      vueTarget.renderNavigate("/orders", [{ name: "ignored", value: "1" }], "myStateObj"),
    ).toBe('router.push({ path: "/orders", state: myStateObj })');
  });

  it("renderComment is an HTML comment (diverges from TSX's JSX expression-comment)", () => {
    expect(vueTarget.renderComment("todo")).toBe("<!-- todo -->");
    expect(tsxTarget.renderComment("todo")).toBe("{/* todo */}");
  });

  it("renderConditionalChild is a structural `<template v-if>` block pair", () => {
    const out = vueTarget.renderConditionalChild("ok", "<A />", "<B />", 1);
    expect(out).toContain('<template v-if="ok">');
    expect(out).toContain("<template v-else>");
    expect(out).toContain("<A />");
    expect(out).toContain("<B />");
    // Structural — never the JSX-style markup ternary.
    expect(out).not.toContain("?");
  });

  it("renderStyleAttr: all-literal entries collapse to a flat CSS string", () => {
    const out = vueTarget.renderStyleAttr([
      { key: "background-color", rendered: '"red"', literal: "red" },
      { key: "margin-top", rendered: '"4px"', literal: "4px" },
    ]);
    expect(out).toBe(' style="background-color: red; margin-top: 4px"');
  });

  it("renderStyleAttr: a dynamic entry forces the single-quoted `:style` object binding", () => {
    const out = vueTarget.renderStyleAttr([
      { key: "background-color", rendered: "color" },
      { key: "margin-top", rendered: '"4px"', literal: "4px" },
    ]);
    expect(out).toBe(" :style='{ backgroundColor: color, marginTop: \"4px\" }'");
  });

  it("escapeText entity-escapes mustache braces so literal `{{` never interpolates", () => {
    expect(vueTarget.escapeText("a {{ b }} <c> & d")).toBe(
      "a &#123;&#123; b &#125;&#125; &lt;c&gt; &amp; d",
    );
  });

  it("renderInterpolation diverges: TSX braces, Vue mustaches", () => {
    expect(tsxTarget.renderInterpolation("count + 1")).toBe("{count + 1}");
    expect(vueTarget.renderInterpolation("count + 1")).toBe("{{ count + 1 }}");
  });

  it("renderAttrBinding diverges: TSX `name={e}`, Vue `:name` with collision-free quoting", () => {
    expect(tsxTarget.renderAttrBinding("data-testid", "id")).toBe(" data-testid={id}");
    expect(vueTarget.renderAttrBinding("data-testid", "id")).toBe(' :data-testid="id"');
    // A double-quote-bearing expression flips to single-quoted.
    expect(vueTarget.renderAttrBinding("data-testid", '"row-" + id')).toBe(
      " :data-testid='\"row-\" + id'",
    );
    // Both quote kinds present — fail loud rather than emit a
    // template Vue can't parse.
    expect(() => vueTarget.renderAttrBinding("x", `"a" + 'b'`)).toThrow(/mixes single and double/);
  });
});
