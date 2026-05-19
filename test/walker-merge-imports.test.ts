// Regression coverage for `mergeNamedImportLines` — the textual
// import-block deduper in `body-walker.ts` that runs over the
// concatenated raw form-wiring blocks (one `form-of-imports.hbs`
// /`form-runs-imports.hbs`/`form-op-imports.hbs` render per
// FormBinding).
//
// Why this is tested explicitly: the realistic failure modes are
// non-obvious because identical raw `import` lines are LEGAL TS
// (idempotent), but two lines from the same module with
// *overlapping* named specifiers are a TS2300 "duplicate
// identifier" hard error.  This happens in practice on a
// scaffolded aggregate Detail page that hosts ≥2 operation modals
// where some op uses RHF `Controller` (Id<X>/enum/datetime/etc.
// fields) and another doesn't — the per-op `form-op-imports.hbs`
// renders `import { useForm, Controller } from "react-hook-form";`
// for one and `import { useForm } from "react-hook-form";` for
// the other.  Both contain `useForm`; without the merger the
// generated module fails to compile.
//
// The merger also runs on single-form pages (every Form(of:)
// create page, every Form(runs:) workflow page) where it must
// pass through byte-identical so the React baseline fixture is
// unaffected — exercised by the page-emitter-equivalence test on
// real fixtures, locked structurally here as the single-line
// passthrough case.

import { describe, expect, it } from "vitest";
import { mergeNamedImportLines } from "../src/generator/react/body-walker.js";

describe("mergeNamedImportLines", () => {
  it("passes through a single-line block byte-identical (create/workflow page)", () => {
    const block =
      `import { useForm } from "react-hook-form";\n` +
      `import { zodResolver } from "@hookform/resolvers/zod";\n` +
      `import { CreateOrderRequest, useCreateOrder } from "../../api/order";\n`;
    expect(mergeNamedImportLines(block)).toBe(block);
  });

  it("merges RHF Controller-vary across ops into one declaration", () => {
    // The original TS2300 trigger: op1 uses Controller (e.g.
    // Id<X> select); op2 doesn't.  Both import `useForm` from
    // the same module → duplicate identifier without merge.
    const block =
      `import { useForm, Controller } from "react-hook-form";\n` +
      `import { useForm } from "react-hook-form";\n`;
    const merged = mergeNamedImportLines(block);
    // Exactly one RHF import line; Controller present; useForm
    // not duplicated.
    const rhfLines = merged
      .split("\n")
      .filter((l) => /from "react-hook-form"/.test(l));
    expect(rhfLines.length).toBe(1);
    expect(rhfLines[0]).toBe(
      `import { useForm, Controller } from "react-hook-form";`,
    );
  });

  it("unions disjoint same-module specifiers (per-op api lines)", () => {
    // Two ops on the same aggregate each render their own
    // `<Op>Request` + `use<Op><Agg>` from "../../api/<agg>" —
    // disjoint names, same module.  Single import statement is
    // semantically cleaner than two; the merge unions them.
    const block =
      `import { AddLineRequest, useAddLineOrder } from "../../api/order";\n` +
      `import { ConfirmRequest, useConfirmOrder } from "../../api/order";\n`;
    expect(mergeNamedImportLines(block)).toBe(
      `import { AddLineRequest, useAddLineOrder, ConfirmRequest, useConfirmOrder } from "../../api/order";\n`,
    );
  });

  it("deduplicates identical specifiers (per-op idTarget hooks)", () => {
    // Two ops both reference Id<Product> → both render
    // `import { useAllProducts } from "../../api/product";`.
    // Identical lines are legal TS but ugly; the merge collapses
    // them to one occurrence.
    const block =
      `import { useAllProducts } from "../../api/product";\n` +
      `import { useAllProducts } from "../../api/product";\n`;
    const out = mergeNamedImportLines(block);
    expect(
      out.split("\n").filter((l) => /useAllProducts/.test(l)).length,
    ).toBe(1);
    expect(out).toContain(
      `import { useAllProducts } from "../../api/product";`,
    );
  });

  it("preserves first-seen module order across modules", () => {
    // Module order matters for deterministic generator output;
    // the merge MUST keep the position of each module's first
    // occurrence stable.
    const block =
      `import { useForm } from "react-hook-form";\n` +
      `import { zodResolver } from "@hookform/resolvers/zod";\n` +
      `import { useForm, Controller } from "react-hook-form";\n`;
    const merged = mergeNamedImportLines(block).split("\n");
    const rhfIdx = merged.findIndex((l) =>
      /from "react-hook-form"/.test(l),
    );
    const zodIdx = merged.findIndex((l) =>
      /@hookform\/resolvers\/zod/.test(l),
    );
    expect(rhfIdx).toBeGreaterThanOrEqual(0);
    expect(zodIdx).toBeGreaterThan(rhfIdx);
  });

  it("passes non-named-import lines through unchanged in place", () => {
    // Blank lines, side-effect imports, and default imports
    // don't match the named-import regex and must pass through.
    const block =
      `\n` +
      `import "@mantine/core/styles.css";\n` +
      `import React from "react";\n` +
      `import { useForm } from "react-hook-form";\n`;
    expect(mergeNamedImportLines(block)).toBe(block);
  });

  it("handles a mixed realistic multi-op block (full integration)", () => {
    // The detail-page emission for an aggregate with two public
    // ops where op1 has an Id<X> param (Controller) and op2 has
    // no params.  Same shape as the Order detail page on
    // acme.ddd (addLine + confirm).
    const block =
      `import { useForm, Controller } from "react-hook-form";\n` +
      `import { zodResolver } from "@hookform/resolvers/zod";\n` +
      `import { AddLineRequest, useAddLineOrder } from "../../api/order";\n` +
      `import { useAllProducts } from "../../api/product";\n` +
      `import { notifications } from "@mantine/notifications";\n` +
      `import { modals } from "@mantine/modals";\n` +
      `import { useForm } from "react-hook-form";\n` +
      `import { zodResolver } from "@hookform/resolvers/zod";\n` +
      `import { ConfirmRequest, useConfirmOrder } from "../../api/order";\n` +
      `import { notifications } from "@mantine/notifications";\n` +
      `import { modals } from "@mantine/modals";\n`;
    const merged = mergeNamedImportLines(block);
    // Each module appears exactly once.
    for (const mod of [
      "react-hook-form",
      "@hookform/resolvers/zod",
      "../../api/order",
      "../../api/product",
      "@mantine/notifications",
      "@mantine/modals",
    ]) {
      const occurrences = merged
        .split("\n")
        .filter((l) => new RegExp(`from "${escapeRe(mod)}"`).test(l)).length;
      expect(occurrences, `module ${mod} appears once`).toBe(1);
    }
    // RHF carries Controller; api line carries all 4 specifiers.
    expect(merged).toContain(
      `import { useForm, Controller } from "react-hook-form";`,
    );
    expect(merged).toContain(
      `import { AddLineRequest, useAddLineOrder, ConfirmRequest, useConfirmOrder } from "../../api/order";`,
    );
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
