import { describe, expect, it } from "vitest";
import {
  applyPatches,
  fixHintCodeActions,
  toLspDiagnostics,
  validate,
} from "../../src/api/index.js";

// ---------------------------------------------------------------------------
// LSP / editor adapters (src/api/lsp.ts) — the thin boundary that makes the
// toolkit's ModelPatch / JsonDiagnostic recognizable to Monaco & VS Code.
// ---------------------------------------------------------------------------

const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}
`;

// A react deployable with no `ui:` binding and TWO system-scope `ui { … }`
// blocks — `missingUiFix`'s ambiguous path, which yields `kind: "choose"`.
const CHOOSE = `system Shop {
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

/** Apply LSP TextEdits to a source (line/char → offset, end-to-start). */
function applyTextEdits(
  source: string,
  edits: {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    newText: string;
  }[],
): string {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: { line: number; character: number }) => lineStarts[p.line]! + p.character;
  let text = source;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
    text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  }
  return text;
}

describe("LSP adapters", () => {
  it("toLspDiagnostics maps a coded diagnostic to an LSP Diagnostic", async () => {
    const report = await validate(BARE);
    const diags = toLspDiagnostics(report);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    const bare = diags.find((d) => d.code === "loom.bare-aggregate-in-type");
    expect(bare?.severity).toBe(1); // DiagnosticSeverity.Error
    expect(bare?.source).toBe("loom");
    expect(bare?.range).toBeDefined();
  });

  it("fixHintCodeActions yields a quick-fix whose WorkspaceEdit fixes the model", async () => {
    const report = await validate(BARE);
    const actions = await fixHintCodeActions(report, BARE, "file:///m.ddd");

    const fix = actions.find((a) => a.kind === "quickfix");
    expect(fix).toBeDefined();
    expect(fix?.diagnostics?.[0]?.code).toBe("loom.bare-aggregate-in-type");

    const edits = fix?.edit?.changes?.["file:///m.ddd"];
    expect(edits?.length).toBe(1);
    expect(edits?.[0]?.newText).toBe("customer: Customer id");

    // Applying the editor edit yields a model that re-validates clean.
    const fixed = applyTextEdits(BARE, edits ?? []);
    const after = await validate(fixed);
    expect(after.ok).toBe(true);

    // …and it matches what the patch applier produces from the same patch.
    const viaPatch = await applyPatches(BARE, [report.diagnostics[0]!.fixHint!.patch!]);
    expect(fixed).toBe(viaPatch.text);
  });

  it("fixHintCodeActions expands a `choose` hint into one action per option", async () => {
    const report = await validate(CHOOSE);
    const hint = report.diagnostics.find(
      (d) => d.code === "loom.react-deployable-missing-ui",
    )?.fixHint;
    expect(hint?.kind, "fixture must produce the multi-option `choose` hint").toBe("choose");
    expect(hint?.options?.length).toBe(2);

    const actions = await fixHintCodeActions(report, CHOOSE, "file:///m.ddd");
    const choose = actions.filter(
      (a) => a.diagnostics?.[0]?.code === "loom.react-deployable-missing-ui",
    );
    expect(choose.map((a) => a.title)).toEqual(["ui: Admin", "ui: Storefront"]);
    // No single right answer → nothing is marked preferred.
    for (const a of choose) expect(a.isPreferred).toBeUndefined();

    // Each option's WorkspaceEdit applies cleanly and binds the ui it names.
    for (const [i, name] of ["Admin", "Storefront"].entries()) {
      const edits = choose[i]?.edit?.changes?.["file:///m.ddd"] ?? [];
      expect(edits.length).toBe(1);
      const applied = applyTextEdits(CHOOSE, edits);
      expect(applied).toContain(`ui: ${name}`);
      expect(applied).toBe(
        (await applyPatches(CHOOSE, [hint!.options![i]!.patch!])).text,
        "editor edit must match the patch applier for the same option",
      );
    }
  });
});
