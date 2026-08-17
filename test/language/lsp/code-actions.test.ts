// ---------------------------------------------------------------------------
// DddCodeActionProvider ← the fix-hint provider registry.
//
// The provider no longer hand-rolls a `switch` over diagnostic codes: every
// repair comes from `src/language/fix-hints.ts` as a node-addressed
// `ModelPatch`, resolved to LSP `TextEdit`s.  These tests drive the real
// provider (parse → validate → feed the diagnostics in) and assert the
// RESULTING SOURCE after applying the returned edits, so a fix that resolves to
// the wrong range fails here rather than looking green because an action exists.
// ---------------------------------------------------------------------------

import { NodeFileSystem } from "langium/node";
import { validationHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import type { CodeAction, Diagnostic, TextEdit } from "vscode-languageserver";
import { createDddServices } from "../../../src/language/ddd-module.js";

const services = createDddServices(NodeFileSystem);
const validate = validationHelper(services.Ddd);

/** Parse + validate `text`, then ask the provider for the quick fixes its
 *  diagnostics earn (cursor parked at 0:0, so no macro-unfold refactors). */
async function quickFixes(text: string): Promise<{
  actions: CodeAction[];
  diagnostics: Diagnostic[];
  apply: (a: CodeAction) => string;
}> {
  const result = await validate(text);
  const document = result.document;
  const uri = document.textDocument.uri;
  const actions = ((await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: result.diagnostics },
  })) ?? []) as CodeAction[];
  return {
    actions: actions.filter((a) => a.kind === "quickfix"),
    diagnostics: result.diagnostics,
    apply: (a: CodeAction) =>
      applyEdits(
        text,
        a.edit?.changes?.[uri] ?? [],
        document.textDocument.offsetAt.bind(document.textDocument),
      ),
  };
}

function applyEdits(
  text: string,
  edits: TextEdit[],
  offsetAt: (p: { line: number; character: number }) => number,
): string {
  const resolved = edits
    .map((e) => ({ start: offsetAt(e.range.start), end: offsetAt(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

describe("DddCodeActionProvider quick fixes (via the fix-hint registry)", () => {
  it("fixes a bare cross-aggregate reference to `X id`", async () => {
    const before = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;
    const { actions, apply } = await quickFixes(before);
    const fix = actions.find((a) => a.diagnostics?.[0]?.code === "loom.bare-aggregate-in-type");
    expect(
      fix,
      `no quick fix for the bare reference; got: ${actions.map((a) => a.title).join(", ")}`,
    ).toBeDefined();
    expect(fix?.isPreferred).toBe(true);
    // The RESULTING SOURCE, not merely the presence of an action.
    expect(apply(fix!)).toBe(`context Sales {
  aggregate Order { customer: Customer id }
  aggregate Customer { name: string }
}
`);
  });

  it("fixes a bare collection reference to `X id[]`", async () => {
    const before = `context Sales {
  aggregate Order { lines: OrderLine[] }
  aggregate OrderLine { qty: int }
}
`;
    const { actions, apply } = await quickFixes(before);
    const fix = actions.find((a) => a.diagnostics?.[0]?.code === "loom.bare-aggregate-in-type");
    expect(fix).toBeDefined();
    expect(apply(fix!)).toContain("lines: OrderLine id[]");
  });

  // `missingUiFix`'s multi-option path: two system-scope `ui { … }` blocks, so
  // binding one is a genuine CHOICE — the hint is `kind: "choose"` and each
  // option must become its own action.
  it("expands a `choose` hint into one action per option", async () => {
    const before = `system Shop {
  context Orders {
    aggregate Order { name: string }
    repository Orders for Order { }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api ShopApi from Orders
  ui Admin {
    area Back {
      page AdminBoard {
        route: "/admin"
        body: Text { "admin" }
      }
    }
  }
  ui Storefront {
    area Front {
      page Shelf {
        route: "/shelf"
        body: Text { "shelf" }
      }
    }
  }
  deployable honoApi { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable webApp { platform: react targets: honoApi port: 3001 }
}
`;
    const { actions, diagnostics, apply } = await quickFixes(before);
    expect(
      diagnostics.map((d) => d.code),
      "fixture must raise the missing-ui diagnostic the choose hint keys off",
    ).toContain("loom.react-deployable-missing-ui");

    const choose = actions.filter(
      (a) => a.diagnostics?.[0]?.code === "loom.react-deployable-missing-ui",
    );
    expect(
      choose.map((a) => a.title),
      "two declared ui blocks → two options, neither preferred",
    ).toEqual(["ui: Admin", "ui: Storefront"]);
    for (const a of choose) expect(a.isPreferred).toBeUndefined();

    // Each option's edits apply cleanly and bind the ui it names.
    const admin = apply(choose[0]!);
    expect(admin).toContain("ui: Admin");
    expect(admin).toContain("platform: react");
    const storefront = apply(choose[1]!);
    expect(storefront).toContain("ui: Storefront");

    // …and the chosen binding actually clears the diagnostic.
    const after = await validate(admin);
    expect(after.diagnostics.map((d) => d.code)).not.toContain(
      "loom.react-deployable-missing-ui",
    );
  });

  it("offers nothing for a diagnostic with no registered fix hint", async () => {
    // `loom.ui-framework-unhostable` has no provider (its repair is ambiguous),
    // and the removed `loom.framework-mismatch` arm never existed as a code.
    const { actions } = await quickFixes(`context Sales {
  aggregate Order { total: nosuchtype }
}
`);
    expect(actions).toEqual([]);
  });
});
