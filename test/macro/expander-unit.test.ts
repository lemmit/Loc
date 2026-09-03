// Direct unit coverage of the macro EXPANDER's exported surface (M-T9.18).
//
// Every other `test/macro/` suite drives the expander end-to-end through
// `parseString` / `validate()` and asserts on the SPLICED RESULT — the fields
// `auditable` adds, the pages `scaffold` emits.  That leaves the expander's
// four exported entry points — the ones OTHER layers call directly — with no
// test that calls them:
//
//   resolveMacroArgs           ← src/language/lsp/unfold-macro.ts (coalesced `?? {}`)
//   drainMacroDiagnostics      ← src/language/validators/macros.ts
//   collectUnresolvedMacroRefs ← src/language/validators/macros.ts
//   getMacroRefDeps            ← src/language/ddd-module.ts (`isAffected`)
//
// Each has a contract its caller depends on that an end-to-end assertion
// cannot see: `resolveMacroArgs` must RETURN UNDEFINED rather than throw (the
// unfold code action coalesces it to `{}` and expands with defaults);
// `drainMacroDiagnostics` must DRAIN (a second validation pass must not
// re-report the same expansion errors); `collectUnresolvedMacroRefs` must
// report once per call site and record the provider documents `isAffected`
// re-validates on.  And the macro-origin STAMP — the `$origin` token every
// factory-built node carries — is what makes a diagnostic (and, at lowering,
// a source-map entry) resolve to the `with X(...)` call site instead of
// offset 0; nothing asserted the span it points at.
//
// Registration is process-global with no `unregister`, so — exactly as
// `misbehaving-macro-diagnostics.test.ts` does — every macro here uses a
// globally unique `__unitTest_` name and registers behind a `lookupMacro`
// guard so a re-run inside one worker cannot trip the duplicate error.

import { AstUtils, type LangiumDocument } from "langium";
import { describe, expect, it } from "vitest";
import { originFor } from "../../src/ir/lower/origin.js";
import type { Aggregate, MacroCall, Model } from "../../src/language/generated/ast.js";
import { isAggregate } from "../../src/language/generated/ast.js";
import { originOf } from "../../src/language/macro-origin.js";
import type { MacroDefinition } from "../../src/macros/api/define.js";
import { field, primType } from "../../src/macros/api/index.js";
import {
  collectUnresolvedMacroRefs,
  drainMacroDiagnostics,
  getMacroRefDeps,
  resolveMacroArgs,
} from "../../src/macros/expander.js";
import { lookupMacro, registerMacro } from "../../src/macros/registry.js";
import { parseString } from "../_helpers/parse.js";

/** Register once — the registry is process-global and throws on a duplicate. */
function ensure(def: MacroDefinition): MacroDefinition {
  if (!lookupMacro(def.name)) registerMacro(def);
  return lookupMacro(def.name)!;
}

// One param per KIND the binder supports, so the arg-binding pins below cover
// string / int-with-default / optional-ref / refList in a single call shape.
const ARGS = ensure({
  name: "__unitTest_argsMacro",
  target: "aggregate",
  apiVersion: 1,
  params: {
    label: { kind: "string" },
    count: { kind: "int", default: 7 },
    only: { kind: "ref", of: "Aggregate", optional: true },
    targets: { kind: "refList", of: "Aggregate" },
  },
  // Splices nothing: these tests bind ARGS, they don't assert on output.
  expand: () => [],
} as unknown as MacroDefinition);

// A macro that emits one factory-built member, so the `$origin` stamp the
// factories attach can be read back off a real spliced node.
const ORIGIN = ensure({
  name: "__unitTest_originMacro",
  target: "aggregate",
  apiVersion: 1,
  expand: () => [field("stampedByMacro", primType("string"))],
} as unknown as MacroDefinition);

const wrap = (body: string) => `system Demo { user { id: string  role: string } ${body} }`;

/** A two-aggregate context whose `Order` carries `with <clause>`. */
const src = (clause: string) =>
  wrap(`
    subdomain Sales {
      context Orders {
        aggregate Order with ${clause} {
          subject: string
        }
        repository Orders for Order {}
        aggregate Customer {
          nickname: string
        }
        repository Customers for Customer {}
      }
    }
  `);

function aggregate(model: Model, name: string): Aggregate {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isAggregate(node) && node.name === name) return node;
  }
  throw new Error(`aggregate ${name} not found`);
}

/** The first `with` call on `Order` — the node `resolveMacroArgs` takes. */
function callOn(model: Model, host = "Order"): MacroCall {
  const call = aggregate(model, host).withClause?.calls?.[0];
  if (!call) throw new Error(`no macro call on ${host}`);
  return call;
}

const named = (host: Aggregate, name: string): unknown =>
  (host.members ?? []).find((m) => (m as { name?: string }).name === name);

// ---------------------------------------------------------------------------
// resolveMacroArgs — the unfold code action's binder
// ---------------------------------------------------------------------------

describe("resolveMacroArgs", () => {
  it("binds named args and fills the declared default for the ones omitted", async () => {
    const { model } = await parseString(src(`__unitTest_argsMacro(label: "hello")`), {
      validate: false,
    });
    const bound = resolveMacroArgs(ARGS, callOn(model), model);
    expect(bound).toBeDefined();
    expect(bound?.label).toBe("hello");
    // `count` was never written: the `{ kind: "int", default: 7 }` spec fills it.
    expect(bound?.count).toBe(7);
    // An `optional: true` ref and an omitted refList default to undefined / [].
    expect(bound).toHaveProperty("only", undefined);
    expect(bound?.targets).toEqual([]);
  });

  it("binds by NAME, not by position — the grammar has no positional arg form", async () => {
    // `MacroArg: name=LooseName ':' value=MacroArgValue` — every argument is
    // named, so a reordered call must bind identically.
    const { model } = await parseString(src(`__unitTest_argsMacro(count: 3, label: "hello")`), {
      validate: false,
    });
    expect(resolveMacroArgs(ARGS, callOn(model), model)).toMatchObject({
      label: "hello",
      count: 3,
    });
  });

  it("resolves a `ref` / `refList` arg to the AST node it names", async () => {
    const { model } = await parseString(
      src(`__unitTest_argsMacro(label: "x", only: Customer, targets: [Customer, Order])`),
      { validate: false },
    );
    const bound = resolveMacroArgs(ARGS, callOn(model), model);
    expect(bound?.only).toBe(aggregate(model, "Customer"));
    expect(bound?.targets).toEqual([aggregate(model, "Customer"), aggregate(model, "Order")]);
  });

  it("returns undefined — never throws — when a ref arg names nothing (unfold's `?? {}`)", async () => {
    // `bindArgsForUnfold` in src/language/lsp/unfold-macro.ts does
    // `resolveMacroArgs(...) ?? {}` and expands with macro defaults.  A throw
    // here would take down the code action instead of degrading it.
    const { model } = await parseString(src(`__unitTest_argsMacro(label: "x", only: Ghost)`), {
      validate: false,
    });
    const call = callOn(model);
    let bound: Record<string, unknown> | undefined;
    expect(() => {
      bound = resolveMacroArgs(ARGS, call, model);
    }).not.toThrow();
    expect(bound).toBeUndefined();
    expect(bound ?? {}).toEqual({});
  });

  it("returns undefined for a missing required arg and for an unknown arg name", async () => {
    const missing = await parseString(src(`__unitTest_argsMacro()`), { validate: false });
    expect(resolveMacroArgs(ARGS, callOn(missing.model), missing.model)).toBeUndefined();

    const unknown = await parseString(src(`__unitTest_argsMacro(label: "x", nope: 1)`), {
      validate: false,
    });
    expect(resolveMacroArgs(ARGS, callOn(unknown.model), unknown.model)).toBeUndefined();
  });

  it("records NO diagnostics of its own — it is the silent binder", async () => {
    const { model, doc } = await parseString(src(`__unitTest_argsMacro(label: "x", only: Ghost)`), {
      validate: false,
    });
    drainMacroDiagnostics(doc as LangiumDocument); // clear whatever expansion left
    resolveMacroArgs(ARGS, callOn(model), model);
    expect(drainMacroDiagnostics(doc as LangiumDocument)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// drainMacroDiagnostics — must DRAIN
// ---------------------------------------------------------------------------

describe("drainMacroDiagnostics", () => {
  it("returns the expansion diagnostics once, then empties the side table", async () => {
    // Parsed WITHOUT validation, so `checkMacroExpansion` has not already
    // drained the document — the expander's IndexedContent pass still ran.
    const { doc } = await parseString(src(`__unitTest_thereIsNoSuchMacro`), { validate: false });
    const first = drainMacroDiagnostics(doc as LangiumDocument);
    expect(first.map((d) => d.code)).toContain("loom.unknown-macro");
    expect(first[0]?.severity).toBe("error");

    // THE PIN: a second drain is empty.  The validator runs per (re)validation;
    // if the side table were merely read, every re-validation would re-report
    // the same expansion error and they would accumulate in the editor.
    expect(drainMacroDiagnostics(doc as LangiumDocument)).toEqual([]);
    expect(drainMacroDiagnostics(doc as LangiumDocument)).toEqual([]);
  });

  it("returns [] for a document that never recorded anything", async () => {
    const { doc } = await parseString(src(`__unitTest_originMacro`), { validate: false });
    expect(drainMacroDiagnostics(doc as LangiumDocument)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectUnresolvedMacroRefs — the validation-time re-check
// ---------------------------------------------------------------------------

describe("collectUnresolvedMacroRefs", () => {
  it("reports an unresolvable ref arg exactly once per call site, and is repeatable", async () => {
    const { model } = await parseString(src(`__unitTest_argsMacro(label: "x", only: Ghost)`), {
      validate: false,
    });
    const run = () => {
      const seen: { code: string; message: string }[] = [];
      collectUnresolvedMacroRefs(model, undefined, (d) => seen.push(d));
      return seen;
    };
    const first = run();
    expect(first).toHaveLength(1);
    expect(first[0]?.code).toBe("loom.macro-arg-unresolved-ref");
    expect(first[0]?.message).toContain("Ghost");
    // Unlike `drainMacroDiagnostics` this one is a RE-CHECK, not a drain: it
    // runs on every (re)validation and must report the same thing every time.
    expect(run()).toEqual(first);
  });

  it("reports one diagnostic per unresolvable refList ELEMENT", async () => {
    const { model } = await parseString(
      src(`__unitTest_argsMacro(label: "x", targets: [Customer, Ghost, Phantom])`),
      { validate: false },
    );
    const seen: { message: string }[] = [];
    collectUnresolvedMacroRefs(model, undefined, (d) => seen.push(d));
    expect(seen).toHaveLength(2);
    expect(seen.map((d) => d.message).join(" ")).toMatch(/Ghost/);
    expect(seen.map((d) => d.message).join(" ")).toMatch(/Phantom/);
  });

  it("stays silent when every ref resolves", async () => {
    const { model } = await parseString(
      src(`__unitTest_argsMacro(label: "x", only: Customer, targets: [Order])`),
      { validate: false },
    );
    const seen: unknown[] = [];
    collectUnresolvedMacroRefs(model, undefined, (d) => seen.push(d));
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getMacroRefDeps — what `isAffected` re-validates on
// ---------------------------------------------------------------------------

describe("getMacroRefDeps", () => {
  it("records the documents the resolved refs came from", async () => {
    const { model, doc } = await parseString(
      src(`__unitTest_argsMacro(label: "x", only: Customer)`),
      { validate: false },
    );
    collectUnresolvedMacroRefs(model, undefined, () => {});
    const deps = getMacroRefDeps(doc as LangiumDocument);
    expect(deps?.unresolved).toBe(false);
    // `Customer` is declared in this same document, so it is its own provider —
    // the URI `DddIndexManager.isAffected` watches for changes.
    expect([...(deps?.providers ?? [])]).toEqual([doc.uri.toString()]);
  });

  it("flags `unresolved` so isAffected retries the host on ANY workspace change", async () => {
    const { model, doc } = await parseString(src(`__unitTest_argsMacro(label: "x", only: Ghost)`), {
      validate: false,
    });
    collectUnresolvedMacroRefs(model, undefined, () => {});
    expect(getMacroRefDeps(doc as LangiumDocument)?.unresolved).toBe(true);
  });

  it("is undefined for a document that was never re-checked", async () => {
    const { doc } = await parseString(src(`__unitTest_originMacro`), { validate: false });
    expect(getMacroRefDeps(doc as LangiumDocument)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Macro-origin stamping — the span a synthesised node reports
// ---------------------------------------------------------------------------

describe("macro-origin stamping", () => {
  it("tags a synthesised member with a token pointing at the `with` CALL SITE", async () => {
    const text = src(`__unitTest_originMacro`);
    const { model } = await parseString(text, { validate: false });
    const stamped = named(aggregate(model, "Order"), "stampedByMacro");
    expect(stamped).toBeDefined();

    const token = originOf(stamped);
    expect(token?._kind).toBe("macro-origin");
    expect(token?.macroName).toBe(ORIGIN.name);
    expect(token?.callNode).toBe(callOn(model));

    // THE PIN: the recorded span is the macro call site in the USER'S source,
    // not offset 0 and not the synthesised node (which has no CST at all).
    const ref = originFor(stamped as never);
    expect(ref?.kind).toBe("macro");
    const call = (ref as { call?: { path: string; span: { start: number; end: number } } }).call;
    expect(call).toBeDefined();
    expect(call?.span.start).toBeGreaterThan(0);
    expect(text.slice(call?.span.start, call?.span.end)).toBe("__unitTest_originMacro");
  });

  it("reports the same origin for a node nested inside a synthesised member", async () => {
    // `originOf` walks the `$container` chain, so the `TypeRef` hanging off the
    // synthesised property resolves to the same call site.
    const { model } = await parseString(src(`__unitTest_originMacro`), { validate: false });
    const stamped = named(aggregate(model, "Order"), "stampedByMacro") as { type?: unknown };
    expect(originOf(stamped.type)?.callNode).toBe(callOn(model));
  });

  it("leaves a hand-written member unstamped — its origin is its own CST span", async () => {
    const text = src(`__unitTest_originMacro`);
    const { model } = await parseString(text, { validate: false });
    const subject = named(aggregate(model, "Order"), "subject");
    expect(originOf(subject)).toBeUndefined();
    const ref = originFor(subject as never);
    expect(ref?.kind).toBe("source");
  });
});
