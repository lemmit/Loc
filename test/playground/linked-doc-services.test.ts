import { beforeEach, describe, expect, it } from "vitest";
import {
  buildLinkedDocument,
  linkedDocServicesCreated,
  resetLinkedDocServices,
} from "../../web/src/builder/system/linked-doc.js";

// `buildLinkedDocument` used to construct a brand-new Langium services graph on
// EVERY call — one per rename, per coverage-overlay pass, per wire-shape lookup,
// per expression-hint request.  That is a full DI container + parser + macro
// registration each time, and it is one of the main-thread allocation storms
// behind the playground's mobile OOM reports.
//
// Reuse is invisible in the output (same model either way), so these pin it via
// the instance counter + the returned `services` identity — and, crucially, that
// reuse did not cost correctness: a rebuilt document must reflect the NEW source
// (no stale document left behind), and two different URIs must not share one
// workspace (they would land in the same global scope, and `findReferences` on
// a rename target could then resolve against the other document's declaration).

const SRC_A = `system S {
  context C {
    aggregate Alpha {
      total: int
    }
  }
}`;

const SRC_B = `system S {
  context C {
    aggregate Beta {
      label: string
    }
  }
}`;

function aggregateNames(model: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.$type === "Aggregate" && typeof rec.name === "string") out.push(rec.name);
    for (const [k, v] of Object.entries(rec)) {
      if (k.startsWith("$")) continue;
      if (Array.isArray(v)) for (const item of v) walk(item);
      else walk(v);
    }
  };
  walk(model);
  return out;
}

describe("linked-doc — Langium services reuse", () => {
  beforeEach(() => {
    resetLinkedDocServices();
  });

  it("builds the services graph once for repeated calls on the same URI", async () => {
    const first = await buildLinkedDocument(SRC_A);
    const second = await buildLinkedDocument(SRC_B);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(linkedDocServicesCreated()).toBe(1);
    expect(second?.services).toBe(first?.services);
  });

  it("rebuilds cleanly — the second build sees the new source, not the stale document", async () => {
    const first = await buildLinkedDocument(SRC_A);
    expect(aggregateNames(first?.model)).toEqual(["Alpha"]);

    const second = await buildLinkedDocument(SRC_B);
    // Only the new aggregate: a leftover document (or a leftover index entry)
    // would show up as `Alpha` still being resolvable here.
    expect(aggregateNames(second?.model)).toEqual(["Beta"]);
    expect(second?.doc.parseResult.parserErrors).toHaveLength(0);
  });

  it("keeps a separate services instance (and workspace) per URI", async () => {
    const scratch = await buildLinkedDocument(SRC_A);
    const rename = await buildLinkedDocument(SRC_B, "memory:///loom-rename.ddd");

    expect(linkedDocServicesCreated()).toBe(2);
    expect(rename?.services).not.toBe(scratch?.services);
    // Each instance holds exactly one document — the isolation the old
    // throwaway-per-call code had.
    const docsOf = (s: typeof scratch): number =>
      s ? [...s.services.shared.workspace.LangiumDocuments.all].length : -1;
    expect(docsOf(scratch)).toBe(1);
    expect(docsOf(rename)).toBe(1);
  });
});
