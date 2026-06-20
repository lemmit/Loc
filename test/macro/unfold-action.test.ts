// Unfold code action: when the cursor sits on `with X(...)`, the
// refactor replaces the macro call with its expanded source.
// Combined with the structural printer's roundtrip guarantees, the
// unfolded source re-parses to identical IR.

import { NodeFileSystem } from "langium/node";
import { validationHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import type { CodeAction, Position, TextEdit } from "vscode-languageserver";
import { createDddServices } from "../../src/language/ddd-module.js";

const services = createDddServices(NodeFileSystem);
const validate = validationHelper(services.Ddd);

/** Locate the position of the first occurrence of `marker` in
 * `source`, returning an LSP Position (line/character).  Used to
 * point the code-action `range` at a specific macro name. */
function positionOf(source: string, marker: string): Position {
  const offset = source.indexOf(marker);
  if (offset < 0) throw new Error(`marker "${marker}" not found`);
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

/** Apply LSP TextEdits to a source string. */
function applyEdits(text: string, edits: TextEdit[]): string {
  // Sort edits descending by start offset so we don't shift earlier
  // ranges when applying later ones.
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });
  let out = text;
  for (const e of sorted) {
    const start = offsetOf(text, e.range.start);
    const end = offsetOf(text, e.range.end);
    out = out.slice(0, start) + e.newText + out.slice(end);
    text = out; // refresh reference for next iteration
  }
  return out;
}

function offsetOf(text: string, pos: Position): number {
  let offset = 0;
  let line = 0;
  for (let i = 0; i < text.length && line < pos.line; i++) {
    if (text[i] === "\n") line++;
    offset = i + 1;
  }
  return offset + pos.character;
}

async function unfold(source: string, macroNameInSource: string): Promise<string> {
  const result = await validate(source);
  const document = result.document;
  const pos = positionOf(source, macroNameInSource);
  const actions = (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri: document.textDocument.uri },
    range: { start: pos, end: pos },
    context: { diagnostics: [] },
  })) as CodeAction[];
  const action = actions.find((a) => a.title.startsWith("Unfold macro"));
  if (!action) {
    throw new Error(`no unfold action; got: ${actions.map((a) => a.title).join(", ")}`);
  }
  const edits = action.edit?.changes?.[document.textDocument.uri] ?? [];
  return applyEdits(source, edits);
}

describe("unfold code action", () => {
  // NOTE: `softDeletable`/`auditable` are now built-in capabilities (not macros),
  // so the unfold code action — which expands macro calls — no longer targets
  // them; unfolding a typed capability is a Phase 5 (LSP) concern.  `softDelete`
  // (the operations) is still a macro and unfolds.  Clause order is
  // `softDelete, softDeletable` so the marker search lands on the standalone
  // `softDelete` and not the `softDelete` inside `softDeletable`.

  it("offers an `Unfold macro 'softDelete'` refactor that materializes the operations", async () => {
    const source = `
context Sales {
  aggregate Order with softDelete, softDeletable {
    subject: string
  }
  repository Orders for Order { }
}
`;
    const unfolded = await unfold(source, "softDelete");
    // The softDelete macro call is gone; the capability remains:
    expect(unfolded).toMatch(/with softDeletable/);
    expect(unfolded).not.toMatch(/softDelete,/);
    // Operations materialized into the aggregate body:
    expect(unfolded).toMatch(/operation softDelete/);
    expect(unfolded).toMatch(/operation restore/);
  });

  it("re-parses to a working program after unfold", async () => {
    const source = `
context Sales {
  aggregate Order with softDelete, softDeletable {
    subject: string
  }
  repository Orders for Order { }
}
`;
    const unfolded = await unfold(source, "softDelete");
    const reparseResult = await validate(unfolded);
    const errors = reparseResult.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
  });

  it("threads ref-list args through unfold (scaffold with modules: [Sales])", async () => {
    // Regression: pre-fix, unfold ran the macro with empty `{}`
    // args, so `scaffold(subdomains: [Sales])` recorded no invocations.
    // After the resolveMacroArgs wiring + the scaffold-family
    // refactor, the top-level macro fans `scaffoldSubdomain(of: Sales)`
    // via `invokeMacro` — which the one-level unfold turns into a
    // `with scaffoldSubdomain(of: Sales)` clause on the ui.
    const source = `
system Demo {
  subdomain Sales {
    context S {
      aggregate Order {
        subject: string
      }
      repository Orders for Order { }
    }
  }
  ui Admin with scaffold(subdomains: [Sales]) { }
}
`;
    const unfolded = await unfold(source, "scaffold");
    // The composer call is gone, replaced by the per-module child:
    expect(unfolded).not.toMatch(/with scaffold\(/);
    expect(unfolded).toMatch(/with scaffoldSubdomain\(of: Sales\)/);
    // The shared index pages (direct emissions) get inlined:
    expect(unfolded).toMatch(/page Home/);
    // NOT flattened all the way — per-aggregate pages stay opaque
    // behind the scaffoldSubdomain call; users drill further if they
    // want the OrderList/OrderDetail breakdown.
    expect(unfolded).not.toMatch(/page OrderList/);
    expect(unfolded).not.toMatch(/page OrderDetail/);
  });

  it("scaffold composability lets users drill to single-aggregate granularity", async () => {
    // Three-level drill: scaffold(subdomains: [Sales]) →
    // scaffoldSubdomain(of: Sales) → scaffoldContext(of: S) →
    // scaffoldAggregate(of: Order) → raw page declarations.  Proves
    // the composer chain lets users materialise just one aggregate's
    // scaffold while leaving the rest of the UI under macros.
    const source = `
system Demo {
  subdomain Sales {
    context S {
      aggregate Order {
        subject: string
      }
      repository Orders for Order { }
    }
  }
  ui Admin with scaffold(subdomains: [Sales]) { }
}
`;
    let result = await unfold(source, "scaffold");
    expect(result).toMatch(/with scaffoldSubdomain\(of: Sales\)/);
    result = await unfold(result, "scaffoldSubdomain");
    expect(result).toMatch(/with scaffoldContext\(of: S\)/);
    result = await unfold(result, "scaffoldContext");
    expect(result).toMatch(/with scaffoldAggregate\(of: Order\)/);
    result = await unfold(result, "scaffoldAggregate");
    // Final level: the three pages land as source.
    expect(result).toMatch(/page OrderList/);
    expect(result).toMatch(/page OrderNew/);
    expect(result).toMatch(/page OrderDetail/);
    // And the source re-parses cleanly:
    const reparse = await validate(result);
    expect(reparse.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it("unfolds `with softDeleteByDefault` one level into capability + child ops macros", async () => {
    // The composer emits a typed `implements softDeletable` on the context (which
    // fans the capability — state + filter — to every aggregate) and a child
    // `with softDelete` ops macro on each aggregate.  Unfold is one-level: those
    // calls appear rather than their fully-expanded contributions.
    const source = `
context Sales with softDeleteByDefault {
  aggregate Order {
    subject: string
  }
  aggregate Customer {
    name: string
  }
  repository Orders for Order { }
  repository Customers for Customer { }
}
`;
    const unfolded = await unfold(source, "softDeleteByDefault");
    expect(unfolded).not.toMatch(/with softDeleteByDefault/);
    // Typed capability application on the context:
    expect(unfolded).toMatch(/implements softDeletable/);
    // Child ops macro on each aggregate:
    expect(unfolded).toMatch(/aggregate Order with softDelete \{/);
    expect(unfolded).toMatch(/aggregate Customer with softDelete \{/);
    // NOT flattened — child contributions stay opaque at this level:
    expect(unfolded).not.toMatch(/operation softDelete/);
    expect(unfolded).not.toMatch(/isDeleted: bool/);
    // Re-parses cleanly (running the capability + macros gives the same IR):
    const reparse = await validate(unfolded);
    expect(reparse.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it("unfold one level can be applied recursively to reach raw source", async () => {
    // softDeleteByDefault → `implements softDeletable` (context) + `with
    // softDelete` (each aggregate); then unfold the aggregate's `softDelete` →
    // the operations materialize as source.
    const source = `
context Sales with softDeleteByDefault {
  aggregate Order {
    subject: string
  }
}
`;
    let result = await unfold(source, "softDeleteByDefault");
    expect(result).toMatch(/aggregate Order with softDelete/);
    result = await unfold(result, "softDelete");
    // After the second unfold, the operations materialize on the aggregate:
    expect(result).toMatch(/operation softDelete/);
    expect(result).toMatch(/operation restore/);
    // The capability application stays at the context:
    expect(result).toMatch(/implements softDeletable/);
  });

  it("does not offer unfold when cursor isn't on a macro call", async () => {
    const source = `
context Sales {
  aggregate Order {
    subject: string
  }
  repository Orders for Order { }
}
`;
    const result = await validate(source);
    const document = result.document;
    const pos = positionOf(source, "subject");
    const actions = (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
      textDocument: { uri: document.textDocument.uri },
      range: { start: pos, end: pos },
      context: { diagnostics: [] },
    })) as CodeAction[];
    expect(actions.find((a) => a.title.startsWith("Unfold macro"))).toBeUndefined();
  });
});
