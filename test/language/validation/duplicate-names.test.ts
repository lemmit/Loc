// Duplicate-name validator family (full-review remediation §B4, audit
// finding 10).  The grammar admits sibling declarations sharing a name; the
// last silently won and the earlier ones vanished (a duplicate `aggregate
// Order` dropped the first's fields; `total: money` + `total: string`
// retyped the field; duplicate params / event fields / VO fields / enum
// values all passed).  These gates close the class — see
// `src/language/validators/duplicates.ts`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const parse = (source: string) => parseString(source);

describe("validator: duplicate names — negatives", () => {
  it("flags a duplicate aggregate name within a context (loom.duplicate-context-type)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { total: money  code: string }
        aggregate Order { name: string }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate declaration 'Order' in context 'C'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a value-object / event / enum sharing a name with an aggregate in one context", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Thing { a: int }
        valueobject Thing { b: int }
        event Thing { c: int }
        enum Thing { X }
      } } }
    `);
    // Three later declarations collide with the first `Thing`.
    const hits = errors.filter((e) => /Duplicate declaration 'Thing' in context 'C'/.test(e));
    expect(hits.length, errors.join("\n")).toBe(3);
  });

  it("flags a duplicate property name within an aggregate (loom.duplicate-field)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { total: money  total: string }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate field 'total' in aggregate 'Order'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a containment colliding with a property (shared field namespace)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order {
          lines: int
          entity Line { a: int }
          contains lines: Line[]
        }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate field 'lines' in aggregate 'Order'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate value-object field", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        valueobject V { a: int  a: string }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate field 'a' in value object 'V'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate event field", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        event E { at: datetime  at: int }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate field 'at' in event 'E'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate operation parameter (loom.duplicate-parameter)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { total: money  operation foo(x: int, x: string) { } }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate parameter 'x' in operation 'foo'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate function parameter", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { total: money  function f(y: int, y: int): int = 0 }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate parameter 'y' in function 'f'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate create parameter", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { total: money  create(z: int, z: int) { } }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate parameter 'z' in create/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate enum value (loom.duplicate-enum-value)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        enum Color { Red, Green, Red }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate value 'Red' in enum 'Color'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});

// Application-layer handler names share one route-target namespace with
// workflow `handle`s (unfoldable-api-derivation.md, Layers 3-4): a
// `route -> Context.<name>` resolves the bare name against their union, so a
// collision silently deduplicates and the route dispatches ambiguously.
describe("validator: duplicate handler names — negatives (loom.duplicate-handler)", () => {
  it("flags two commandHandlers sharing a name in one context", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { code: string }
        commandHandler Place(code: string) { }
        commandHandler Place(code: string) { }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate handler 'Place' in context 'C'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a commandHandler and queryHandler sharing a name", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { code: string }
        commandHandler Foo(code: string) { }
        queryHandler Foo(code: string): Order { }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate handler 'Foo' in context 'C'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a commandHandler colliding with a workflow handle name", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { code: string }
        workflow W { handle Ship(code: string) { } }
        commandHandler Ship(code: string) { }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate handler 'Ship' in context 'C'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("flags a duplicate commandHandler / queryHandler parameter (loom.duplicate-parameter)", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { code: string }
        commandHandler Foo(x: int, x: int) { }
        queryHandler Bar(y: int, y: int): Order { }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate parameter 'x' in commandHandler 'Foo'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
    expect(
      errors.some((e) => /Duplicate parameter 'y' in queryHandler 'Bar'/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });
});

describe("validator: duplicate names — positives", () => {
  it("allows a commandHandler and queryHandler with distinct names; two workflows may reuse a handle name", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        aggregate Order { code: string }
        commandHandler Place(code: string) { }
        queryHandler Get(code: string): Order { }
        workflow W1 { handle confirm(code: string) { } }
        workflow W2 { handle confirm(code: string) { } }
      } } }
    `);
    // The explicit handlers don't collide; workflow-handle reuse across
    // workflows is not newly policed by loom.duplicate-handler.
    expect(
      errors.some((e) => /Duplicate handler/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("allows the same aggregate name in different contexts", async () => {
    const { errors } = await parse(`
      system S { subdomain M {
        context C1 { aggregate Order { total: money } }
        context C2 { aggregate Order { name: string } }
      } }
    `);
    expect(
      errors.some((e) => /Duplicate declaration 'Order'/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });

  it("allows distinct field / param / value names", async () => {
    const { errors } = await parse(`
      system S { subdomain M { context C {
        enum Color { Red, Green, Blue }
        aggregate Order {
          total: money
          code: string
          derived label: string = code
          operation foo(x: int, y: string) { }
        }
      } } }
    `);
    expect(
      errors.some((e) => /Duplicate (field|parameter|value|declaration)/.test(e)),
      errors.join("\n"),
    ).toBe(false);
  });
});
