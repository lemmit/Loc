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
  it("offers an `Unfold macro 'softDeletable'` refactor on the macro call", async () => {
    const source = `
context Sales {
  aggregate Order with softDeletable {
    subject: string
  }
  repository Orders for Order { }
}
`;
    const unfolded = await unfold(source, "softDeletable");
    // Macro call gone:
    expect(unfolded).not.toMatch(/with softDeletable/);
    // Fields + ops + implements present in the aggregate body:
    expect(unfolded).toMatch(/isDeleted: bool/);
    expect(unfolded).toMatch(/deletedAt: datetime\?/);
    expect(unfolded).toMatch(/operation softDelete/);
    expect(unfolded).toMatch(/operation restore/);
    expect(unfolded).toMatch(/implements "softDeletable"/);
  });

  it("re-parses to a working program after unfold", async () => {
    const source = `
context Sales {
  aggregate Order with softDeletable {
    subject: string
  }
  repository Orders for Order { }
}
`;
    const unfolded = await unfold(source, "softDeletable");
    const reparseResult = await validate(unfolded);
    const errors = reparseResult.diagnostics.filter((d) => d.severity === 1);
    expect(errors).toEqual([]);
  });

  it("unfolds `with auditable` into the four audit fields + implements", async () => {
    const source = `
context Sales {
  aggregate User { name: string }
  aggregate Order with auditable {
    subject: string
  }
  repository Orders for Order { }
  repository Users for User { }
}
`;
    const unfolded = await unfold(source, "auditable");
    expect(unfolded).not.toMatch(/with auditable/);
    expect(unfolded).toMatch(/createdAt: datetime/);
    expect(unfolded).toMatch(/updatedAt: datetime/);
    expect(unfolded).toMatch(/createdBy: User id/);
    expect(unfolded).toMatch(/updatedBy: User id/);
    expect(unfolded).toMatch(/implements "auditable"/);
  });

  it("unfolds context-level `with softDelete` into the capability filter", async () => {
    const source = `
context Sales with softDelete {
  aggregate Order {
    subject: string
    isDeleted: bool
    implements "softDeletable"
  }
  repository Orders for Order { }
}
`;
    const unfolded = await unfold(source, "softDelete");
    expect(unfolded).not.toMatch(/with softDelete/);
    expect(unfolded).toMatch(/filter for "softDeletable" !this\.isDeleted/);
  });

  it("unfolding one of two macros keeps the other in the with clause", async () => {
    const source = `
context Sales with audit, softDelete {
  aggregate User { name: string }
  aggregate Order {
    subject: string
    isDeleted: bool
    createdAt: datetime
    updatedAt: datetime
    createdBy: User id
    updatedBy: User id
    implements "softDeletable"
    implements "auditable"
  }
  repository Orders for Order { }
  repository Users for User { }
}
`;
    const unfolded = await unfold(source, "softDelete");
    // softDelete is gone, audit remains:
    expect(unfolded).toMatch(/with audit\s*\{/);
    expect(unfolded).not.toMatch(/with audit, softDelete/);
    expect(unfolded).not.toMatch(/with softDelete, audit/);
    expect(unfolded).toMatch(/filter for "softDeletable" !this\.isDeleted/);
  });

  it("threads ref-list args through unfold (scaffold with modules: [Sales])", async () => {
    // Regression: pre-fix, unfold ran the macro with empty `{}`
    // args, so `scaffold(modules: [Sales])` produced nothing.  After
    // the resolveMacroArgs wiring, the macro sees the resolved
    // Module and emits per-aggregate pages.
    const source = `
system Demo {
  module Sales {
    context S {
      aggregate Order {
        subject: string
      }
      repository Orders for Order { }
    }
  }
  ui Admin with scaffold(modules: [Sales]) { }
}
`;
    const unfolded = await unfold(source, "scaffold");
    // `with scaffold(...)` is gone:
    expect(unfolded).not.toMatch(/with scaffold/);
    // Per-aggregate pages were synthesised (proves args resolved).
    expect(unfolded).toMatch(/page OrderList/);
    expect(unfolded).toMatch(/page OrderDetail/);
  });

  it("unfolds `with softDeleteByDefault` one level into child `with` clauses", async () => {
    // Composer macros like `*ByDefault` use `invokeMacro` to fan
    // child macros across descendants.  Unfold is one-level: the
    // composer is replaced by the child macro calls themselves
    // (`with softDelete` on the context, `with softDeletable` on
    // each aggregate) rather than the children's fully-expanded
    // contributions.  The user can drill further by unfolding the
    // children too.
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
    // The composer call is gone:
    expect(unfolded).not.toMatch(/with softDeleteByDefault/);
    // Replaced by `with softDelete` on the context:
    expect(unfolded).toMatch(/context Sales with softDelete \{/);
    // And `with softDeletable` on each aggregate:
    expect(unfolded).toMatch(/aggregate Order with softDeletable \{/);
    expect(unfolded).toMatch(/aggregate Customer with softDeletable \{/);
    // NOT flattened — child contributions stay opaque at this level:
    expect(unfolded).not.toMatch(/filter for "softDeletable"/);
    expect(unfolded).not.toMatch(/implements "softDeletable"/);
    expect(unfolded).not.toMatch(/isDeleted: bool/);
    // Re-parses cleanly (running the macros gives the same end IR):
    const reparse = await validate(unfolded);
    expect(reparse.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it("unfold one level can be applied recursively to reach raw source", async () => {
    // The composer test above proves shallow unfold.  This proves
    // that the user can keep unfolding to drill all the way down:
    // first softDeleteByDefault → `with softDelete` + `with
    // softDeletable`, then unfold `softDelete` → the context filter
    // lands at context level (and one `with softDeletable` remains).
    const source = `
context Sales with softDeleteByDefault {
  aggregate Order {
    subject: string
  }
}
`;
    let result = await unfold(source, "softDeleteByDefault");
    expect(result).toMatch(/with softDelete/);
    result = await unfold(result, "softDelete");
    // After the second unfold, the filter materializes at the context:
    expect(result).toMatch(/filter for "softDeletable" !this\.isDeleted/);
    // And the aggregate still carries `with softDeletable` — the
    // user can keep going if they want the field/op breakdown.
    expect(result).toMatch(/aggregate Order with softDeletable/);
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
