// ---------------------------------------------------------------------------
// `src/generator/_frontend/extern-functions.ts` — the logic escape hatch's two
// machine-owned files for `function <name>(params): T extern from "<path>"`:
//
//   ① `src/lib/extern/<name>.signature.ts` — `export type <Name>Fn = (…) => T`
//   ② `src/lib/<name>.ts`                  — the conformance shim
//                                            `export const <name>: <Name>Fn = _impl;`
//
// The contract is that `tsc` is the fail-fast in BOTH directions: a missing
// user module fails the shim's import, a drifted signature fails the `const`
// annotation.  That only holds if the two halves agree on the type NAME and
// the signature's types actually track the domain — so this file pins the
// type-mapping table kind by kind, the `apiImportRoot` threading (react
// `../../api` vs SvelteKit `../api`), and the name coupling as a derived
// property (extracted from both files, never re-spelled).
//
// Overlap note: `test/generator/react/extern-functions.test.ts` already pins
// the END-TO-END react emission (file paths, a string param, an aggregate
// param, the page-body call site) and the validator gates.  Nothing here
// repeats those; what is added is the unit-level table, the Svelte import
// root, DTO-import dedupe/order, the zero-arg shape, and the loud-failure
// arms — none of which any example in the repo reaches.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildExternFunctionShim,
  buildExternFunctionSignature,
} from "../../../src/generator/_frontend/extern-functions.js";
import type { PrimitiveName, TypeIR, UiFunctionIR } from "../../../src/ir/types/loom-ir.js";

const prim = (name: PrimitiveName): TypeIR => ({ kind: "primitive", name });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });

const fn = (over: Partial<UiFunctionIR> & Pick<UiFunctionIR, "name">): UiFunctionIR => ({
  params: [],
  returnType: prim("string"),
  externPath: "./helpers/x",
  ...over,
});

/** The declared `<Name>Fn` type, read back out of the emitted signature. */
const declaredTypeName = (sig: string): string | undefined => /export type (\w+) = /.exec(sig)?.[1];

/** The `(params) => ret` body of the emitted signature. */
const signatureBody = (sig: string): string | undefined =>
  /export type \w+ = (.+);\n$/.exec(sig)?.[1];

describe("buildExternFunctionSignature — the type table", () => {
  const roundTrip = (t: TypeIR): string =>
    signatureBody(buildExternFunctionSignature(fn({ name: "f", params: [{ name: "p", type: t }] })))
      ?.replace(/^\(p: /, "")
      .replace(/\) => string$/, "") ?? "";

  it("maps every supported primitive to its TS equivalent", () => {
    expect(roundTrip(prim("int"))).toBe("number");
    expect(roundTrip(prim("long"))).toBe("number");
    expect(roundTrip(prim("decimal"))).toBe("number");
    expect(roundTrip(prim("bool"))).toBe("boolean");
    expect(roundTrip(prim("string"))).toBe("string");
    expect(roundTrip(prim("datetime"))).toBe("string");
    expect(roundTrip(prim("guid"))).toBe("string");
    expect(roundTrip(prim("json"))).toBe("unknown");
  });

  it("maps `X id` and an enum to string, and wraps arrays / optionals", () => {
    expect(roundTrip({ kind: "id", targetName: "Order", valueType: "guid" })).toBe("string");
    expect(roundTrip({ kind: "enum", name: "Status" })).toBe("string");
    expect(roundTrip(arr(prim("int")))).toBe("number[]");
    expect(roundTrip(opt(prim("string")))).toBe("string | undefined");
    expect(roundTrip(opt(arr(prim("bool"))))).toBe("boolean[] | undefined");
  });

  it("ROUND-TRIPS the whole param list and the return type together", () => {
    const sig = buildExternFunctionSignature(
      fn({
        name: "score",
        params: [
          { name: "order", type: { kind: "entity", name: "Order" } },
          { name: "weight", type: prim("decimal") },
          { name: "tags", type: arr(prim("string")) },
        ],
        returnType: opt(prim("int")),
      }),
    );
    expect(signatureBody(sig)).toBe(
      "(order: OrderResponse, weight: number, tags: string[]) => number | undefined",
    );
    expect(declaredTypeName(sig)).toBe("ScoreFn");
  });

  it("emits a zero-arg signature with an empty param list", () => {
    const sig = buildExternFunctionSignature(fn({ name: "now2", returnType: prim("datetime") }));
    expect(signatureBody(sig)).toBe("() => string");
  });

  it("THROWS on a type with no wire spelling rather than emitting `any`", () => {
    expect(() =>
      buildExternFunctionSignature(fn({ name: "f", params: [{ name: "m", type: prim("money") }] })),
    ).toThrow("extern function: unsupported primitive 'money' in signature.");
    expect(() =>
      buildExternFunctionSignature(
        fn({ name: "f", params: [{ name: "v", type: { kind: "valueobject", name: "Address" } }] }),
      ),
    ).toThrow("extern function: unsupported type kind 'valueobject' in signature");
    expect(() =>
      buildExternFunctionSignature(fn({ name: "f", returnType: { kind: "slot" } })),
    ).toThrow("extern function: unsupported type kind 'slot' in signature");
  });
});

describe("buildExternFunctionSignature — DTO imports and the api root", () => {
  const twoAggs = fn({
    name: "compare",
    params: [
      { name: "a", type: { kind: "entity", name: "Order" } },
      { name: "b", type: { kind: "entity", name: "Customer" } },
      { name: "again", type: { kind: "entity", name: "Order" } },
    ],
    returnType: prim("bool"),
  });

  it("defaults the api root to react's `../../api` (relative to src/lib/extern/)", () => {
    const sig = buildExternFunctionSignature(
      fn({ name: "label", params: [{ name: "o", type: { kind: "entity", name: "Order" } }] }),
    );
    expect(sig).toContain('import type { OrderResponse } from "../../api/order";');
  });

  it("threads a SvelteKit api root through every DTO import", () => {
    const sig = buildExternFunctionSignature(
      fn({ name: "label", params: [{ name: "o", type: { kind: "entity", name: "Order" } }] }),
      "../api",
    );
    expect(sig).toContain('import type { OrderResponse } from "../api/order";');
    expect(sig).not.toContain("../../api");
  });

  it("imports each DTO ONCE, in first-seen order, and lower-cases the module segment", () => {
    const sig = buildExternFunctionSignature(twoAggs);
    const imports = [...sig.matchAll(/import type \{ (\w+) \} from "(.+?)";/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(imports).toEqual([
      ["OrderResponse", "../../api/order"],
      ["CustomerResponse", "../../api/customer"],
    ]);
  });

  it("emits no import block at all when nothing but scalars is referenced", () => {
    const sig = buildExternFunctionSignature(
      fn({ name: "initials", params: [{ name: "n", type: prim("string") }] }),
    );
    expect(sig).not.toContain("import");
    expect(sig).toMatch(/^\/\/ AUTO-GENERATED/);
  });
});

describe("buildExternFunctionShim", () => {
  it("annotates the export with the SAME type the signature declares", () => {
    const decl = fn({
      name: "orderLabel",
      params: [{ name: "o", type: { kind: "entity", name: "Order" } }],
    });
    const sig = buildExternFunctionSignature(decl);
    const shim = buildExternFunctionShim(decl);
    const typeName = declaredTypeName(sig) as string;
    // Derived, not re-spelled: the shim must reach for exactly the name the
    // signature exported, or the `const` annotation resolves to nothing.
    expect(typeName).toBe("OrderLabelFn");
    expect(shim).toContain(`import type { ${typeName} } from "./extern/orderLabel.signature";`);
    expect(shim).toContain(`export const orderLabel: ${typeName} = _impl;`);
  });

  it("imports the user's implementation by the declared function name", () => {
    const shim = buildExternFunctionShim(
      fn({ name: "initials", externPath: "./helpers/initials" }),
    );
    expect(shim).toContain('import { initials as _impl } from "../helpers/initials";');
  });

  it("normalises the extern path — a leading `./` or `/` is stripped before the `../` hop", () => {
    const hop = (externPath: string) =>
      /import \{ \w+ as _impl \} from "(.+?)";/.exec(
        buildExternFunctionShim(fn({ name: "f", externPath })),
      )?.[1];
    expect(hop("./helpers/f")).toBe("../helpers/f");
    expect(hop("helpers/f")).toBe("../helpers/f");
    expect(hop("/helpers/f")).toBe("../helpers/f");
    // Only ONE leading segment is stripped — a `../` path keeps its shape.
    expect(hop("../shared/f")).toBe("../../shared/f");
  });

  it("names the signature module after the function, matching the emitted file path", () => {
    const shim = buildExternFunctionShim(fn({ name: "score" }));
    expect(shim).toContain('from "./extern/score.signature"');
    expect(shim).toContain("Loom owns this + './extern/score.signature'");
  });
});
