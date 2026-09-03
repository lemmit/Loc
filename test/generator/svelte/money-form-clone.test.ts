// Behavioural test for the emitted `cloneDefaults` in `web/src/lib/forms.svelte.ts`.
//
// M-T1.24 seam 1 (numeric-types audit F4).  `createForm` used to seed its
// `$state` with `structuredClone(defaults)`, which drops the PROTOTYPE off class
// instances.  A `money` default is `new Decimal("0")` — after the clone it was a
// prototype-less bag: the input rendered `[object Object]`, and an untouched
// default could never satisfy the money schema (`Decimal | decimal-string`).
//
// The replacement copies arrays and PLAIN objects only, carrying everything else
// (class instances, dates, primitives, null) by reference — safe because form
// inputs REPLACE those values rather than mutating them, and it needs no
// `decimal.js` import in a runtime file that money-free projects also emit.
//
// The function is sliced out of the emitted source, transpiled and EXECUTED, so
// the fix is pinned by semantics rather than by matching text.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SVELTE_LIB_FORMS } from "../../../src/generator/svelte/emit-templates.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Stand-in for decimal.js (not a dependency of the toolchain repo) — the clone
 *  only has to leave the prototype (and therefore `toString`) intact. */
class FakeDecimal {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Slice `function cloneDefaults<T>(...) { … }` out of the emitted module by
 *  brace-matching (the rest of the file is Svelte-rune source that no plain TS
 *  transpile could evaluate). */
function sliceCloneDefaults(src: string): string {
  const start = src.indexOf("function cloneDefaults");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seen = true;
    } else if (src[i] === "}") {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unterminated cloneDefaults");
}

function loadClone(src: string): <T>(v: T) => T {
  const js = ts.transpileModule(sliceCloneDefaults(src), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(`${js}\nreturn cloneDefaults;`)() as <T>(v: T) => T;
}

describe("svelte createForm defaults cloning", () => {
  const clone = loadClone(SVELTE_LIB_FORMS);

  it("preserves the prototype of a class instance (the money seed)", () => {
    const d = new FakeDecimal("0");
    const out = clone(d);
    expect(out).toBeInstanceOf(FakeDecimal);
    expect(String(clone(new FakeDecimal("1.5")))).toBe("1.5");
    expect(String(clone(new FakeDecimal("1.5")))).not.toBe("[object Object]");
  });

  it("preserves a class instance nested inside a plain-object default", () => {
    const seed = { price: new FakeDecimal("12.3400"), name: "widget" };
    const out = clone(seed);
    expect(out.price).toBeInstanceOf(FakeDecimal);
    expect(String(out.price)).toBe("12.3400");
  });

  it("deep-copies plain objects so a fresh form never mutates the seed", () => {
    const seed = { nested: { a: 1 }, list: [{ b: 2 }] };
    const out = clone(seed);
    out.nested.a = 99;
    out.list[0]!.b = 99;
    out.list.push({ b: 3 });
    expect(seed.nested.a).toBe(1);
    expect(seed.list[0]!.b).toBe(2);
    expect(seed.list).toHaveLength(1);
  });

  it("carries null, undefined and primitives through unchanged", () => {
    expect(clone(null)).toBeNull();
    expect(clone(undefined)).toBeUndefined();
    expect(clone("x")).toBe("x");
    expect(clone(0)).toBe(0);
    expect(clone(false)).toBe(false);
    expect(clone({ a: null, b: undefined })).toEqual({ a: null, b: undefined });
  });

  it("emits the prototype-preserving clone (and no structuredClone) into the project", async () => {
    const files = await generateSystemFiles(`
system Shop {
  api ShopApi from Sales
  subdomain Sales {
    context Ordering {
      aggregate Invoice with crudish { reference: string  total: money }
      repository Invoices for Invoice { }
    }
  }
  storage db { type: postgres }
  resource ordState { for: Ordering, kind: state, use: db }
  ui WebApp with scaffold(subdomains: [Sales]) { api Shop: ShopApi }
  deployable api { platform: node contexts: [Ordering] dataSources: [ordState] serves: ShopApi port: 3000 }
  deployable web { platform: svelte targets: api ui: WebApp { Shop: api } port: 3005 }
}
`);
    const forms = [...files.entries()].find(([p]) => p.endsWith("lib/forms.svelte.ts"))![1];
    // No CALL survives (the doc comment still names it to explain why).
    expect(forms).not.toContain("structuredClone(");
    expect(forms).toContain("cloneDefaults(defaults)");
    // The runtime file must not depend on decimal.js — money-free projects
    // emit it too, and the clone works by prototype identity, not by type.
    expect(forms).not.toContain("decimal.js");
  });
});
