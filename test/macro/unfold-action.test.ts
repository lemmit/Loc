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

async function unfold(
  source: string,
  macroNameInSource: string,
  titlePrefix = "Unfold macro",
): Promise<string> {
  const result = await validate(source);
  const document = result.document;
  const pos = positionOf(source, macroNameInSource);
  const actions = (await services.Ddd.lsp.CodeActionProvider!.getCodeActions(document, {
    textDocument: { uri: document.textDocument.uri },
    range: { start: pos, end: pos },
    context: { diagnostics: [] },
  })) as CodeAction[];
  const action = actions.find((a) => a.title.startsWith(titlePrefix));
  if (!action) {
    throw new Error(`no unfold action; got: ${actions.map((a) => a.title).join(", ")}`);
  }
  const edits = action.edit?.changes?.[document.textDocument.uri] ?? [];
  return applyEdits(source, edits);
}

describe("unfold code action", () => {
  // NOTE: `softDeletable`/`auditable`/`tenantOwned` are built-in capabilities
  // (not macros).  A `with <cap>` clause unfolds through the capability path
  // (`Unfold capability '<name>'` — see the dedicated describe below), which
  // splices the capability's member source; `softDelete` (the operations) is
  // still a macro and unfolds as `Unfold macro`.  Clause order is
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
    expect(result).toMatch(/page List/);
    expect(result).toMatch(/page New/);
    expect(result).toMatch(/page Detail/);
    // Regression: the page bodies are a deeply nested widget-call tree
    // (Stack/Toolbar/QueryView/Table/Column/...); a bare `printExpr` with no
    // wrapping used to collapse the whole tree onto one illegibly long line
    // (print-expr.ts had no line-wrapping, unlike print-structural.ts's
    // `block`/`indent`). It must come out multi-line and indented instead.
    const listBody = result.slice(result.indexOf("page List"), result.indexOf("page New"));
    expect(listBody.split("\n").length).toBeGreaterThan(5);
    expect(listBody).toMatch(/\n\s+Column\(/);
    for (const line of listBody.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
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

  it("unfolds `with tenantOwned` into the tenantId + dataKey fields + stamp + filter source", async () => {
    // Capability unfold (multi-tenancy Phase 1a slice 1a.2, the anti-magic
    // story): `with tenantOwned` materializes exactly what it attaches.
    const source = `
system D {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Org
  subdomain M {
    context Sales {
      aggregate Invoice with tenantOwned {
        number: string
      }
      aggregate Org { name: string }
      repository Invoices for Invoice { }
      repository Orgs for Org { }
    }
  }
}
`;
    const unfolded = await unfold(source, "tenantOwned", "Unfold capability");
    // The clause is gone; the members materialized as source:
    expect(unfolded).not.toMatch(/with tenantOwned/);
    expect(unfolded).toMatch(/tenantId: string internal/);
    expect(unfolded).toMatch(/dataKey: string\? internal/);
    expect(unfolded).toMatch(/stamp onCreate \{/);
    expect(unfolded).toMatch(/tenantId := currentUser\.tenantId/);
    expect(unfolded).toMatch(/dataKey := currentUser\.orgPath/);
    expect(unfolded).toMatch(/filter this\.tenantId == currentUser\.tenantId/);
    // And the unfolded source re-parses cleanly:
    const reparse = await validate(unfolded);
    expect(reparse.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it("unfolds `with softDeletable` (capability path) and keeps sibling macro calls", async () => {
    const source = `
context Sales {
  aggregate Order with softDelete, softDeletable {
    subject: string
  }
  repository Orders for Order { }
}
`;
    const unfolded = await unfold(source, "softDeletable", "Unfold capability");
    expect(unfolded).toMatch(/with softDelete \{/);
    expect(unfolded).not.toMatch(/softDeletable/);
    expect(unfolded).toMatch(/isDeleted: bool internal/);
    expect(unfolded).toMatch(/filter !this\.isDeleted/);
    const reparse = await validate(unfolded);
    expect(reparse.diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it("a user-declared capability wins over the built-in in capability unfold", async () => {
    // The declaration sits AFTER the usage so the marker search lands on the
    // `with` clause's MacroCall (positionOf finds the first occurrence).
    const source = `
context Sales {
  aggregate Order with tenantOwned {
    subject: string
  }
  repository Orders for Order { }
}
capability tenantOwned { archived: bool }
`;
    const unfolded = await unfold(source, "tenantOwned", "Unfold capability");
    expect(unfolded).toMatch(/archived: bool/);
    expect(unfolded).not.toMatch(/tenantId/);
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
